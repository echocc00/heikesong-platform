// test/pools-migration.test.js —— P5 Task 1：迁移 006 + 工作流/三池仓储层
// 依据：INTERFACES.md §6（P5 产出）；设计文档 §5.4
// ⛔ 本 Task 的灵魂：「同一任务不能被两人同时领取」必须由**数据库**保证 ——
//    部分唯一索引 ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL。
//    ⛔ 不接受「应用层先查再插」作为并发保证 —— 下面「真并发」用例用两个
//    **独立连接 + 两个 worker 线程 + 屏障同步**同时插入，验证放行权在数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import * as workflowsRepo from '../src/db/repo/workflows.js';
import * as taskClaimsRepo from '../src/db/repo/task-claims.js';
import * as poolsRepo from '../src/db/repo/pools.js';
import * as poolSourcesRepo from '../src/db/repo/pool-sources.js';
import * as publicTokensRepo from '../src/db/repo/public-tokens.js';
import { hasActiveMembership, listMemberTeams } from '../src/db/repo/teamMembers.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5mig-'));
  const { db, close } = openDatabase({ dataDir });
  const result = applyMigrations(db, migrationsDir);
  return { db, close, dataDir, result };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

/**
 * 上游种子：P1 的 editions / task_packages / teams，P0 的 users。
 * ⚠️ task_packages.status = 'approved'、teams.status = 'active' 这两个取值
 *    若 P1 落地时用了不同的 CHECK 枚举，改这两处种子值即可（不涉及本阶段逻辑）。
 */
function seedBase(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_cap', '队长甲', '13900000011', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_other', '组员乙', '13900000012', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型',
      '能跑起来就行', 'A', 'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_cap',
      '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_cap', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_cap', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_1', 'u_other', 'member', '2026-10-01T00:00:00.000Z', NULL);
  `);
}

/**
 * 仓储层与派生源用的**多届期 / 多状态 / 含软删**种子。
 * ⚠️ 数据必须**判别性**：两个算法的结果不同时，用例才区分得开。
 *    例如 listEditionPackages 的 status 过滤，只有同时存在 approved 与 submitted
 *    两种包时，漏掉过滤条件才会被发现。
 */
function seedRepo(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000021', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_b', '乙', '13900000022', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_c', '丙', '13900000023', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_off', '停用丁', '13900000024', 'x', 'other', '学堂', 0, 0, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z'),
           ('ed_2', '第二届', '上海', '2027-10-01', '2027-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_ok', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑起来就行',
      'A', 'approved', 11, 'A', '试点承诺', '承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_wait', 'ed_1', 'ent_2', '某券商', '智能投顾', '风控缺失', '原型', '能跑', 'B', 'submitted',
      9, 'B', NULL, NULL, 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_free', 'ed_1', 'ent_3', NULL, '自由命题', '自主', '原型', '能跑', 'C', 'approved',
      8, 'C', NULL, NULL, 1, 'u_b', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_gone', 'ed_1', 'ent_4', '某已撤企业', '已撤题', 'x', 'x', 'x', NULL, 'approved',
      NULL, NULL, NULL, NULL, 0, 'u_a', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_ok', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_c', 'tp_wait', 'D', 'active', '2026-10-02T00:00:00.000Z', NULL),
           ('tm_gone', 'ed_1', '已撤队', 'u_a', 'tp_ok', 'D', 'active', '2026-10-03T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z'),
           ('tm_9', 'ed_2', '九队', 'u_b', 'tp_ok', 'B', 'active', '2026-10-05T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_1', 'u_b', 'member', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'u_c', 'captain', '2026-10-02T00:00:00.000Z', NULL),
           ('tm_9', 'u_a', 'member', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '决赛', 'final', '2026-10-11', '2026-10-20', NULL, 'final', 'computed'),
           ('st_9', 'ed_2', 's1', '调研二', 'initial', '2027-10-01', '2027-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90, 45, 45, 0, 10, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80, 40, 40, 0, 6, '2026-10-10T00:00:00.000Z'),
           ('sr_3', 'st_2', 'tm_1', 1, 95, 48, 47, 0, 12, '2026-10-20T00:00:00.000Z'),
           ('sr_9', 'st_9', 'tm_9', 1, 70, 35, 35, 0, 4, '2027-10-10T00:00:00.000Z');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z'),
           ('pl_2', 'ed_1', 'st_1', 'tm_1', 'u_b', 'stage_rank', 6, '2026-10-10T00:00:00.000Z'),
           ('pl_3', 'ed_1', 'st_2', 'tm_1', 'u_b', 'mvp', 4, '2026-10-20T00:00:00.000Z'),
           ('pl_9', 'ed_2', 'st_9', 'tm_9', 'u_a', 'stage_rank', 4, '2027-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 1, 0, '[]', '2026-10-10T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-10T00:00:00.000Z', NULL),
           ('tr_9', 'tm_9', 'B', 2, 1, '[]', '2027-10-10T00:00:00.000Z', NULL);
    INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json, raw_score, level, created_at, deleted_at)
    VALUES ('rg_1', 'ed_1', 'u_a', '{}', '{"a":1}', 3.5, 'L2', '2026-10-01T00:00:00.000Z', NULL),
           ('rg_9', 'ed_2', 'u_b', '{}', '{"a":2}', 4.0, 'L3', '2026-10-01T00:00:00.000Z', NULL);
  `);
}

test('迁移到 007：七张表全部建出', () => {
  const { db, close, dataDir, result } = setup();
  // ⚠️ **版本 10 是本轮新增的**（2026-10-26 M0-2「申诉范围」的 `010_appeal_reason_kind.sql`：appeals 加 reason_kind 列）。
  //    版本 9 是 2026-10-26 M0-1「完赛线可达性」的
  //    `009_behavior_event_subject.sql`：behavior_events 加 subject_id 列）。
  //    版本 8 是 2026-10-25 评审 P1-3a「会话滑动续期改脏才写」的
  //    `008_session_touch.sql`：sessions 表加 last_touch_at 列。
  //    版本 7 是 2026-10-23 审计 F23 / F25 的约束补强迁移
  //    （`007_p13_defect_fixes.sql`：幂等键加请求体摘要列 + 签字的部分唯一索引）。
  assert.equal(
    result.version, 10,
    '迁移版本必须是 10（P0=1, P1=2, P2=3, P3=4, P4=5, P5=6, P13=7, P13b=8, M0-1=9, M0-2=10）',
  );
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['workflows', 'workflow_tasks', 'task_claims', 'pool_projects', 'pool_talents', 'pool_resources', 'public_tokens']) {
    assert.ok(names.includes(t), `缺表 ${t}`);
  }
  cleanup(db, close, dataDir);
});

test('task_claims 的部分唯一索引挡住重复有效领取（并发的最后一道防线）', () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  db.prepare('INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?,?,?,?,?)')
    .run('wf_1', 'ed_1', 'tp_1', '风控助手工作流', '2026-10-02T00:00:00.000Z');
  db.prepare('INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('tk_1', 'wf_1', '跑通风控模型', '需要一个可演示的 demo', 'tm_1', 'todo', null, '2026-10-02T00:00:00.000Z');

  const ins = db.prepare(
    'INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES (?,?,?,?,?,NULL)',
  );
  ins.run('tc_1', 'tk_1', 'tm_1', 'u_cap', '2026-10-03T00:00:00.000Z');

  // ⛔ 绕过应用层"先查再插"，直接插第二条 → 数据库必须拒绝
  assert.throws(
    () => ins.run('tc_2', 'tk_1', 'tm_1', 'u_other', '2026-10-03T00:00:01.000Z'),
    /UNIQUE constraint failed/,
    '同一 task_id 不能有两个有效领取',
  );

  // 释放后旧行退出索引 → 可以再领
  db.prepare('UPDATE task_claims SET released_at = ? WHERE id = ?').run('2026-10-03T01:00:00.000Z', 'tc_1');
  ins.run('tc_3', 'tk_1', 'tm_1', 'u_other', '2026-10-03T02:00:00.000Z');

  const n = db
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get('tk_1').n;
  assert.equal(n, 1, '有效领取永远只有一条');
  cleanup(db, close, dataDir);
});

test('workflow_tasks 的 status 只允许四种取值', () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  db.prepare('INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?,?,?,?,?)')
    .run('wf_1', 'ed_1', 'tp_1', '风控助手工作流', '2026-10-02T00:00:00.000Z');
  const ins = db.prepare(
    'INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  ins.run('tk_1', 'wf_1', '任务一', null, 'tm_1', 'todo', null, '2026-10-02T00:00:00.000Z');
  ins.run('tk_2', 'wf_1', '任务二', null, 'tm_1', 'in_progress', null, '2026-10-02T00:00:00.000Z');
  ins.run('tk_3', 'wf_1', '任务三', null, 'tm_1', 'done', null, '2026-10-02T00:00:00.000Z');
  ins.run('tk_4', 'wf_1', '任务四', null, 'tm_1', 'blocked', null, '2026-10-02T00:00:00.000Z');
  assert.throws(
    () => ins.run('tk_5', 'wf_1', '任务五', null, 'tm_1', 'assigned_to_dev', null, '2026-10-02T00:00:00.000Z'),
    /CHECK constraint failed|constraint/i,
    '非法状态必须被数据库拒绝',
  );
  cleanup(db, close, dataDir);
});

test('三池表的自然键唯一约束生效', () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  const insProject = db.prepare(
    `INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insProject.run('pp_1', 'ed_1', 'tm_1', '零售风控助手', null, 'S3', 'C', 1, '摘要', '2026-10-05T00:00:00.000Z');
  assert.throws(
    () => insProject.run('pp_2', 'ed_1', 'tm_1', '重复队', null, null, null, null, null, '2026-10-05T00:00:00.000Z'),
    /UNIQUE constraint failed/,
    '同一届同一队只能有一条项目池记录',
  );

  const insTalent = db.prepare(
    `INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insTalent.run('pt_1', 'u_cap', 'ed_1', '队长甲', '学堂', 18, 'mba', 3, '[]', '2026-10-05T00:00:00.000Z');
  assert.throws(
    () => insTalent.run('pt_2', 'u_cap', 'ed_1', '队长甲', '学堂', 20, 'mba', 3, '[]', '2026-10-05T00:00:00.000Z'),
    /UNIQUE constraint failed/,
    '同一届同一人只能有一条人才池记录',
  );

  const insResource = db.prepare(
    `INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  insResource.run('pr_1', 'ed_1', 'ent_1', '某银行', 'enterprise_brief', '零售风控助手', '2026-10-05T00:00:00.000Z');
  assert.throws(
    () => insResource.run('pr_2', 'ed_1', 'ent_1', '某银行', 'enterprise_brief', '重复', '2026-10-05T00:00:00.000Z'),
    /UNIQUE constraint failed/,
    '同一届同一企业的同一类资源只能有一条',
  );
  cleanup(db, close, dataDir);
});

test('public_tokens 表可存可查，且 token 是主键', () => {
  const { db, close, dataDir } = setup();
  db.prepare('INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run('hash_abc', 'leaderboard', 'ed_1', '2026-11-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
  const row = db.prepare('SELECT * FROM public_tokens WHERE token = ?').get('hash_abc');
  assert.equal(row.scope, 'leaderboard');
  assert.equal(row.edition_id, 'ed_1');
  assert.throws(
    () => db.prepare('INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (?,?,?,?,?)')
      .run('hash_abc', 'calendar', 'ed_1', '2026-11-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
    /UNIQUE constraint failed/,
  );
  cleanup(db, close, dataDir);
});

/**
 * ★ 真并发用例（本 Task 灵魂的正面验证）。
 *
 * 为什么不能只串行跑一次：串行跑两次 insert，第一次提交后第二次必然撞唯一索引 ——
 * 这证明不了「并发下数据库会仲裁」，只证明「索引存在」。
 * 本用例用**两个 worker 线程 + 两条独立数据库连接 + 屏障同步**，
 * 让两次 INSERT **真正同时**发起（用插入起止时间区间是否重叠来证明确实重叠），
 * 然后断言：**恰好一条成功，另一条被数据库以 UNIQUE 约束拒绝**，
 * 且库里的有效领取永远只有一条。
 *
 * ⚠️ 屏障必须**两个 worker 都到达**才放行：worker 在连上库之后、
 *    真正发起 INSERT 之前才递增屏障计数 —— 因此「同时」的是 INSERT 本身，
 *    不是连接建立。
 * ⚠️ 两个连接必须**错开建立**：这是本 Task 落地时（2026-10-21）的**临时变通** ——
 *    当时 openDatabase() 的第一条语句是 PRAGMA journal_mode = WAL，而 busy_timeout 在它之后才设，
 *    两个连接同时执行这条 PRAGMA 会有一方立刻 "database is locked"（实测，见缺陷台账 **C-3**）。
 *    ⚠️ **该缺陷已在上游修掉**（main `a6fd2db`：切 WAL 改成带退避重试，不再裸执行该 PRAGMA），
 *    所以这个「错开建立」**已不再必要** —— 保留它只是为了让本用例专注于「并发领取」的仲裁语义。
 */
const CLAIM_WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from ${JSON.stringify(pathToFileURL(join(here, '..', 'src', 'db', 'sqlite.js')).href)};

const { db, close } = openDatabase({ dataDir: workerData.dataDir });
const ins = db.prepare(
  'INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)',
);

/**
 * 共享屏障（Int32Array，三个槽位）：
 *   [0] 已建立连接的 worker 数
 *   [1] holder 已持有写锁并完成 INSERT
 *   [2] waiter 已准备发起 INSERT（此刻它必然阻塞在写锁上）
 */
const barrier = new Int32Array(workerData.barrier);

/** 等某个槽位变成 want；超时返回 false（用于把「卡住」变成可诊断的失败而不是挂死）。 */
function waitUntil(idx, want, timeoutMs) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
  for (;;) {
    if (Atomics.load(barrier, idx) === want) return true;
    if (process.hrtime.bigint() > deadline) return false;
    Atomics.wait(barrier, idx, Atomics.load(barrier, idx), 5);
  }
}

parentPort.postMessage({ ready: true });
Atomics.add(barrier, 0, 1);
if (!waitUntil(0, 2, 10000)) {
  parentPort.postMessage({ ok: false, message: '屏障超时：两个连接未能在 10s 内就绪', t0: 0, t1: 0 });
  close();
} else {
  let outcome;
  const t0 = Number(process.hrtime.bigint());
  try {
    if (workerData.role === 'holder') {
      // holder：取写锁 → 插入 → 告诉 waiter「我持锁了」→ 等 waiter 准备发起 INSERT → 才提交
      db.exec('BEGIN IMMEDIATE');
      try {
        ins.run(workerData.claimId, workerData.taskId, workerData.teamId, workerData.userId, workerData.claimedAt);
        Atomics.store(barrier, 1, 1);
        waitUntil(2, 1, 10000);
        db.exec('COMMIT');
        outcome = { ok: true };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
        outcome = { ok: false, message: String(err && err.message) };
      }
    } else {
      // waiter：等 holder 持锁 → 宣告「我要发起了」（下一个语句必然阻塞在写锁上）→ 发起 INSERT
      waitUntil(1, 1, 10000);
      Atomics.store(barrier, 2, 1);
      ins.run(workerData.claimId, workerData.taskId, workerData.teamId, workerData.userId, workerData.claimedAt);
      outcome = { ok: true };
    }
  } catch (err) {
    outcome = { ok: false, message: String(err && err.message) };
  }
  const t1 = Number(process.hrtime.bigint());
  close();
  parentPort.postMessage({ ...outcome, t0, t1 });
}
`;

function spawnClaimWorker(workerData) {
  const worker = new Worker(CLAIM_WORKER_SRC, { eval: true, workerData });
  let resolveReady;
  let resolveDone;
  const ready = new Promise((r) => { resolveReady = r; });
  const done = new Promise((r) => { resolveDone = r; });
  worker.on('message', (m) => { if (m.ready) resolveReady(); else resolveDone(m); });
  worker.on('error', (err) => { resolveReady(); resolveDone({ ok: false, message: String(err && err.message) }); });
  return { ready, done };
}

test('真并发：两个连接同时领取同一任务，数据库只放行一个（放行权在数据库，不在应用层）', async () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  db.prepare('INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?,?,?,?,?)')
    .run('wf_1', 'ed_1', 'tp_1', '风控助手工作流', '2026-10-02T00:00:00.000Z');
  db.prepare('INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('tk_1', 'wf_1', '跑通风控模型', '需要一个可演示的 demo', 'tm_1', 'todo', null, '2026-10-02T00:00:00.000Z');
  // 先把主连接关掉：下面的并发由 worker 自己持有的两条连接完成
  close();

  // 三个 Int32 槽位：[0] 已连接数 / [1] holder 持锁 / [2] waiter 准备发起 INSERT
  const barrier = new SharedArrayBuffer(12);
  const base = { dataDir, barrier, taskId: 'tk_1', teamId: 'tm_1', claimedAt: '2026-10-03T00:00:00.000Z' };
  const a = spawnClaimWorker({ ...base, role: 'holder', claimId: 'tc_a', userId: 'u_cap' });
  await a.ready;                       // 连接 A 已建立
  const b = spawnClaimWorker({ ...base, role: 'waiter', claimId: 'tc_b', userId: 'u_other' });
  await b.ready;                       // 连接 B 已建立（错开建立，避开 WAL PRAGMA 抢锁）
  const [ra, rb] = await Promise.all([a.done, b.done]);

  const winners = [ra, rb].filter((r) => r.ok);
  const losers = [ra, rb].filter((r) => !r.ok);
  assert.equal(winners.length, 1, `恰好一条领取成功，实际 ${JSON.stringify([ra, rb])}`);
  assert.equal(losers.length, 1, `恰好一条被拒，实际 ${JSON.stringify([ra, rb])}`);
  assert.match(losers[0].message, /UNIQUE constraint failed/, '被拒的一方必须由数据库的唯一索引拒绝');

  // 证明这**确实是并发**而不是被测试串行化：两次 INSERT 的时间区间必须**真正重叠**。
  //
  // ⚠️⚠️ 谓词**不能**写成 `min(t0) < max(t1)`：
  //   ① 那个写法在「A 完全在 B 之前」（串行）时也成立 ⇒ 会把**根本不是并发**的两次 INSERT 放过；
  //   ② 而时间戳若截断到**毫秒**，两次 INSERT 全程落在同一毫秒时会得到 `min == max`
  //      ⇒ 把**真并发**判成不并发（本机实测约 20% 概率偶发失败，见台账 PC-1）。
  //  ⇒ 正确写法：时间戳保留**纳秒**（process.hrtime.bigint() 是 CLOCK_MONOTONIC，
  //    同一进程内的多个 worker 线程**基点相同** ⇒ 可直接跨线程比较），
  //    谓词用**区间真实重叠** `a0 < b1 && b0 < a1`。
  //
  // ⚠️ 仅有高精度时间戳**还不够**：两个 worker 从屏障放行到真正跑起来之间有**唤醒延迟**
  //    （实测可达数毫秒）⇒ 两次 INSERT 可能**整体错开**、根本不重叠。
  //    ⇒ 上面 worker 用**共享标志位**把顺序**结构化**：
  //      holder 取写锁并插入 → 置标志 [1] → 等标志 [2] → 才提交；
  //      waiter 等标志 [1] → 置标志 [2] → 才发起 INSERT（此刻必然阻塞在 holder 的写锁上）。
  //    于是必然有 holder.t0 < waiter.t0 < holder.t1 且 waiter.t1 > holder.t1 ⇒ **重叠恒成立**。
  const overlap = ra.t0 < rb.t1 && rb.t0 < ra.t1;
  assert.ok(
    overlap,
    `两次 INSERT 的区间必须重叠才叫并发，实际 [${ra.t0},${ra.t1}] 与 [${rb.t0},${rb.t1}]`,
  );

  // 库里的有效领取永远只有一条
  const { db: db2, close: close2 } = openDatabase({ dataDir });
  const n = db2
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get('tk_1').n;
  assert.equal(n, 1, '有效领取永远只有一条');
  close2();
  rmSync(dataDir, { recursive: true, force: true });
});

test('workflows / workflow_tasks 仓储：建档、读档、改状态、完成留痕', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  const wf = workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_ok', name: '风控助手工作流', now: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(wf.id !== undefined, true);
  assert.equal(wf.edition_id, 'ed_1');
  assert.equal(wf.task_package_id, 'tp_ok');
  assert.equal(wf.name, '风控助手工作流');
  assert.equal(workflowsRepo.getWorkflow(db, wf.id).name, '风控助手工作流');
  assert.equal(workflowsRepo.getWorkflow(db, 'wf_none'), null, '不存在的 id 必须返回 null 而不是 undefined');

  const wf2 = workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_wait', name: '投顾工作流', now: '2026-10-03T00:00:00.000Z',
  });
  // 同一个任务包的**第二个**工作流（created_at 更晚）—— 用来判别 findWorkflowByPackage
  // 取的是「最早的那个」：只有一个工作流时排序不可判别。
  workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_ok', name: '风控助手工作流二', now: '2026-10-06T00:00:00.000Z',
  });
  workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_2', taskPackageId: 'tp_ok', name: '第二届工作流', now: '2026-10-01T00:00:00.000Z',
  });
  const listed = workflowsRepo.listWorkflowsByEdition(db, 'ed_1');
  assert.deepEqual(
    listed.map((r) => r.name),
    ['风控助手工作流', '投顾工作流', '风控助手工作流二'],
    '必须只返回本届且按 created_at 升序',
  );
  assert.equal(workflowsRepo.findWorkflowByPackage(db, 'ed_1', 'tp_ok').id, wf.id, '同一任务包取最早建立的工作流');
  assert.equal(workflowsRepo.findWorkflowByPackage(db, 'ed_1', 'tp_free'), null, '找不到时返回 null');

  // 任务默认值：detail / owner_team_id / due_at 为 NULL，status 为 'todo'
  const task = workflowsRepo.insertWorkflowTask(db, {
    workflowId: wf.id, title: '跑通风控模型', now: '2026-10-04T00:00:00.000Z',
  });
  assert.equal(task.status, 'todo');
  assert.equal(task.detail, null);
  assert.equal(task.owner_team_id, null);
  assert.equal(task.due_at, null);
  assert.equal(task.evidence_json, null);
  assert.equal(task.completed_at, null);
  assert.equal(task.completed_by, null);

  workflowsRepo.insertWorkflowTask(db, {
    workflowId: wf.id, title: '任务二', detail: '细节', ownerTeamId: 'tm_1', status: 'in_progress',
    dueAt: '2026-10-20', now: '2026-10-05T00:00:00.000Z',
  });
  workflowsRepo.insertWorkflowTask(db, {
    workflowId: wf2.id, title: '另一工作流的任务', now: '2026-10-04T00:00:00.000Z',
  });
  const tasks = workflowsRepo.listWorkflowTasksByWorkflow(db, wf.id);
  assert.deepEqual(tasks.map((r) => r.title), ['跑通风控模型', '任务二'], '只返回本工作流的任务且按 created_at 升序');
  assert.equal(workflowsRepo.getWorkflowTask(db, task.id).title, '跑通风控模型');

  assert.equal(workflowsRepo.updateWorkflowTaskStatus(db, task.id, 'in_progress'), 1);
  assert.equal(workflowsRepo.getWorkflowTask(db, task.id).status, 'in_progress');
  assert.equal(workflowsRepo.updateWorkflowTaskStatus(db, 'tk_none', 'done'), 0, '改不存在的任务返回 0');

  // 完成留痕：状态 + 证据 + 完成时间 + 完成人
  assert.equal(workflowsRepo.completeWorkflowTask(db, task.id, {
    status: 'done', evidenceJson: '{"repo":"https://example.com/x","version":"v1"}',
    completedAt: '2026-10-06T00:00:00.000Z', completedBy: 'u_a',
  }), 1);
  const done = workflowsRepo.getWorkflowTask(db, task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.evidence_json, '{"repo":"https://example.com/x","version":"v1"}');
  assert.equal(done.completed_at, '2026-10-06T00:00:00.000Z');
  assert.equal(done.completed_by, 'u_a');
  cleanup(db, close, dataDir);
});

test('task-claims 仓储：有效领取、释放后退出索引、可再领、重复领取被数据库拒绝', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);
  workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_ok', name: '风控助手工作流', now: '2026-10-02T00:00:00.000Z',
  });
  const task = workflowsRepo.insertWorkflowTask(db, {
    workflowId: db.prepare('SELECT id FROM workflows LIMIT 1').get().id,
    title: '跑通风控模型', now: '2026-10-04T00:00:00.000Z',
  });
  const task2 = workflowsRepo.insertWorkflowTask(db, {
    workflowId: db.prepare('SELECT id FROM workflows LIMIT 1').get().id,
    title: '第二个任务', now: '2026-10-04T01:00:00.000Z',
  });

  const claim = taskClaimsRepo.insertTaskClaim(db, {
    taskId: task.id, teamId: 'tm_1', userId: 'u_a', now: '2026-10-03T00:00:00.000Z',
  });
  assert.equal(claim.task_id, task.id);
  assert.equal(claim.user_id, 'u_a');
  assert.equal(claim.released_at, null);
  assert.equal(taskClaimsRepo.getActiveClaim(db, task.id).id, claim.id);
  assert.equal(taskClaimsRepo.countActiveClaims(db, task.id), 1);

  // 已被占用时再领 → 数据库拒绝（不是应用层判断）
  assert.throws(
    () => taskClaimsRepo.insertTaskClaim(db, {
      taskId: task.id, teamId: 'tm_1', userId: 'u_b', now: '2026-10-03T00:00:01.000Z',
    }),
    /UNIQUE constraint failed/,
  );

  // 释放：第一次改 1 行，第二次（已释放）改 0 行
  assert.equal(taskClaimsRepo.releaseTaskClaim(db, claim.id, '2026-10-03T01:00:00.000Z'), 1);
  assert.equal(taskClaimsRepo.releaseTaskClaim(db, claim.id, '2026-10-03T02:00:00.000Z'), 0, '已释放的不能再改');
  assert.equal(taskClaimsRepo.getActiveClaim(db, task.id), null, '释放后没有有效领取');
  assert.equal(taskClaimsRepo.countActiveClaims(db, task.id), 0);

  // 释放后可以再领
  const again = taskClaimsRepo.insertTaskClaim(db, {
    taskId: task.id, teamId: 'tm_1', userId: 'u_b', now: '2026-10-03T03:00:00.000Z',
  });
  assert.equal(again.user_id, 'u_b');
  assert.equal(taskClaimsRepo.countActiveClaims(db, task.id), 1);

  // u_a 的第二笔领取 —— 用来判别 listClaimsByUser 的排序（只有一笔时排序不可判别）
  const claim2 = taskClaimsRepo.insertTaskClaim(db, {
    taskId: task2.id, teamId: 'tm_1', userId: 'u_a', now: '2026-10-03T04:00:00.000Z',
  });

  const byUser = taskClaimsRepo.listClaimsByUser(db, 'u_a');
  assert.deepEqual(byUser.map((r) => r.id), [claim.id, claim2.id], '按 claimed_at 升序列出该人的全部领取（含已释放的）');
  assert.equal(taskClaimsRepo.listClaimsByUser(db, 'u_nobody').length, 0);
  cleanup(db, close, dataDir);
});

test('teamMembers 追加的两个函数：只认「这个人是不是这支队的在队成员」', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  assert.equal(hasActiveMembership(db, 'tm_1', 'u_a'), true, 'u_a 是 tm_1 的在队队长');
  assert.equal(hasActiveMembership(db, 'tm_1', 'u_b'), true, 'u_b 是 tm_1 的在队成员');
  assert.equal(hasActiveMembership(db, 'tm_1', 'u_c'), false, 'u_c 不是 tm_1 的成员');
  assert.equal(hasActiveMembership(db, 'tm_9', 'u_a'), false, 'u_a 已从 tm_9 离队（left_at 非空）');

  const teams = listMemberTeams(db, 'u_a');
  assert.deepEqual(teams.map((r) => r.id), ['tm_1'], '已离队的 tm_9 不算在队');
  assert.deepEqual(listMemberTeams(db, 'u_a', { editionId: 'ed_1' }).map((r) => r.id), ['tm_1']);
  assert.deepEqual(listMemberTeams(db, 'u_a', { editionId: 'ed_2' }).map((r) => r.id), [], 'tm_9 已离队，不算 ed_2 的在队队');
  assert.deepEqual(listMemberTeams(db, 'u_c').map((r) => r.id), ['tm_2']);
  cleanup(db, close, dataDir);
});

test('三池仓储：写、覆盖、删、按届期读，且人才池按积分倒序', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  // 项目池
  const ppId = poolsRepo.insertPoolProject(db, {
    editionId: 'ed_1', teamId: 'tm_1', title: '零售风控助手', stageReached: 'S3', tier: 'C',
    businessValue: 1, summary: '摘要', now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolProject(db, {
    editionId: 'ed_1', teamId: 'tm_2', title: '智能投顾', now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolProject(db, {
    editionId: 'ed_2', teamId: 'tm_9', title: '第二届项目', now: '2026-10-05T00:00:00.000Z',
  });
  assert.equal(poolsRepo.listPoolProjectRows(db, 'ed_1').length, 2, '按届期过滤');
  assert.equal(poolsRepo.listPoolProjectRows(db).length, 3, '不传届期返回全部');
  assert.deepEqual(poolsRepo.listPoolProjectRows(db, 'ed_1').map((r) => r.team_id), ['tm_1', 'tm_2']);
  assert.equal(poolsRepo.updatePoolProject(db, ppId, {
    title: '零售风控助手 v2', industry: '金融', stageReached: 'S4', tier: 'B', businessValue: 2, summary: '新摘要',
  }), 1);
  const pp = poolsRepo.listPoolProjectRows(db, 'ed_1')[0];
  assert.equal(pp.title, '零售风控助手 v2');
  assert.equal(pp.industry, '金融');
  assert.equal(pp.stage_reached, 'S4');
  assert.equal(pp.tier, 'B');
  assert.equal(pp.business_value, 2);
  assert.equal(pp.summary, '新摘要');
  assert.equal(poolsRepo.deletePoolProject(db, ppId), 1);
  assert.equal(poolsRepo.deletePoolProject(db, ppId), 0, '删不存在的返回 0');
  assert.equal(poolsRepo.listPoolProjectRows(db, 'ed_1').length, 1);

  // 人才池（积分顺序与 user_id 顺序**故意相反** → 排序可判别）
  poolsRepo.insertPoolTalent(db, {
    editionId: 'ed_1', userId: 'u_a', name: '甲', org: '学堂', totalPoints: 5, mbaStatus: 'mba',
    stagesJoined: 3, now: '2026-10-05T00:00:00.000Z',
  });
  const ptId = poolsRepo.insertPoolTalent(db, {
    editionId: 'ed_1', userId: 'u_b', name: '乙', org: '学堂', totalPoints: 18, now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolTalent(db, {
    editionId: 'ed_2', userId: 'u_c', name: '丙', totalPoints: 99, now: '2026-10-05T00:00:00.000Z',
  });
  const talents = poolsRepo.listPoolTalentRows(db, 'ed_1');
  assert.deepEqual(talents.map((r) => r.user_id), ['u_b', 'u_a'], '人才池按 total_points 倒序（不是按 user_id）');
  // 不传届期：先按 edition_id 分组，组内再按 total_points 倒序
  assert.deepEqual(poolsRepo.listPoolTalentRows(db).map((r) => r.user_id), ['u_b', 'u_a', 'u_c']);
  assert.equal(poolsRepo.updatePoolTalent(db, ptId, {
    name: '乙改', org: '新学堂', totalPoints: 7, mbaStatus: 'member', stagesJoined: 2, skillsJson: '["风控"]',
  }), 1);
  const pt = poolsRepo.listPoolTalentRows(db, 'ed_1').find((r) => r.id === ptId);
  assert.equal(pt.name, '乙改');
  assert.equal(pt.org, '新学堂');
  assert.equal(pt.total_points, 7);
  assert.equal(pt.mba_status, 'member');
  assert.equal(pt.stages_joined, 2);
  assert.equal(pt.skills_json, '["风控"]');
  assert.equal(poolsRepo.deletePoolTalent(db, ptId), 1);
  assert.equal(poolsRepo.listPoolTalentRows(db, 'ed_1').length, 1);

  // 资源池
  const prId = poolsRepo.insertPoolResource(db, {
    editionId: 'ed_1', enterpriseId: 'ent_1', enterpriseName: '某银行', kind: 'enterprise_brief',
    detail: '零售风控助手', now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolResource(db, {
    editionId: 'ed_1', enterpriseId: 'ent_2', enterpriseName: '某券商', kind: 'free_brief',
    now: '2026-10-05T00:00:00.000Z',
  });
  assert.equal(poolsRepo.listPoolResourceRows(db, 'ed_1').length, 2);
  assert.deepEqual(poolsRepo.listPoolResourceRows(db, 'ed_1').map((r) => r.enterprise_id), ['ent_1', 'ent_2']);
  assert.equal(poolsRepo.updatePoolResource(db, prId, {
    enterpriseName: '某银行科技部', kind: 'enterprise_brief', detail: '新详情',
  }), 1);
  const pr = poolsRepo.listPoolResourceRows(db, 'ed_1')[0];
  assert.equal(pr.enterprise_name, '某银行科技部');
  assert.equal(pr.detail, '新详情');
  assert.equal(poolsRepo.deletePoolResource(db, prId), 1);
  assert.equal(poolsRepo.listPoolResourceRows(db, 'ed_1').length, 1);
  cleanup(db, close, dataDir);
});

test('pool-sources 只读派生源：按届期过滤、软删过滤、status 过滤、跨届期积分', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  assert.equal(poolSourcesRepo.getEdition(db, 'ed_1').name, '第一届');
  assert.equal(poolSourcesRepo.getEdition(db, 'ed_none'), null);

  // 软删的队不算
  assert.deepEqual(poolSourcesRepo.listEditionTeams(db, 'ed_1').map((r) => r.id), ['tm_1', 'tm_2']);

  // 软删的题不算；status 过滤要真的起作用（种子同时有 approved 与 submitted）
  const allPkgs = poolSourcesRepo.listEditionPackages(db, 'ed_1');
  assert.deepEqual(allPkgs.map((r) => r.id), ['tp_free', 'tp_ok', 'tp_wait'], '软删的 tp_gone 被过滤');
  const approved = poolSourcesRepo.listEditionPackages(db, 'ed_1', { statuses: ['approved'] });
  assert.deepEqual(approved.map((r) => r.id), ['tp_free', 'tp_ok'], '只留 approved');
  const two = poolSourcesRepo.listEditionPackages(db, 'ed_1', { statuses: ['approved', 'submitted'] });
  assert.deepEqual(two.map((r) => r.id), ['tp_free', 'tp_ok', 'tp_wait']);

  // stages."key" 是带引号的标识符 → 必须映射成 stage_key
  const stages = poolSourcesRepo.listEditionStages(db, 'ed_1');
  assert.deepEqual(stages.map((r) => r.stage_key), ['s1', 's2']);
  assert.equal(stages[0].stage_key, 's1');

  // stage_results 通过 stages 关联到届期：ed_2 的结果不混进来
  const results = poolSourcesRepo.listEditionStageResults(db, 'ed_1');
  assert.deepEqual(results.map((r) => r.team_id), ['tm_1', 'tm_2', 'tm_1']);
  const withTeams = poolSourcesRepo.listStageResultsWithTeams(db, 'st_1');
  assert.deepEqual(withTeams.map((r) => r.team_name), ['一队', '二队']);

  // tier_records 没有 edition_id → 通过 teams 关联
  assert.deepEqual(poolSourcesRepo.listEditionTierRecords(db, 'ed_1').map((r) => r.team_id), ['tm_1', 'tm_2']);

  // 积分流水按届期；个人积分跨届期累加（R-RNK-10）
  assert.equal(poolSourcesRepo.listEditionLedger(db, 'ed_1').length, 3);
  assert.equal(poolSourcesRepo.listUserLedger(db, 'u_a').length, 2, 'u_a 的积分跨两届');
  assert.deepEqual(poolSourcesRepo.listUserLedger(db, 'u_a').map((r) => r.edition_id), ['ed_1', 'ed_2']);

  // 本届有积分流水的人 / 全部在册用户
  assert.deepEqual(poolSourcesRepo.listEditionUsers(db, 'ed_1').map((r) => r.id), ['u_a', 'u_b']);
  assert.deepEqual(poolSourcesRepo.listAllUsers(db).map((r) => r.id), ['u_a', 'u_b', 'u_c'], '停用用户不算在册');

  // 报名
  assert.deepEqual(poolSourcesRepo.listEditionRegistrations(db, 'ed_1').map((r) => r.id), ['rg_1']);
  cleanup(db, close, dataDir);
});

test('public-tokens 仓储：签发、查、吊销、按届期列', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  const issued = publicTokensRepo.insertPublicToken(db, {
    token: 'hash_a', scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2026-11-01T00:00:00.000Z',
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.deepEqual(issued, {
    token: 'hash_a', scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2026-11-01T00:00:00.000Z',
  });
  publicTokensRepo.insertPublicToken(db, {
    token: 'hash_b', scope: 'calendar', editionId: 'ed_2', expiresAt: '2026-11-01T00:00:00.000Z',
    now: '2026-10-21T00:00:00.000Z',
  });

  const found = publicTokensRepo.findPublicToken(db, 'hash_a');
  assert.equal(found.scope, 'leaderboard');
  assert.equal(found.edition_id, 'ed_1');
  assert.equal(found.created_at, '2026-10-20T00:00:00.000Z');
  assert.equal(publicTokensRepo.findPublicToken(db, 'hash_none'), null);

  assert.deepEqual(publicTokensRepo.listPublicTokens(db).map((r) => r.token), ['hash_a', 'hash_b']);
  assert.deepEqual(publicTokensRepo.listPublicTokens(db, { editionId: 'ed_1' }).map((r) => r.token), ['hash_a']);

  assert.equal(publicTokensRepo.deletePublicToken(db, 'hash_a'), 1);
  assert.equal(publicTokensRepo.deletePublicToken(db, 'hash_a'), 0, '删不存在的返回 0');
  assert.equal(publicTokensRepo.findPublicToken(db, 'hash_a'), null);
  cleanup(db, close, dataDir);
});

test('必填列与外键真的由数据库挡住（不是应用层自觉）', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  // 先造出**真实存在**的父行：否则「NOT NULL 用例」会先撞外键，
  // 报错信息就不是 NOT NULL，断言就测错了东西。
  db.prepare("INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('wf','ed_1','tp_ok','风控助手工作流','2026-10-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('tk','wf','跑通风控模型',NULL,'tm_1','todo',NULL,'2026-10-02T00:00:00.000Z')").run();

  const NOT_NULL_CASES = [
    ['workflows.name', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x1','ed_1','tp_ok',NULL,'t')"],
    ['workflows.edition_id', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x2',NULL,'tp_ok','n','t')"],
    ['workflows.task_package_id', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x3','ed_1',NULL,'n','t')"],
    ['workflows.created_at', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x4','ed_1','tp_ok','n',NULL)"],
    ['workflow_tasks.title', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('y1','wf',NULL,NULL,NULL,'todo',NULL,'t')"],
    ['workflow_tasks.status', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('y2','wf','t',NULL,NULL,NULL,NULL,'t')"],
    ['workflow_tasks.workflow_id', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('y3',NULL,'t',NULL,NULL,'todo',NULL,'t')"],
    ['task_claims.task_id', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('z1',NULL,NULL,'u_a','t',NULL)"],
    ['task_claims.user_id', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('z2','tk',NULL,NULL,'t',NULL)"],
    ['task_claims.claimed_at', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('z3','tk',NULL,'u_a',NULL,NULL)"],
    ['pool_projects.edition_id', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('p1',NULL,'tm_1','t',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_projects.team_id', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('p2','ed_1',NULL,'t',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_talents.user_id', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t1',NULL,'ed_1','n',NULL,0,NULL,0,'[]','t')"],
    ['pool_talents.edition_id', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t0','u_a',NULL,'n',NULL,0,NULL,0,'[]','t')"],
    ['pool_talents.total_points', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t2','u_a','ed_1','n',NULL,NULL,NULL,0,'[]','t')"],
    ['pool_talents.stages_joined', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t3','u_a','ed_1','n',NULL,0,NULL,NULL,'[]','t')"],
    ['pool_talents.skills_json', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t4','u_a','ed_1','n',NULL,0,NULL,0,NULL,'t')"],
    ['pool_resources.edition_id', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('r1',NULL,'ent_1','n','enterprise_brief','d','t')"],
    ['pool_resources.enterprise_id', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('r2','ed_1',NULL,'n','enterprise_brief','d','t')"],
    ['pool_resources.kind', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('r3','ed_1','ent_1','n',NULL,'d','t')"],
    ['public_tokens.scope', "INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('h9',NULL,'ed_1','e','c')"],
    ['public_tokens.expires_at', "INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('h10','leaderboard','ed_1',NULL,'c')"],
  ];
  for (const [label, sql] of NOT_NULL_CASES) {
    assert.throws(() => db.prepare(sql).run(), /NOT NULL constraint failed/, `${label} 必须为 NOT NULL`);
  }

  // ⚠️ public_tokens.token **不在**上面的名单里 —— 这不是漏写，是 SQLite 的历史行为：
  //    TEXT PRIMARY KEY（只有 INTEGER PRIMARY KEY 才是 rowid 别名）允许 NULL。
  //    P0–P4 的所有 id 列都是这个写法（users.id / teams.id / task_packages.id / …），
  //    本迁移沿用同一约定（不单点偏离）。
  //    → 这里把它**钉住**：将来若给主键补 NOT NULL，这条会红，提示同步补仓储层的空值防线。
  //    实际影响：无 —— 公开令牌的查找键恒为 SHA-256 十六进制串，永远匹配不到 NULL 行。
  assert.doesNotThrow(
    () => db.prepare("INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (NULL,'leaderboard','ed_1','e','c')").run(),
    'SQLite 的 TEXT PRIMARY KEY 允许 NULL（P0–P4 既有约定）',
  );

  const FK_CASES = [
    ['workflows.task_package_id → task_packages(id)', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('f1','ed_1','tp_none','n','t')"],
    ['workflow_tasks.workflow_id → workflows(id)', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('f2','wf_none','t',NULL,NULL,'todo',NULL,'t')"],
    ['workflow_tasks.owner_team_id → teams(id)', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('f3','wf','t',NULL,'tm_none','todo',NULL,'t')"],
    ['task_claims.task_id → workflow_tasks(id)', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('f4','tk_none',NULL,'u_a','t',NULL)"],
    ['task_claims.team_id → teams(id)', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('f5','tk','tm_none','u_a','t',NULL)"],
    ['task_claims.user_id → users(id)', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('f6','tk',NULL,'u_none','t',NULL)"],
    ['pool_projects.team_id → teams(id)', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('f7','ed_1','tm_none','t',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_talents.user_id → users(id)', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('f8','u_none','ed_1','n',NULL,0,NULL,0,'[]','t')"],
  ];
  for (const [label, sql] of FK_CASES) {
    assert.throws(() => db.prepare(sql).run(), /FOREIGN KEY constraint failed/, `${label} 必须有外键`);
  }

  // 主键重复必须被拒绝
  db.prepare("INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('dup','leaderboard','ed_1','e','c')").run();
  assert.throws(
    () => db.prepare("INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('dup','calendar','ed_1','e','c')").run(),
    /UNIQUE constraint failed/,
  );

  // 七张表的主键都要真的挡住重复 id
  // ⚠️ 重复行必须**只撞主键**：自然键 / 部分唯一索引要用不同的值，
  //    否则报错信息指向的是自然键，这条断言就测错了东西。
  db.prepare("INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('tk2','wf','第二个任务',NULL,'tm_1','todo',NULL,'t')").run();
  db.prepare("INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('ck1','tk','tm_1','u_a','2026-10-03T00:00:00.000Z',NULL)").run();
  db.prepare("INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('pk1','ed_2','tm_9','t',NULL,NULL,NULL,NULL,NULL,'t')").run();
  db.prepare("INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('pt1','u_a','ed_1','n',NULL,0,NULL,0,'[]','t')").run();
  db.prepare("INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('pr1','ed_1','ent_1','n','enterprise_brief','d','t')").run();
  const PK_DUP_CASES = [
    ['workflows', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('wf','ed_1','tp_ok','n2','t')"],
    ['workflow_tasks', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('tk','wf','t2',NULL,'tm_1','todo',NULL,'t')"],
    ['task_claims', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('ck1','tk2','tm_1','u_b','t',NULL)"],
    ['pool_projects', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('pk1','ed_2','tm_1','t2',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_talents', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('pt1','u_b','ed_1','n2',NULL,0,NULL,0,'[]','t')"],
    ['pool_resources', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('pr1','ed_1','ent_2','n2','free_brief','d','t')"],
    ['public_tokens', "INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('dup','calendar','ed_1','e','c')"],
  ];
  for (const [label, sql] of PK_DUP_CASES) {
    assert.throws(() => db.prepare(sql).run(), /UNIQUE constraint failed/, `${label} 的主键必须挡住重复 id`);
  }

  // 同一届的**两支不同队**各自都能有项目池记录（唯一键是 (edition_id, team_id)，不是 edition_id）
  const insProject = db.prepare(
    `INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insProject.run('pp_a', 'ed_1', 'tm_1', '一队项目', null, null, null, null, null, 't');
  insProject.run('pp_b', 'ed_1', 'tm_2', '二队项目', null, null, null, null, null, 't');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pool_projects WHERE edition_id = ?').get('ed_1').n, 2);

  cleanup(db, close, dataDir);
});

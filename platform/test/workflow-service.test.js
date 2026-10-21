import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import * as workflow from '../src/services/workflow.js';
import { validateTaskEvidence } from '../src/domain/task-evidence.js';
// 「真实写入方」：新增用例的世界用仓储层的真实写入函数造数据
// （判别性 + 不让「手造 input」把一致变成假象 —— 本项目踩过的坑）
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage } from '../src/db/repo/stages.js';
import { insertLedgerEntry, insertBehaviorEvent } from '../src/db/repo/points.js';

const here = dirname(fileURLToPath(import.meta.url));

// 统一的注入时间戳（领域层无 Date.now()：所有时间都必须由调用方注入）
const NOW = '2026-10-02T00:00:00.000Z';
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5wf-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_cap', '队长甲', '13900000011', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_other', '组员乙', '13900000012', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_out', '路人丙', '13900000013', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z');
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
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_cap', 'stage_rank', 10, '2026-10-10T00:00:00.000Z');
  `);
  return { db, close, dataDir };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

function seedWorkflow(db) {
  const wf = workflow.createWorkflow({
    db, editionId: 'ed_1', taskPackageId: 'tp_1', name: '风控助手工作流', actorId: 'u_cap', now: '2026-10-02T00:00:00.000Z',
  });
  const task = workflow.createWorkflowTask({
    db, workflowId: wf.id, title: '跑通风控模型', detail: '需要一个可演示的 demo',
    ownerTeamId: 'tm_1', dueAt: '2026-10-12', actorId: 'u_cap', now: '2026-10-02T00:00:00.000Z',
  });
  return { wf, task };
}

test('队员可以自主领取任务，任务状态变 in_progress', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  const res = workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  assert.equal(res.task.status, 'in_progress');
  assert.equal(res.claim.user_id, 'u_cap');
  const n = db.prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL').get(task.id).n;
  assert.equal(n, 1);
  cleanup(db, close, dataDir);
});

test('同一任务不能被两人同时领取：第二个人拿到 409，库里有效领取仍然只有 1 条', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });

  assert.throws(
    () => workflow.claimTask({ db, taskId: task.id, userId: 'u_other', teamId: 'tm_1', now: '2026-10-03T00:00:01.000Z' }),
    (err) => err.status === 409 && err.code === 'TASK_ALREADY_CLAIMED',
    '第二个人领取必须被拒（409 TASK_ALREADY_CLAIMED）',
  );

  const n = db.prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL').get(task.id).n;
  assert.equal(n, 1, '有效领取永远只有一条');
  cleanup(db, close, dataDir);
});

test('释放后任务回到 todo，可以被别人领取', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const released = workflow.releaseTask({ db, taskId: task.id, userId: 'u_cap', now: '2026-10-03T02:00:00.000Z' });
  assert.equal(released.task.status, 'todo');

  const res = workflow.claimTask({ db, taskId: task.id, userId: 'u_other', teamId: 'tm_1', now: '2026-10-03T03:00:00.000Z' });
  assert.equal(res.claim.user_id, 'u_other');
  cleanup(db, close, dataDir);
});

test('不能释放别人领取的任务（403）', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  assert.throws(
    () => workflow.releaseTask({ db, taskId: task.id, userId: 'u_other', now: '2026-10-03T01:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'NOT_CLAIM_HOLDER',
  );
  cleanup(db, close, dataDir);
});

test('完成必须提交可运行状态或明确阻塞点：只给一段文字说明 → 400 EVIDENCE_REQUIRED', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });

  assert.throws(
    () => workflow.completeTask({
      db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
      evidence: { summary: '今天把模型跑通了，感觉还行，明天继续' },
    }),
    (err) => err.status === 400 && err.code === 'EVIDENCE_REQUIRED',
    '纯文字进度说明必须被拒绝（R-STG-04）',
  );
  const row = db.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get(task.id);
  assert.equal(row.status, 'in_progress', '被拒的提交不能改变任务状态');
  cleanup(db, close, dataDir);
});

test('kind=runnable 且带链接与版本 → 任务变 done，证据落库', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const res = workflow.completeTask({
    db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
    evidence: {
      kind: 'runnable',
      summary: '模型已跑通，给出可演示的 demo',
      artifactUrl: 'https://git.example.com/demo/risk-model',
      version: 'v0.3.1',
    },
  });
  assert.equal(res.task.status, 'done');
  assert.equal(res.task.completed_by, 'u_cap');
  assert.ok(res.task.evidence_json.includes('v0.3.1'), '证据必须落库');
  cleanup(db, close, dataDir);
});

test('kind=blocked 且写明阻塞点与解除条件 → 任务变 blocked（挂起等解除），不是完成', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const res = workflow.completeTask({
    db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
    evidence: {
      kind: 'blocked',
      summary: '拿不到风控数据，无法训练',
      blocker: { reason: '数据未授权', needed: '企业出具《数据授权说明》' },
    },
  });
  assert.equal(res.task.status, 'blocked');
  assert.notEqual(res.task.status, 'done');
  cleanup(db, close, dataDir);
});

test('完成任务不加分：points_ledger 行数不变（任务完成 ≠ 赛段交付物得分）', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const before = db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n;
  workflow.completeTask({
    db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
    evidence: { kind: 'runnable', summary: '跑通了', artifactUrl: 'https://git.example.com/demo/risk-model', version: 'v1' },
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n;
  assert.equal(after, before, '任务清单的完成记录不写积分');
  cleanup(db, close, dataDir);
});

test('非本队成员看不到任务清单（返回空数组，不是报错）', () => {
  const { db, close, dataDir } = setup();
  const { wf } = seedWorkflow(db);
  const rows = workflow.listWorkflowTasks({ db, workflowId: wf.id, viewer: { id: 'u_out' } });
  assert.deepEqual(rows, [], '列表不满足 → 200 + 空集（不暴露"有但不给看"）');
  cleanup(db, close, dataDir);
});

test('本队成员能看到全部任务与领取人', () => {
  const { db, close, dataDir } = setup();
  const { wf, task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const rows = workflow.listWorkflowTasks({ db, workflowId: wf.id, viewer: { id: 'u_other' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claim.userId, 'u_cap');
  assert.equal(rows[0].isMine, false);
  cleanup(db, close, dataDir);
});

test('禁止岗位制：服务层没有任何"按岗位/身份分配任务"的出口', () => {
  const exported = Object.keys(workflow);
  for (const forbidden of ['assignTask', 'assignByRole', 'assignTaskByPosition', 'dispatchTask', 'allocateTask']) {
    assert.equal(exported.includes(forbidden), false, `⛔ 不允许出现 ${forbidden}（R-OPS-14 禁止岗位制）`);
  }
  assert.ok(exported.includes('claimTask'), '唯一获得任务的入口是自主领取');
  const src = readFileSync(join(here, '..', 'src', 'services', 'workflow.js'), 'utf8');
  assert.ok(src.includes('R-OPS-14'), '代码注释必须标注 R-OPS-14：禁止岗位制，任务只能自主领取');
  // 判别性：`includes('R-OPS-14')` 会被**任何一处**出现满足 ——
  //   而规格要求的是「这行注释必须留着」，所以把整行逐字钉住。
  //   （否则「删掉溯源注释」是一个等价变异体，测试根本区分不出来。）
  assert.ok(
    src.includes('// R-OPS-14：禁止岗位制，任务只能自主领取'),
    '必须逐字保留这行注释：// R-OPS-14：禁止岗位制，任务只能自主领取',
  );
});

test('未登录领取 → 401', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  assert.throws(
    () => workflow.claimTask({ db, taskId: task.id, userId: 'u_missing', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' }),
    (err) => err.status === 401,
  );
  cleanup(db, close, dataDir);
});

// ════════════════════════════════════════════════════════════════════════════
// P5 Task 2 追加：规格缺陷补测（台账 T2-1 / T2-2）
//
// 计划原测试块 12 例覆盖了主链路（领取唯一性 / 释放 / 完成证据 / 禁止岗位制 /
// 完成不加分），但**判别力不足**：多处期望值「恰好相同」区分不出两种实现；
// 若干分支（403/404/409 的细分、并发兜底、behavior_events 边界、真实写入方形状）
// **零覆盖**。下面按三条纪律补：
//
//   ① 判别性：每个用例的期望值必须让「两种算法」产生**不同**结果，
//      否则「一致」只是巧合（例如「同届期不同任务包」与「同队不同届期」都不可见，
//      只测前者测不出「漏了 editionId 过滤」）。
//   ② 真实写入方：新增用例的世界用**仓储层的真实写入函数**造数据
//      （createUser / createEdition / createTaskPackage / insertTeam /
//      insertTeamMember / insertStage / insertLedgerEntry / insertBehaviorEvent），
//      不用手写 INSERT —— 免得「手造 input 让一致变成假象」（本项目踩过的坑）：
//      真实写入方产出 teams.status='forming'、task_packages.status='submitted'，
//      而计划原种子里手写成 'active' / 'approved' —— 一份偷偷按 status 过滤的
//      实现，在手造种子里照样绿。
//   ③ 溯源：每条断言写明依据的规则编号与出处。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 「真实写入方」世界。
 *
 * 拓扑（用来判别可见性必须**同时**按届期与任务包隔离）：
 *   ed1/tp1/tm1 —— 一队（captain + member）；本 Task 的主工作流挂在这里
 *   ed1/tp2/tm2 —— 二队：同届期、**不同任务包** → 对 tp1 的工作流不可见
 *   ed2/tp3/tm3 —— 三队：**下一届**、不同任务包   → 对 tp1 的工作流不可见
 *   ed2/tp1/tm4 —— 四队：⚠️ 刻意的「不一致数据」（下一届的队指向本届的任务包）→ 不可见
 *   admin        —— 组委会（超管），**不属于任何队** → 只能靠超管分支才看得见
 *   outsider     —— 外单位路人，**不属于任何队** → 不可见
 */
function setupWorld() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5wfw-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  const users = {
    captain: createUser(db, { name: '队长甲', phone: '13900000011', password: 'pw', mbaStatus: 'mba', org: '学堂' }),
    member: createUser(db, { name: '组员乙', phone: '13900000012', password: 'pw', org: '学堂' }),
    outsider: createUser(db, { name: '路人丙', phone: '13900000013', password: 'pw', org: '外单位' }),
    captain2: createUser(db, { name: '队长丁', phone: '13900000014', password: 'pw', org: '学堂' }),
    captain3: createUser(db, { name: '队长戊', phone: '13900000015', password: 'pw', org: '学堂' }),
    captain4: createUser(db, { name: '队长己', phone: '13900000017', password: 'pw', org: '学堂' }),
    admin: createUser(db, { name: '组委会', phone: '13900000016', password: 'pw', org: '组委会' }),
  };
  setSuperadmin(db, users.admin.id);

  const editions = {
    ed1: createEdition(db, { name: '第一届', city: '杭州', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW }),
    ed2: createEdition(db, { name: '第二届', city: '上海', startsAt: '2027-10-01', endsAt: '2027-10-31', now: NOW }),
  };

  const packages = {
    tp1: createTaskPackage(db, {
      editionId: editions.ed1.id, title: '零售风控助手', painPoint: '人工审批慢',
      expectedDelivery: '可演示原型', acceptanceCriteria: '能跑起来就行',
      submittedBy: users.captain.id, now: NOW,
    }),
    tp2: createTaskPackage(db, {
      editionId: editions.ed1.id, title: '招股书排版助手', painPoint: '排版太慢',
      expectedDelivery: '可演示原型', acceptanceCriteria: '能跑起来就行',
      submittedBy: users.captain2.id, now: NOW,
    }),
    tp3: createTaskPackage(db, {
      editionId: editions.ed2.id, title: '下一届的包', painPoint: '下一届的痛点',
      expectedDelivery: '可演示原型', acceptanceCriteria: '能跑起来就行',
      submittedBy: users.captain3.id, now: NOW,
    }),
  };

  const teams = {
    tm1: insertTeam(db, {
      editionId: editions.ed1.id, name: '一队', captainId: users.captain.id,
      taskPackageId: packages.tp1.id, tier: 'C', now: NOW,
    }),
    tm2: insertTeam(db, {
      editionId: editions.ed1.id, name: '二队', captainId: users.captain2.id,
      taskPackageId: packages.tp2.id, now: NOW,
    }),
    tm3: insertTeam(db, {
      editionId: editions.ed2.id, name: '三队', captainId: users.captain3.id,
      taskPackageId: packages.tp3.id, now: NOW,
    }),
    // ⚠️ tm4 是**刻意的「不一致数据」**：队伍挂在 ed_2，却指向 ed_1 的任务包 tp_1。
    //    为什么要造这条脏数据：可见性的 `editionId` 过滤**只有**在这种数据下才可观测 ——
    //    正常的「跨届期队」本来就带着别的 task_package_id，光靠 taskPackageId 就已经挡住了，
    //    于是「漏掉 editionId 过滤」这个变异体在干净数据上**完全等价**（测不出来）。
    //    这条脏数据是 DDL 允许的（teams.edition_id 与 task_packages.edition_id 之间没有一致性约束），
    //    真实写入方 insertTeam 也照样能写出来。
    tm4: insertTeam(db, {
      editionId: editions.ed2.id, name: '四队', captainId: users.captain4.id,
      taskPackageId: packages.tp1.id, now: NOW,
    }),
  };

  insertTeamMember(db, { teamId: teams.tm1.id, userId: users.captain.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teams.tm1.id, userId: users.member.id, role: 'member', now: NOW });
  insertTeamMember(db, { teamId: teams.tm2.id, userId: users.captain2.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teams.tm3.id, userId: users.captain3.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teams.tm4.id, userId: users.captain4.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: editions.ed1.id, key: 's1', name: '调研', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'computed',
  });

  return { db, close, dataDir, users, editions, packages, teams, stage };
}

/** 在真实写入方的世界里建一条工作流 + 一个任务。 */
function seedWorldWorkflow(w) {
  const wf = workflow.createWorkflow({
    db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
    name: '风控助手工作流', actorId: w.users.captain.id, now: NOW,
  });
  const task = workflow.createWorkflowTask({
    db: w.db, workflowId: wf.id, title: '跑通风控模型', detail: '需要一个可演示的 demo',
    ownerTeamId: w.teams.tm1.id, dueAt: '2026-10-12', actorId: w.users.captain.id, now: NOW,
  });
  return { wf, task };
}

/** 一份合法的 kind=runnable 证据。 */
function runnableEvidence() {
  return {
    kind: 'runnable', summary: '模型已跑通，给出可演示的 demo',
    artifactUrl: 'https://git.example.com/demo/risk-model', version: 'v0.3.1',
  };
}

// ── 领域纯函数层：R-STG-04 的证据校验 ─────────────────────────────────

test('证据校验：kind 不是 runnable/blocked（如 progress）→ 不通过（只认「可运行」或「明确阻塞点」）', () => {
  const r = validateTaskEvidence({ kind: 'progress', summary: '还在做' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'kind'), JSON.stringify(r.errors));
});

test('证据校验：summary 为空或全是空白 → 不通过（纯文字进度说明不给分）', () => {
  const missing = validateTaskEvidence({ kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.field === 'summary'), JSON.stringify(missing.errors));

  const blank = validateTaskEvidence({
    kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1', summary: '   \n\t ',
  });
  assert.equal(blank.ok, false, '纯空白等于没写');
  assert.ok(blank.errors.some((e) => e.field === 'summary'), JSON.stringify(blank.errors));
});

test('证据校验：summary 长度边界 500 通过 / 501 不通过（判别性：两个阈值口径结果不同）', () => {
  const atLimit = validateTaskEvidence({
    kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1', summary: 'a'.repeat(500),
  });
  assert.equal(atLimit.ok, true, JSON.stringify(atLimit.errors));

  const overLimit = validateTaskEvidence({
    kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1', summary: 'a'.repeat(501),
  });
  assert.equal(overLimit.ok, false);
  assert.ok(overLimit.errors.some((e) => e.field === 'summary'), JSON.stringify(overLimit.errors));
});

test('证据校验：kind=runnable 缺 artifactUrl → 不通过（必须给出可运行产物）', () => {
  const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', version: 'v1' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'artifactUrl'), JSON.stringify(r.errors));
  // 判别性：「**缺**产物」与「产物**形态不对**」是两条不同的错误 ——
  // 只断言 field 会把两者混为一谈（错误文案是用户能看见的，必须能区分）。
  assert.ok(
    r.errors.some((e) => e.message.includes('必须给出可运行产物')),
    `缺产物的提示语必须是「必须给出可运行产物」，实际 ${JSON.stringify(r.errors)}`,
  );
  assert.equal(r.errors.filter((e) => e.field === 'artifactUrl').length, 1, '只报一条 artifactUrl 错误');
});

test('证据校验：kind=runnable 的 artifactUrl 必须够格（判别性：四种合法形态 vs 两种非法形态）', () => {
  // 合法：http(s) / ssh / git@ / 裸仓库路径 —— 四种都得放行
  for (const url of [
    'https://git.example.com/demo/risk-model', 'http://x.dev/a',
    'git@github.com:owner/risk-model.git', 'owner/risk-model',
  ]) {
    const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', artifactUrl: url, version: 'v1' });
    assert.equal(r.ok, true, `${url} 必须被接受：${JSON.stringify(r.errors)}`);
  }
  // 非法：既不是 http(s)/ssh/git@，也不是 owner/repo
  for (const url of ['not-a-url', 'file:///etc/passwd']) {
    const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', artifactUrl: url, version: 'v1' });
    assert.equal(r.ok, false, `${url} 必须被拒绝`);
    assert.ok(r.errors.some((e) => e.field === 'artifactUrl'), JSON.stringify(r.errors));
    // 判别性：形态不对的提示语与「缺产物」不同（两条错误不能混）
    assert.ok(
      r.errors.some((e) => e.message.includes('必须是 http(s) 链接')),
      `${url} 的提示语必须是「artifactUrl 必须是 http(s) 链接或 git 仓库地址」，实际 ${JSON.stringify(r.errors)}`,
    );
  }
});

test('证据校验：kind=runnable 缺 version → 不通过（S10 §3.4：提交须带版本记录 + 代码仓）', () => {
  const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', artifactUrl: 'https://x.dev/a' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'version'), JSON.stringify(r.errors));
});

test('证据校验：kind=blocked 必须写明阻塞点与解除条件（缺一不可）', () => {
  const noReason = validateTaskEvidence({
    kind: 'blocked', summary: '卡住了', blocker: { needed: '企业出具《数据授权说明》' },
  });
  assert.equal(noReason.ok, false);
  assert.ok(noReason.errors.some((e) => e.field === 'blocker.reason'), JSON.stringify(noReason.errors));

  const noNeeded = validateTaskEvidence({
    kind: 'blocked', summary: '卡住了', blocker: { reason: '数据未授权' },
  });
  assert.equal(noNeeded.ok, false);
  assert.ok(noNeeded.errors.some((e) => e.field === 'blocker.needed'), JSON.stringify(noNeeded.errors));

  const good = validateTaskEvidence({
    kind: 'blocked', summary: '卡住了', blocker: { reason: '数据未授权', needed: '企业出具《数据授权说明》' },
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('证据校验：evidence 为 null / 非对象 → 不通过且不抛异常', () => {
  for (const ev of [null, undefined, '跑通了', 42]) {
    const r = validateTaskEvidence(ev);
    assert.equal(r.ok, false, `${JSON.stringify(ev) ?? 'undefined'} 必须不通过`);
    assert.ok(r.errors.length > 0);
  }
});

// ── 服务层：建工作流 / 建任务的入参与权限 ───────────────────────────────

test('建工作流：非该任务包的队员 → 403（不能替别人拆解工作流）', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
      name: '越权工作流', actorId: w.users.outsider.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
    '外单位用户不能拆解别人任务包的工作流',
  );
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
      name: '越权工作流', actorId: w.users.captain2.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
    '同届期但认领了别的任务包的队员也不能拆这一包',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建工作流：缺 editionId / taskPackageId → 400 EDITION_AND_PACKAGE_REQUIRED', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: null, taskPackageId: w.packages.tp1.id,
      name: '缺届期', actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'EDITION_AND_PACKAGE_REQUIRED',
  );
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: null,
      name: '缺任务包', actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'EDITION_AND_PACKAGE_REQUIRED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建工作流：name 为空白 → 400 NAME_REQUIRED', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
      name: '   ', actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'NAME_REQUIRED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：工作流不存在 → 404 WORKFLOW_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: 'wf_none', title: '任务', ownerTeamId: w.teams.tm1.id,
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'WORKFLOW_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：title 为空白 → 400 TITLE_REQUIRED', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: wf.id, title: '  ', ownerTeamId: w.teams.tm1.id,
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'TITLE_REQUIRED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：ownerTeamId 不存在 → 404 TEAM_NOT_FOUND', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: wf.id, title: '任务', ownerTeamId: 'tm_none',
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：给别的队建任务 → 403（不能给别人派活——那正是岗位制的入口）', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: wf.id, title: '给二队的活', ownerTeamId: w.teams.tm2.id,
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
    '一队队长不能给二队建任务',
  );
  cleanup(w.db, w.close, w.dataDir);
});

// ── 服务层：列任务清单的三态与可见性 ───────────────────────────────────

test('列任务：工作流不存在 → 404（单条不满足 → 404，不是空集）', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.listWorkflowTasks({ db: w.db, workflowId: 'wf_none', viewer: { id: w.users.captain.id } }),
    (err) => err.status === 404 && err.code === 'WORKFLOW_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：没有 viewer → 401', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: null }),
    (err) => err.status === 401,
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：组委会（超管）全可见（viewer 形状 = { id, is_superadmin }，与 permissions.js 精简对象同款）', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  const rows = workflow.listWorkflowTasks({
    db: w.db, workflowId: wf.id, viewer: { id: w.users.admin.id, is_superadmin: 1 },
  });
  assert.equal(rows.length, 1, '超管不看队也能看到任务清单');
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：可见性必须同时按届期与任务包隔离（判别性：三种「不可见」互不等价）', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  const view = (id) => workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id } });

  // 同届期、**不同任务包**的队员 → 不可见（漏掉 taskPackageId 过滤就会露馅）
  assert.deepEqual(view(w.users.captain2.id), [], '同届期不同任务包 → 200 + 空集');
  // **下一届**的队员 → 不可见（漏掉 editionId 过滤就会露馅）
  assert.deepEqual(view(w.users.captain3.id), [], '跨届期 → 200 + 空集');
  // 外单位 → 不可见
  assert.deepEqual(view(w.users.outsider.id), [], '非本队成员 → 200 + 空集');
  // ⚠️ 脏数据队（挂在 ed_2 却指向 ed_1 的任务包 tp_1）→ 仍然不可见：
  //    届期隔离**优先于**任务包 —— 漏掉 editionId 过滤就会把它放进来。
  assert.deepEqual(view(w.users.captain4.id), [], '跨届期的队（即使指向同一个任务包）→ 200 + 空集');
  // 本队 → 可见
  assert.equal(view(w.users.member.id).length, 1, '本队成员可见');
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：领取人就是自己时 isMine=true（判别性：与「别人领的」结果不同）', () => {
  const w = setupWorld();
  const { wf, task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  const mine = workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id: w.users.captain.id } });
  assert.equal(mine[0].isMine, true, '自己领的必须 isMine=true');
  assert.equal(mine[0].claim.userId, w.users.captain.id);
  assert.equal(mine[0].claim.teamId, w.teams.tm1.id, '领取记录要带队伍');
  assert.equal(mine[0].claim.claimedAt, NOW, '领取记录要带领取时间');
  // 列表的**整条字段映射**也要钉住（判别性：任一字段被改成常量/空都会被抓住）
  assert.equal(mine[0].id, task.id);
  assert.equal(mine[0].workflowId, wf.id);
  assert.equal(mine[0].title, '跑通风控模型');
  assert.equal(mine[0].detail, '需要一个可演示的 demo');
  assert.equal(mine[0].ownerTeamId, w.teams.tm1.id);
  assert.equal(mine[0].status, 'in_progress');
  assert.equal(mine[0].dueAt, '2026-10-12');
  assert.equal(mine[0].createdAt, NOW);
  assert.equal(mine[0].completedAt, null, '还没完成时 completedAt 必须是 null');
  assert.equal(mine[0].completedBy, null, '还没完成时 completedBy 必须是 null');

  const other = workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id: w.users.member.id } });
  assert.equal(other[0].isMine, false, '别人领的必须 isMine=false');
  cleanup(w.db, w.close, w.dataDir);
});

// ── 服务层：自主领取 ───────────────────────────────────────────────────

test('领取：任务不存在 → 404 TASK_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: 'tk_none', userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TASK_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：任务已完成 → 409 TASK_ALREADY_DONE（已完成的不能再被领走）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
  });
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.member.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 409 && err.code === 'TASK_ALREADY_DONE',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：不是该队成员 → 403 NOT_TEAM_MEMBER（不能替别人队领取）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.outsider.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'NOT_TEAM_MEMBER',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：队伍不存在 → 404 TEAM_NOT_FOUND', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: 'tm_none', now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：本人不在任何队伍且未指定 teamId → 400 NO_TEAM', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.outsider.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'NO_TEAM',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：未指定 teamId → 自动落到本人所在队（判别性：不能只认显式传入的队）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  const res = workflow.claimTask({ db: w.db, taskId: task.id, userId: w.users.member.id, now: NOW });
  assert.equal(res.claim.team_id, w.teams.tm1.id, '未指定队伍时必须落到本人所在队');
  assert.equal(res.claim.user_id, w.users.member.id);
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：数据库唯一约束兜底 —— 唯一冲突必须被翻译成 409，而不是漏出裸 SQLite 错误', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  // ⛔ 为什么用触发器：唯一索引 ux_task_claims_active 在库里，但服务层的**前置检查**
  //    会先命中，catch 那条「最后一道防线」在串行测试里永远走不到。
  //    这里用触发器精确制造同样的 SQLITE_CONSTRAINT 错误（错误文本与唯一索引一致），
  //    验证「数据库拒绝 → 409 TASK_ALREADY_CLAIMED」这条翻译链真的接上了。
  w.db.exec(`
    CREATE TRIGGER ux_task_claims_active_sim BEFORE INSERT ON task_claims
    BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: task_claims.task_id'); END;
  `);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 409 && err.code === 'TASK_ALREADY_CLAIMED',
    '数据库的唯一冲突必须被翻译成 409（不能漏出裸 SQLite 错误）',
  );
  const row = w.db.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get(task.id);
  assert.equal(row.status, 'todo', '插入失败时任务状态不能被改成 in_progress');
  cleanup(w.db, w.close, w.dataDir);
});

/**
 * ★ 真并发用例（服务层）。
 *
 * 为什么不能只串行跑：串行的第二次必然被前置检查拦下 —— 那证明不了
 * 「并发下由数据库仲裁」。本用例用**两个 worker 线程 + 两条独立连接 + 屏障同步**
 * 让两次 claimTask **真正同时**发起，然后断言：恰好一个成功、另一个拿到
 * 409 TASK_ALREADY_CLAIMED、库里的有效领取永远只有一条。
 */
const CLAIM_WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from ${JSON.stringify(pathToFileURL(join(here, '..', 'src', 'db', 'sqlite.js')).href)};
import * as workflow from ${JSON.stringify(pathToFileURL(join(here, '..', 'src', 'services', 'workflow.js')).href)};
const { db, close } = openDatabase({ dataDir: workerData.dataDir });
parentPort.postMessage({ ready: true });
const barrier = new Int32Array(workerData.barrier);
Atomics.add(barrier, 0, 1);
while (Atomics.load(barrier, 0) < 2) {
  Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 20);
}
const t0 = Number(process.hrtime.bigint() / 1000000n);
let outcome;
try {
  const res = workflow.claimTask({
    db, taskId: workerData.taskId, userId: workerData.userId, teamId: workerData.teamId, now: workerData.now,
  });
  outcome = { ok: true, userId: res.claim.user_id };
} catch (err) {
  outcome = { ok: false, status: err && err.status, code: err && err.code, message: String(err && err.message) };
}
const t1 = Number(process.hrtime.bigint() / 1000000n);
close();
parentPort.postMessage({ ...outcome, t0, t1 });
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

test('领取：两人真并发抢同一任务 → 恰好一个成功、另一个 409，库中有效领取只有一条', async () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  // 先把主连接关掉：并发由 worker 持有的两条连接完成
  w.close();

  const barrier = new SharedArrayBuffer(4);
  const base = {
    dataDir: w.dataDir, barrier, taskId: task.id, teamId: w.teams.tm1.id, now: NOW,
  };
  const a = spawnClaimWorker({ ...base, userId: w.users.captain.id });
  await a.ready;                        // 连接 A 已建立
  const b = spawnClaimWorker({ ...base, userId: w.users.member.id });
  await b.ready;                        // 连接 B 已建立（错开建立，避开 WAL PRAGMA 抢锁）
  const [ra, rb] = await Promise.all([a.done, b.done]);

  const winners = [ra, rb].filter((r) => r.ok);
  const losers = [ra, rb].filter((r) => !r.ok);
  assert.equal(winners.length, 1, `恰好一条领取成功，实际 ${JSON.stringify([ra, rb])}`);
  assert.equal(losers.length, 1, `恰好一条被拒，实际 ${JSON.stringify([ra, rb])}`);
  assert.equal(losers[0].status, 409, '被拒的一方必须拿到 409');
  assert.equal(losers[0].code, 'TASK_ALREADY_CLAIMED', '被拒的一方必须是 TASK_ALREADY_CLAIMED');

  // 证明这**确实是并发**而不是被测试串行化：两次调用的时间区间必须重叠
  const earliest = Math.min(ra.t0, rb.t0);
  const latest = Math.max(ra.t1, rb.t1);
  assert.ok(earliest < latest, `两次领取必须重叠才叫并发，实际区间 ${earliest}~${latest}`);

  const { db: db2, close: close2 } = openDatabase({ dataDir: w.dataDir });
  const n = db2
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get(task.id).n;
  assert.equal(n, 1, '有效领取永远只有一条');
  close2();
  rmSync(w.dataDir, { recursive: true, force: true });
});

// ── 服务层：释放 ───────────────────────────────────────────────────────

test('释放：任务不存在 → 404 TASK_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.releaseTask({ db: w.db, taskId: 'tk_none', userId: w.users.captain.id, now: NOW }),
    (err) => err.status === 404 && err.code === 'TASK_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('释放：任务当前无人领取 → 409 TASK_NOT_CLAIMED', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.releaseTask({ db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW }),
    (err) => err.status === 409 && err.code === 'TASK_NOT_CLAIMED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

// ── 服务层：提交完成状态 ───────────────────────────────────────────────

test('完成：任务不存在 → 404 TASK_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.completeTask({
      db: w.db, taskId: 'tk_none', userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
    }),
    (err) => err.status === 404 && err.code === 'TASK_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：任务当前无人领取 → 409 TASK_NOT_CLAIMED', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.completeTask({
      db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
    }),
    (err) => err.status === 409 && err.code === 'TASK_NOT_CLAIMED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：不是领取人 → 403 NOT_CLAIM_HOLDER（谁领的谁交）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  assert.throws(
    () => workflow.completeTask({
      db: w.db, taskId: task.id, userId: w.users.member.id, now: NOW, evidence: runnableEvidence(),
    }),
    (err) => err.status === 403 && err.code === 'NOT_CLAIM_HOLDER',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：completed_at 落库 = 注入的 now（判别性：时间戳必须来自入参，不是 Date.now()）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  const at = '2026-10-04T08:30:00.000Z';
  const res = workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, now: at, evidence: runnableEvidence(),
  });
  assert.equal(res.task.completed_at, at, '完成时间必须落库为传入的 now');
  assert.equal(res.task.completed_by, w.users.captain.id);
  assert.equal(res.task.status, 'done');
  // 列表投影也必须带出完成信息（判别性：completedAt/completedBy 不是常量 null）
  const rows = workflow.listWorkflowTasks({ db: w.db, workflowId: task.workflow_id, viewer: { id: w.users.captain.id } });
  assert.equal(rows[0].completedAt, at, '列表必须投影完成时间');
  assert.equal(rows[0].completedBy, w.users.captain.id, '列表必须投影完成人');
  assert.equal(rows[0].status, 'done');
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：不写 points_ledger、不写 behavior_events、不写 tier_records（红线 ②：任务完成 ≠ 赛段交付物得分）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  // 先用**真实写入方**造出三类分数载体（没有既存行的话，「行数不变」是恒真断言）
  insertLedgerEntry(w.db, {
    id: 'pl_seed', editionId: w.editions.ed1.id, stageId: w.stage.id, teamId: w.teams.tm1.id,
    userId: w.users.captain.id, kind: 'stage_rank', points: 10, createdAt: NOW,
  });
  insertBehaviorEvent(w.db, {
    id: 'be_seed', teamId: w.teams.tm1.id, userId: w.users.captain.id,
    type: 'weekly_progress', points: 3, evidence: '{"repo":"https://x.dev/a"}', createdAt: NOW,
  });
  const before = {
    ledger: w.db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n,
    behavior: w.db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n,
    tiers: w.db.prepare('SELECT COUNT(*) AS n FROM tier_records').get().n,
  };
  assert.ok(before.ledger > 0 && before.behavior > 0, '前提：分数载体必须先有既存行，否则断言恒真');

  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
  });

  const after = {
    ledger: w.db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n,
    behavior: w.db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n,
    tiers: w.db.prepare('SELECT COUNT(*) AS n FROM tier_records').get().n,
  };
  assert.deepEqual(after, before, '任务完成不得写任何分数载体（points_ledger / behavior_events / tier_records）');
  cleanup(w.db, w.close, w.dataDir);
});

// ── 两条红线 ───────────────────────────────────────────────────────────

test('禁止岗位制：数据列层面也没有「岗位 / 身份」列（PRAGMA table_info）', () => {
  const w = setupWorld();
  // ⛔ R-OPS-14：任务**只有** claimTask 一条获得路径。
  //    owner_team_id 是「任务清单归哪支队」（队维度），不是「谁担任什么岗位」（岗位维度）——
  //    它约束的是任务归属，不是领取资格；领取资格只由 claimTask 决定。
  const FORBIDDEN_COLUMNS = [
    'role', 'position', 'post', 'duty', 'job', 'seat',
    'assignee', 'assigned_to', 'assigned_user_id', 'owner_user_id', 'member_role',
  ];
  for (const table of ['workflow_tasks', 'task_claims']) {
    const cols = w.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const bad of FORBIDDEN_COLUMNS) {
      assert.equal(cols.includes(bad), false, `⛔ ${table} 不得有岗位/身份列 ${bad}（R-OPS-14 禁止岗位制）`);
    }
  }
  cleanup(w.db, w.close, w.dataDir);
});

test('真实写入方的数据照样跑通全链路（判别性：实现不得依赖手造种子的状态值）', () => {
  const w = setupWorld();
  // 真实写入方的 teams.status='forming'、task_packages.status='submitted'，
  // 而计划原种子里手写成 'active' / 'approved' ——
  // 一份偷偷按 status 过滤的实现，在手造种子里照样绿，在这里必红。
  const team = w.db.prepare('SELECT status FROM teams WHERE id = ?').get(w.teams.tm1.id);
  const pkg = w.db.prepare('SELECT status FROM task_packages WHERE id = ?').get(w.packages.tp1.id);
  assert.equal(team.status, 'forming', '前提：真实写入方产出的是 forming');
  assert.equal(pkg.status, 'submitted', '前提：真实写入方产出的是 submitted');

  const { wf, task } = seedWorldWorkflow(w);
  const rows = workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id: w.users.member.id } });
  assert.equal(rows.length, 1, '真实数据下任务清单照常可见');
  const claimed = workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.member.id, teamId: w.teams.tm1.id, now: NOW,
  });
  assert.equal(claimed.task.status, 'in_progress');
  const done = workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.member.id, now: NOW, evidence: runnableEvidence(),
  });
  assert.equal(done.task.status, 'done');
  cleanup(w.db, w.close, w.dataDir);
});

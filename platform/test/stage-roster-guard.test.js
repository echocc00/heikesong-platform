// platform/test/stage-roster-guard.test.js —— E156：赛段级名册「写了但评审路径不认」
//
// 背景（P11 · W4 机器闸 dead-service-scan 抓出的最后一条死函数）：
//   `src/db/repo/stage-teams.js::hasStageRoster` 在生产上零调用方。
//   而 `src/db/repo/stage-teams.js` 的头注释明写：
//     「P2 的 services/review.js 的 assertTeamInStage 仍是**届期级**判定 ——
//       切换到赛段级需要『名册有数据时优先赛段级、否则回落到届期级』的口径」
//   ⇒ 「外队进榜」的闸门始终没关上：
//      **同届期另一赛段的队伍**照样能被写进本赛段的评分 / 企业确认。
//
// 规则溯源：
//   - P3 计划偏差表 3c：「名册有数据时优先赛段级、否则回落到届期级」
//   - db/migrations/004_leaderboard.sql 的 stage_team 表注释：
//     「只有届期名册时，同届期另一赛段的队伍也能被写进本赛段 → **外队进榜**」
//   - db/migrations/003_review.sql：stages / stage_judges / stage_team 三张表
//
// ⛔ 口径的另一半（不能只看一半）：
//   赛段级名册**没登记任何队伍**时（hasStageRoster = false）必须**回落到届期级**
//   —— 否则「赛段刚建、还没报名册」会让所有评分都被拒（比外队进榜更糟：全死）。
//
// ⚠️ 本文件测的是**行为**（经 HTTP 路由提交评分），不是仓储层函数存在性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { createUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { createStage } from '../src/services/stage.js';
import { assignStageJudgeToStage, registerStageTeamRoster } from '../src/services/stage.js';
import { createApp } from '../src/server.js';
import { loadRules } from '../src/config.js';
import { isolateTempDir } from '../test-helpers/tmp.js';
import { call } from '../test-helpers/http-call.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

const NOW = '2026-10-23T00:00:00.000Z';

/**
 * 造一个「两支队伍、两个赛段、评委已分配」的场景。
 * ⚠️ 队甲在 S1 名册里，队乙**不在**任何赛段名册里（但**同届期** ⇒ 届期级判定会放行）。
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-roster-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  insertCapability(db, 'score:write', '写入评分');
  insertCapability(db, 'score:read', '读取评分');
  insertCapability(db, 'stage:compute', '触发计算发榜');
  insertRole(db, 'judge', '评委席');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'judge', 'score:write');
  insertRoleCapability(db, 'judge', 'score:read');
  insertRoleCapability(db, 'admin', 'score:write');
  insertRoleCapability(db, 'admin', 'score:read');
  insertRoleCapability(db, 'admin', 'stage:compute');

  // 管理员（全局授权）
  const admin = createUser(db, { name: '组委会', phone: '13900000001', password: 'pw' });
  insertUserRole(db, admin.id, 'admin');

  // 评委
  const judge = createUser(db, { name: '评委', phone: '13900000002', password: 'pw' });
  insertUserRole(db, judge.id, 'judge');

  // 届期（赛段要挂在届期下）
  const { db: _db } = { db };
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('ed_test', '测试届期', '上海', '2026-10-01', '2026-10-31', ?)`,
  ).run(NOW);

  // 任务包（队伍要挂任务包，否则企业席判定取不到 enterprise_id）
  db.prepare(
    `INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title,
       pain_point, expected_delivery, acceptance_criteria, grade, status,
       is_free_brief, submitted_by, submitted_at)
     VALUES ('tp_test', 'ed_test', ?, '某零售', '测试任务', '痛点', '原型', '验收', 'A', 'published', 0, ?, ?)`,
  ).run(admin.id, admin.id, NOW);

  // 两支队伍（**同届期** ⇒ 届期级名册会同时看到它们）
  for (const [id, name] of [['t_in', '队甲'], ['t_out', '队乙']]) {
    db.prepare(
      `INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, created_at)
       VALUES (?, 'ed_test', ?, ?, 'tp_test', ?)`,
    ).run(id, name, admin.id, NOW);
  }

  return { db, close, dataDir, admin, judge };
}

function makeStage(db, { key, name, kind = 'initial', scoringConfigKey = 'initial' }) {
  const { rules } = loadRules(rulesDir);
  return createStage({
    db,
    editionId: 'ed_test',
    key,
    name,
    kind,
    startsAt: '2026-10-01',
    endsAt: '2026-10-31',
    scoringConfigKey,
    actorId: null,
    now: NOW,
    rules,
  });
}

// ══════════════════════════════════════════════════════════════════
// 一、核心行为：赛段级名册有数据 ⇒ 同届期但不在名册的队必须被拒
// ══════════════════════════════════════════════════════════════════

test('赛段级名册有队伍 ⇒ 同届期但不在本赛段名册的队**提交评分被拒**（外队进榜闸门关上）', async () => {
  const { db, close, dataDir, judge } = setup();
  try {
    const stage = makeStage(db, { key: 'S1', name: '调研' });
    // 评委入席 + 队甲入名册（**只登记队甲**）
    assignStageJudgeToStage({ db, stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
    registerStageTeamRoster({ db, stageId: stage.id, teamIds: ['t_in'], now: NOW });

    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
    const { token } = createSession(db, judge.id);

    // 队乙（同届期，但**不在** S1 的赛段级名册里）
    const res = await call(app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token,
      body: { items: [{ teamId: 't_out', dimension: 'innovation', rawScore: 90 }] },
    });
    assert.equal(res.status, 404, `外队进榜必须被拒（期望 404），实际 ${res.status}：${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(
      body.error?.code ?? body.code,
      'TEAM_NOT_IN_STAGE',
      `必须撞「不在本赛段名册内」这个错，实际：${res.body}`,
    );

    // ⛔ 反向对照：名册里的队**必须**能提交（否则就是「全死」而不是「闸门关上」）
    const ok = await call(app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token,
      body: { items: [{ teamId: 't_in', dimension: 'innovation', rawScore: 90 }] },
    });
    assert.equal(ok.status, 200, `名册内的队必须能提交，实际 ${ok.status}：${ok.body}`);
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 二、口径的另一半：赛段级名册**为空** ⇒ 回落到届期级（不能全死）
// ══════════════════════════════════════════════════════════════════

test('赛段级名册**未登记任何队伍** ⇒ 回落到届期级（刚建的赛段不该把评分全拒了）', async () => {
  const { db, close, dataDir, judge } = setup();
  try {
    const stage = makeStage(db, { key: 'S1', name: '调研' });
    assignStageJudgeToStage({ db, stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
    // ⛔ **不**登记任何队伍 ⇒ 赛段级名册为空
    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
    const { token } = createSession(db, judge.id);

    const res = await call(app, 'POST', `/api/stages/${stage.id}/reviews`, {
      token,
      body: { items: [{ teamId: 't_in', dimension: 'innovation', rawScore: 90 }] },
    });
    assert.equal(res.status, 200, `名册为空时必须回落到届期级，实际 ${res.status}：${res.body}`);
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 三、写入路径也要一致：企业确认不得把外队写进本赛段
// ══════════════════════════════════════════════════════════════════

test('企业确认同样受赛段级名册约束（外队不得被写进本赛段的确认记录）', async () => {
  const { db, close, dataDir, admin } = setup();
  try {
    const stage = makeStage(db, { key: 'S1', name: '调研' });
    registerStageTeamRoster({ db, stageId: stage.id, teamIds: ['t_in'], now: NOW });

    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
    const { token } = createSession(db, admin.id);

    const res = await call(app, 'POST', `/api/stages/${stage.id}/enterprise-confirmations`, {
      token,
      body: {
        teamId: 't_out',
        dimension: 'enterprise',
        rawScore: 80,
        content: '外队确认',
      },
    });
    assert.equal(res.status, 404, `外队的企业确认必须被拒，实际 ${res.status}：${res.body}`);
    // ⚠️ 判据必须是**名册**这个错（TEAM_NOT_IN_STAGE），不能是别的 404/403：
    //    权限不足也是 404/403 ⇒ 只断言状态码会「因错误的理由通过」
    //    （本条第一版就踩了：管理员没被认成组委会 ⇒ 先撞 403 FORBIDDEN ⇒ 名册检查根本没跑到）。
    const body = JSON.parse(res.body);
    assert.equal(
      body.error?.code ?? body.code,
      'TEAM_NOT_IN_STAGE',
      `必须撞「不在本赛段名册内」这个错，实际：${res.body}`,
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

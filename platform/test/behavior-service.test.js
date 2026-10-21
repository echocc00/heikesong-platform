// platform/test/behavior-service.test.js —— 行为分事件的写入通路（★ 独立通路，与总分隔离）
//
// 规则溯源：
//   - 「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」→ R-STG-04
//   - 反作弊 5 条（签到 0 分 / 纯文字不给分 / 须带版本记录 + 代码仓）→ R-PTS-10
//   - 行为分只做破同分垫底排序，不进总分 → R-PTS-08 / S10 §3.3
//   - 权限模型 = capability + assignment，can() 是唯一判定入口
//
// ⛔ 分值【不】由提交方给定：一律取 rules/behavior-points.json 里该类型的分值（防篡改）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { createTaskPackage, updateTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertRegistration } from '../src/db/repo/registrations.js';
import { getLeaderboard } from '../src/services/leaderboard.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const GOOD = {
  direction: [4, 4, 4, 4, 5], capability: [4, 4, 4, 4, 5], collaboration: [4, 4, 4, 4, 5],
  open: '我想解决门店排班问题', consent: { accepted: true },
};
const WEEKLY_EVIDENCE = { repo: 'git@example.com:team/repo', version: 'v1.2.0', artifact: 'demo.zip' };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-beh-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2099-12-31',
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900008001', password: 'pw', mbaStatus: 'other' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', submittedBy: enterprise.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  const captain = createUser(db, { name: '队长甲', phone: '13900008002', password: 'pw', mbaStatus: 'mba' });
  const captainB = createUser(db, { name: '队长乙', phone: '13900008005', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '路人', phone: '13900008003', password: 'pw', mbaStatus: 'mba' });
  const admin = createUser(db, { name: '组委会', phone: '13900008004', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);

  insertRegistration(db, {
    editionId: edition.id, userId: captain.id, answers: GOOD, rawScore: 80,
    level: 'S', status: 'submitted', now: NOW,
  });

  insertCapability(db, 'team:create', '创建战队');
  insertCapability(db, 'behavior:write', '提交行为分记录');
  grantAssignment(db, {
    userId: captain.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: captain.id, capability: 'behavior:write', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, edition, pkg, captain, captainB, outsider, admin,
    tokenCaptain: createSession(db, captain.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

async function createTeam(s, name = '甲队') {
  const res = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

test('★ 提交合规证据 → 200 + 落库 + 分值取自规则（不给提交方自报分）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const res = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      token: s.tokenCaptain,
      body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE, points: 99 },
    });
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).points, 2, 'weekly_progress = 2 分（规则值），提交方传的 99 必须被忽略');

    const rows = s.db.prepare('SELECT * FROM behavior_events WHERE team_id = ?').all(team.id);
    assert.equal(rows.length, 1, '要落一条事件');
    assert.equal(rows[0].points, 2, '落库的分值也必须是规则值（防篡改）');
    assert.equal(rows[0].type, 'weekly_progress');
    assert.equal(rows[0].user_id, s.captain.id);
    assert.ok(rows[0].evidence.includes('v1.2.0'), '证据要留痕');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 纯文字进度 / 缺必填证据 → 400 拒收（不给分、不落库）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const cases = [
      ['纯文字说明', { repo: 'git@example.com:team/repo', version: 'v1', note: '我们做了很多工作' }, 'EVIDENCE_REJECTED'],
      ['缺 version', { repo: 'git@example.com:team/repo', artifact: 'demo.zip' }, 'EVIDENCE_REJECTED'],
      ['缺 repo', { version: 'v1', artifact: 'demo.zip' }, 'EVIDENCE_REJECTED'],
      ['既无产物也无阻塞点', { repo: 'git@example.com:team/repo', version: 'v1' }, 'EVIDENCE_REJECTED'],
      ['证据不是对象', '就是一段纯文字', 'EVIDENCE_REJECTED'],
    ];
    for (const [label, evidence] of cases) {
      const res = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
        token: s.tokenCaptain, body: { type: 'weekly_progress', evidence },
      });
      assert.equal(res.status, 400, `${label} 必须被拒收，实际 ${res.status}`);
      assert.equal(JSON.parse(res.body).error.code, 'EVIDENCE_REJECTED');
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n, 0, '一条都不能落库');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 未知事件类型 → 400（未知类型不给分，也不静默接受）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const res = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      token: s.tokenCaptain, body: { type: 'daily_checkin', evidence: { repo: 'x', version: 'v1', artifact: 'a' } },
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, 'UNKNOWN_EVENT_TYPE');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 无 behavior:write 能力 → 403；未登录 → 401；未知队伍 → 404', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const forbidden = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      token: s.tokenOutsider, body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(JSON.parse(forbidden.body).error.code, 'FORBIDDEN');

    const anon = await call(s.app, 'POST', `/api/teams/${team.id}/behavior-events`, {
      body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(anon.status, 401);

    const noTeam = await call(s.app, 'POST', '/api/teams/t_nope/behavior-events', {
      token: s.tokenCaptain, body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(noTeam.status, 404);
    assert.equal(JSON.parse(noTeam.body).error.code, 'TEAM_NOT_FOUND');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 端到端：API 提交的事件真的进了破同分链的 behavior 级（同分时行为分高的排前）', async () => {
  const s = setup();
  try {
    const teamA = await createTeam(s, '甲队');
    // 第二支队：换队长建（一个账号不能同时在两支队 —— team_members.user_id 唯一）
    s.db.prepare(`INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
      VALUES ('t_b', ?, '乙队', ?, ?, 'D', 'active', ?)`)
      .run(s.edition.id, s.captainB.id, s.pkg.id, NOW);
    s.db.prepare("INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES ('tm_b','t_b',?,'captain',?)")
      .run(s.captainB.id, NOW);

    // 赛段：两队总分完全相同（90 : 90）→ 破同分链只能落到 behavior / team_id
    s.db.prepare(`INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
      VALUES ('st_1', ?, 'S1', '调研赛段', 'initial', '2026-10-01', '2026-10-10', '2026-10-11', 'initial', 'closed')`).run(s.edition.id);
    s.db.prepare(`INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
      VALUES ('sr_a','st_1',?,1,90,90,90,1,NULL,NULL,?), ('sr_b','st_1','t_b',1,90,90,90,1,NULL,NULL,?)`)
      .run(teamA.id, NOW, NOW);

    const before = getLeaderboard({ db: s.db, stageId: 'st_1', scope: 'rank', viewer: null });
    assert.deepEqual(before.rows.map((r) => r.teamId), [teamA.id, 't_b'], '同分时先按 team_id 码位序');

    // 走**写入通路**给甲队提交一条合规周进度（2 分）
    const res = await call(s.app, 'POST', `/api/teams/${teamA.id}/behavior-events`, {
      token: s.tokenCaptain, body: { type: 'weekly_progress', evidence: WEEKLY_EVIDENCE },
    });
    assert.equal(res.status, 200, res.body);

    const after = getLeaderboard({ db: s.db, stageId: 'st_1', scope: 'rank', viewer: null });
    assert.deepEqual(after.rows.map((r) => r.teamId), [teamA.id, 't_b'], '行为分高的甲队排到前面（破同分生效）');
    assert.deepEqual(after.rows.map((r) => r.rank), [1, 2], '行为分把并列拆开');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

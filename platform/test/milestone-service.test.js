// platform/test/milestone-service.test.js —— 企业里程碑签字的写入通路
//
// 规则溯源：
//   - 「里程碑清单在报名（组队）时固定，之后不可自行新增」→ R-STG-03 / R-PTS-10
//   - 「企业签字里程碑」→ R-ENT-02（S10 §4 商业里程碑 7 类）
//   - 「签字须写清解决哪个环节 / 落地时间 / 我方角色」→ R-JDG-14
//   - 「S 段只认企业业务部门签字」→ R-PTS-03
//   - 权限模型 = capability + assignment，can() 是唯一判定入口
//
// ⛔ 本表与 P2 的 enterprise_confirmations 是两张不同的表：
//    这里签的是「这件事到底发生了没有」（客观事实，不进总分）。
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
import { computeTeamTier } from '../src/services/tier.js';
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

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-ms-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2099-12-31',
  });
  const enterprise = createUser(db, { name: '某企业', phone: '13900007001', password: 'pw', mbaStatus: 'other' });
  const captain = createUser(db, { name: '队长甲', phone: '13900007002', password: 'pw', mbaStatus: 'mba' });
  const seat = createUser(db, { name: '企业席乙', phone: '13900007003', password: 'pw', mbaStatus: 'other' });
  const seat2 = createUser(db, { name: '企业席丙', phone: '13900007004', password: 'pw', mbaStatus: 'other' });
  const admin = createUser(db, { name: '组委会', phone: '13900007005', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);
  // ⚠️ **夹具按生产口径造**（2026-10-23 审计 F30 修完后）：
  //    企业席提交任务卡 ⇒ `task_packages.enterprise_id` = 提交人自己（企业主体）。
  //    原来 enterprise_id 留空、submitted_by 指向「某企业」⇒
  //    那是一张**无主卡** + 一个**不相干的企业**在签字 ⇒ 既测不出「跨企业」，
  //    也不符合 F31 修完后的生产口径 ⇒ 夹具更新（保持判别性：seed 那条用例
  //    现在断言的正是「出题企业本人签字成功 / 他企签字 403」）。
  const pkg = createTaskPackage(db, {
    editionId: edition.id, title: '门店排班优化', painPoint: 'p', expectedDelivery: 'd',
    acceptanceCriteria: 'a', enterpriseId: seat.id, enterpriseName: '某零售',
    submittedBy: seat.id, now: NOW,
  });
  updateTaskPackage(db, pkg.id, { solvability_grade: 'A', solvability_score: 11, status: 'published' });

  insertRegistration(db, {
    editionId: edition.id, userId: captain.id, answers: GOOD, rawScore: 80,
    level: 'S', status: 'submitted', now: NOW,
  });

  insertCapability(db, 'team:create', '创建战队');
  insertCapability(db, 'signoff:create', '企业里程碑签字');
  grantAssignment(db, {
    userId: captain.id, capability: 'team:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: seat.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: seat2.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, edition, pkg, captain, seat, seat2, admin,
    tokenCaptain: createSession(db, captain.id).token,
    tokenSeat: createSession(db, seat.id).token,
    tokenSeat2: createSession(db, seat2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
  };
}

async function createTeam(s) {
  const res = await call(s.app, 'POST', '/api/teams', {
    token: s.tokenCaptain, body: { editionId: s.edition.id, taskPackageId: s.pkg.id, name: '甲队' },
  });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
}

test('★ R-STG-03：建队时里程碑清单落表（7 类，固定不可自行新增）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const rows = s.db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY key ASC').all(team.id);
    const expected = s.rules.milestones.items.map((i) => i.key).sort();
    assert.deepEqual(rows.map((r) => r.key), expected, '里程碑清单必须与规则一致（7 类）');
    assert.equal(rows.length, s.rules.milestones.items.length);
    for (const r of rows) {
      assert.equal(r.counts_toward_tier, 1, '7 类都计入段位里程碑数');
      assert.equal(r.requires_signoff, 1, '都要有确认才算达成');
      assert.equal(r.stage_id, null, '里程碑属于整届，不是某个赛段');
      assert.ok(r.fixed_at, '要有固定时间（防拆单刷里程碑）');
    }
    // 清单本身仍来自 teams.milestones_json（两处同源）
    const stored = JSON.parse(s.db.prepare('SELECT milestones_json FROM teams WHERE id = ?').get(team.id).milestones_json);
    assert.deepEqual(stored.items.map((i) => i.key).sort(), expected, '清单仍是报名时固定的那份');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 他企不得给本队里程碑签字（跨企业伪造客观事实 ⇒ 403）', async () => {
  // ⚠️ 2026-10-23 审计 F30：签字是「**客观事实**」⇒ 被 `services/tier.js`
  //    当成有效事实消费（business_signoff_count 影响段位）⇒ 他企签了就是「替别人抬段位」。
  //    口径与「企业确认」端点（routes/review.js 的 N03 闸）同源：
  //    出题企业本人 / 同一企业（org 相同）才可签，组委会可代签。
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? AND key = 'problem_confirmed'").get(team.id);
    assert.ok(ms, '要有该里程碑');

    // seat2 是**另一个企业席**（卡是 seat 出的）⇒ 不得签字
    const res = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat2, body: { department: '业务部门', content: '确认已落地' },
    });
    assert.equal(res.status, 403, `他企签字必须被拒，实际 ${res.status}：${res.body}`);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs WHERE milestone_id = ?').get(ms.id).n, 0,
      '伪造的签字不得落库',
    );

    // 对照组：出题企业本人签字必须成功（不能靠「一律拒」骗绿）
    const ok = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认已落地' },
    });
    assert.equal(ok.status, 200, `出题企业本人签字必须成功：${ok.body}`);
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 企业签字 → 里程碑达成 → 段位从 D 升到 C（事实确认进段位）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? AND key = 'problem_confirmed'").get(team.id);
    assert.ok(ms, '要有该里程碑');

    const before = computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false });
    assert.equal(before.tier, 'D', '没签字前没有达成 → D 段');

    const res = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认问题在排班环节，我方负责接口对接，落地时间 11 月' },
    });
    assert.equal(res.status, 200, res.body);

    const signoffs = s.db.prepare('SELECT * FROM milestone_signoffs WHERE milestone_id = ?').all(ms.id);
    assert.equal(signoffs.length, 1, '要写一条签字');
    assert.equal(signoffs[0].department, '业务部门');
    assert.equal(signoffs[0].enterprise_id, s.seat.id, 'enterprise_id = 签字的企业席账号');
    assert.equal(signoffs[0].revoked_at, null);

    const after = computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false });
    assert.equal(after.milestoneCount, 1, '1 个里程碑达成');
    assert.equal(after.tier, 'C', '有 1 个达成 → C 段');
    assert.equal(after.businessSignoffCount, 1, '业务部门签字计入业务签字数');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 无 signoff:create 能力的人签字 → 403（能力点必须真的被校验）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? LIMIT 1").get(team.id);
    const res = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenCaptain, body: { department: '业务部门', content: '我自己签自己' },
    });
    assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs').get().n, 0, '拒绝后不得留下签字');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 签字缺内容 / 缺部门 → 400（R-JDG-14：签字必须写清内容）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? LIMIT 1").get(team.id);
    const noContent = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '   ' },
    });
    assert.equal(noContent.status, 400);
    assert.equal(JSON.parse(noContent.body).error.code, 'MISSING_CONTENT');
    const noDept = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { content: '有内容没部门' },
    });
    assert.equal(noDept.status, 400);
    assert.equal(JSON.parse(noDept.body).error.code, 'MISSING_DEPARTMENT');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs').get().n, 0);
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 签一个不存在的里程碑 → 404', async () => {
  const s = setup();
  try {
    const res = await call(s.app, 'POST', '/api/milestones/ms_nope/signoff', {
      token: s.tokenSeat, body: { department: '业务部门', content: '内容内容内容内容内容' },
    });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.code, 'MILESTONE_NOT_FOUND');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 撤回签字 → 里程碑回到未达成（段位由重算体现降档）', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? AND key = 'problem_confirmed'").get(team.id);
    const signed = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认问题在排班环节，落地时间 11 月' },
    });
    assert.equal(signed.status, 200, signed.body);
    const signoffId = JSON.parse(signed.body).id;
    assert.equal(computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false }).tier, 'C');

    const wd = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat, body: { signoffId },
    });
    assert.equal(wd.status, 200, wd.body);
    const row = s.db.prepare('SELECT * FROM milestone_signoffs WHERE id = ?').get(signoffId);
    assert.ok(row.revoked_at, '撤回 = 软删除（置 revoked_at），不物理删除');

    const after = computeTeamTier({ db: s.db, teamId: team.id, now: NOW, rules: s.rules, record: false });
    assert.equal(after.milestoneCount, 0, '撤回后不再算达成');
    assert.equal(after.tier, 'D', '段位回到 D');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 不能撤回别的企业的签字 → 403；重复撤回 → 409', async () => {
  const s = setup();
  try {
    const team = await createTeam(s);
    const ms = s.db.prepare("SELECT * FROM milestones WHERE team_id = ? LIMIT 1").get(team.id);
    const signed = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff`, {
      token: s.tokenSeat, body: { department: '业务部门', content: '确认问题在排班环节，落地时间 11 月' },
    });
    const signoffId = JSON.parse(signed.body).id;

    const other = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat2, body: { signoffId },
    });
    assert.equal(other.status, 403, '只能撤回本企业自己的签字');
    assert.equal(JSON.parse(other.body).error.code, 'NOT_YOUR_SIGNOFF');

    const first = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat, body: { signoffId },
    });
    assert.equal(first.status, 200);
    const again = await call(s.app, 'POST', `/api/milestones/${ms.id}/signoff/withdraw`, {
      token: s.tokenSeat, body: { signoffId },
    });
    assert.equal(again.status, 409);
    assert.equal(JSON.parse(again.body).error.code, 'ALREADY_REVOKED');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('★ 未登录签字 → 401', async () => {
  const s = setup();
  try {
    const res = await call(s.app, 'POST', '/api/milestones/ms_x/signoff', {
      body: { department: '业务部门', content: '内容内容内容内容' },
    });
    assert.equal(res.status, 401);
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

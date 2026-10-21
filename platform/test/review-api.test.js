// platform/test/review-api.test.js —— 评审 API 的权限闸门
//
// 规则溯源：
//   - 「权限模型 = capability + assignment，can() 是唯一判定入口」→ 设计文档 §7.1/§7.2
//   - 「三态状态码」→ 设计文档 §7.3（禁用 → 403；单条不存在 → 404）
//   - 「回避必须留档、不能代他人申报」→ S7 §2.4 R5（R-JDG-09）
//   - 「企业签字必须有内容 + 双签」→ S7 §4.1（R-JDG-06 / R-JDG-14）
//   - 「自评不加分、只能本队提交」→ S7 §4.3（R-JDG-13）
//
// ⚠️ 这些闸门一旦没有测试钉住，就会**静默失效**（能力点形同虚设、越权可写入分数）——
//    与 P1 Task 3 的 A1（registration:write 被注册却从不校验）同一类病根。
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
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['peer_review:write', '互评'],
  ['self_review:write', '提交本队自评'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['signoff:create', '企业签字'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-revapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000041', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000042', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000043', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900000044', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000045', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000046', password: 'pw' });
  const enterprise2 = createUser(db, { name: '别家企业', phone: '13900000048', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(judge.id, 'audit:read');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(captain.id, 'self_review:write');
  grant(captain.id, 'peer_review:write');
  // 企业席要 score:write（企业确认就是企业席分）+ signoff:create（证明是出题企业）
  // —— 与 seed 的 enterprise 角色一致
  grant(enterprise.id, 'score:write');
  grant(enterprise.id, 'signoff:create');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  // 第二支队的任务包属于**别家企业** —— 用来验「企业只能给自己出的题签字」
  const pkg2 = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise2.id, enterpriseName: '别家企业',
    title: '门店排班', painPoint: '排班靠人肉',
    expectedDelivery: '可用的排班建议', acceptanceCriteria: '能给出人力节省测算',
    submittedBy: admin.id, now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg2.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: captain.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, judge, judge2, admin, enterprise, enterprise2, captain, outsider, team1, team2, stage,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenCaptain: createSession(db, captain.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

test('未登录提交评分 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('有能力点但**不是**该赛段评委 → 403（NOT_ASSIGNED_JUDGE）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('评委提交打分 → 200', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).submitted, 1);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能代他人申报回避（打分 sabotage）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenJudge,
    body: { judgeId: s.judge2.id, teamId: s.team1.id, reason: '投资方' },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 确认没有落库
  const rows = s.db.prepare('SELECT * FROM recusal_records WHERE stage_id = ?').all(s.stage.id);
  assert.equal(rows.length, 0, '被拒绝的回避申报不得留下记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('评委为自己申报回避 → 200（本人可申报）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenJudge,
    body: { teamId: s.team1.id, reason: '前雇主' },
  });
  assert.equal(res.status, 200);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能冒名签企业确认（企业项占初赛 10% / 决赛 25% 权重）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenJudge,
    body: {
      teamId: s.team1.id, enterpriseId: s.enterprise.id, rawScore: 100,
      crossJudgeId: s.judge2.id, content: '我们认可这支队伍',
    },
  });
  assert.equal(res.status, 403);
  const rows = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ?').all(s.stage.id);
  assert.equal(rows.length, 0, '被拒绝的企业确认不得落库');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('出题企业为自己签确认 → 200；跨领域评委不在名单 → 404', async () => {
  const s = setup();
  const bad = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, rawScore: 90,
      crossJudgeId: s.captain.id, content: '解决了我方库存周转环节',
    },
  });
  assert.equal(bad.status, 404, '跨领域评委必须在本赛段名单里');
  assert.equal(JSON.parse(bad.body).error.code, 'JUDGE_NOT_ASSIGNED');

  const ok = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '解决了我方库存周转环节',
    },
  });
  assert.equal(ok.status, 200);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能替别的队伍交自评（自评加分路径）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/self-review`, {
    token: s.tokenJudge,
    body: { teamId: s.team1.id, items: [{ dimension: 'self_eval', rawScore: 95 }] },
  });
  assert.equal(res.status, 403, '评委连自评能力点都没有，先被能力点拦下');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 队长不能替别的队伍交自评', async () => {
  const s = setup();
  const other = insertTeam(s.db, {
    editionId: s.stage.edition_id, name: '二队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/self-review`, {
    token: s.tokenCaptain,
    body: { teamId: other.id, items: [{ dimension: 'self_eval', rawScore: 95 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_TEAM_MEMBER');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('队长为本队交自评 → 200', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/self-review`, {
    token: s.tokenCaptain,
    body: { teamId: s.team1.id, items: [{ dimension: 'self_eval', rawScore: 90 }] },
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).submitted, 1);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 互评必须由本队成员发起', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/peer-reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ fromTeamId: '别人的队', toTeamId: s.team1.id, score: 80 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_TEAM_MEMBER');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('compute 权限：评委 403 / 组委会 200', async () => {
  const s = setup();
  const denied = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenJudge });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.body).error.code, 'FORBIDDEN');

  const allowed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
  assert.equal(allowed.status, 200);
  const body = JSON.parse(allowed.body);
  assert.ok(body.computationId);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 计算快照不得跨赛段读取（404）', async () => {
  const s = setup();
  const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
  const computationId = JSON.parse(computed.body).computationId;

  const other = insertStage(s.db, {
    editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-11-01', endsAt: '2026-11-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  const res = await call(s.app, 'GET', `/api/stages/${other.id}/computations/${computationId}`, {
    token: s.tokenAdmin,
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'COMPUTATION_NOT_FOUND');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 跨领域评委不能与出题企业签字人相同（双签必须真是两个人）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, rawScore: 90,
      crossJudgeId: s.enterprise.id, content: '自己给自己当跨领域评委',
    },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'CROSS_JUDGE_SAME_AS_SIGNATORY');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('赛段级作用域授权可用（不只是全局授权）', async () => {
  const s = setup();
  // 另建一个赛段 + 一个只在 s1 上有 score:write 授权的评委
  const scopedJudge = createUser(s.db, { name: '赛段评委', phone: '13900000047', password: 'pw' });
  assignStageJudge(s.db, { stageId: s.stage.id, userId: scopedJudge.id, seat: 'judge', now: NOW });
  grantAssignment(s.db, {
    userId: scopedJudge.id, capability: 'score:write', scopeType: 'stage', scopeId: s.stage.id, grantedBy: s.admin.id,
  });
  const token = createSession(s.db, scopedJudge.id).token;

  const ok = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 70 }] },
  });
  assert.equal(ok.status, 200, '赛段级授权必须被认');

  // 换一个赛段 → 该授权不覆盖 → 403
  const other = insertStage(s.db, {
    editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-11-01', endsAt: '2026-11-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  const denied = await call(s.app, 'POST', `/api/stages/${other.id}/reviews`, {
    token,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 70 }] },
  });
  assert.equal(denied.status, 403, '赛段级授权不得跨赛段生效');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('没有能力的账号 → 403（三态：禁用 → 403，不是 404）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenOutsider,
    body: { items: [] },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('⛔ 评委不能以自己名义替别人家的队签企业确认（C1：连坐作废对手的企业席）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenJudge,
    body: {
      teamId: s.team1.id, enterpriseId: s.judge.id, rawScore: 100,
      crossJudgeId: s.judge2.id, content: '我替这家签了',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(
    s.db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE stage_id = ?').get(s.stage.id).n,
    0,
    '被拒绝的冒名确认不得落库（否则会连坐掉受害队伍的企业席）',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 评委不能给名册外的队伍打分（外队进榜）', async () => {
  const s = setup();
  // 另一个届期的队伍：不在本赛段名册内
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(s.db, {
    editionId: otherEdition.id, name: '外队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: outsider.id, dimension: 'innovation', rawScore: 99 }] },
  });
  assert.equal(res.status, 404, '名册外的队伍 → 404（不是 500）');
  assert.equal(JSON.parse(res.body).error.code, 'TEAM_NOT_IN_STAGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 评委不能给自评席维度打分（绕过「自评只能本队成员」）', async () => {
  const s = setup();
  // 决赛权重表里「自评测」是 seat=self 的维度
  const finalStage = insertStage(s.db, {
    editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-11-01', endsAt: '2026-11-10', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(s.db, { stageId: finalStage.id, userId: s.judge.id, seat: 'judge', now: NOW });
  const res = await call(s.app, 'POST', `/api/stages/${finalStage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'self_eval', rawScore: 100 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'DIMENSION_SEAT_FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 回避对象不在本赛段名单 → 404', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenAdmin,
    body: { judgeId: s.outsider.id, teamId: s.team1.id, reason: '投资方' },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'JUDGE_NOT_ASSIGNED');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 有能力点但不是本赛段评委 → 403 NOT_ASSIGNED_JUDGE', async () => {
  const s = setup();
  // 给队长发 score:write：他有能力点，但不是本赛段评委
  insertCapability(s.db, 'score:write', '写入评分');
  grantAssignment(s.db, {
    userId: s.captain.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: s.admin.id,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_ASSIGNED_JUDGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 企业席只能给自己出的题签字（别家企业的队 → 403）', async () => {
  const s = setup();
  // 授予企业席能力（signoff:create）—— 闸门 N02 通过，但 N03（是不是你出的题）不通过
  insertCapability(s.db, 'signoff:create', '企业签字');
  grantAssignment(s.db, {
    userId: s.enterprise.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: s.admin.id,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team2.id, rawScore: 100,
      crossJudgeId: s.judge2.id, content: '我给别家企业的队也签一个',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(
    s.db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE stage_id = ?').get(s.stage.id).n,
    0,
    '被拒绝的确认不得落库',
  );
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 签字人必须与请求里的 enterpriseId 一致（不能顶着别人的名义签）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, enterpriseId: s.enterprise2.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '顶着别家的名义签',
    },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 企业确认不得签名册外的队伍', async () => {
  const s = setup();
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsiderTeam = insertTeam(s.db, {
    editionId: otherEdition.id, name: '外队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: outsiderTeam.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '外队确认',
    },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TEAM_NOT_IN_STAGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 改分必须把旧分写进审计（事后能还原当时榜单）', async () => {
  const s = setup();
  const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 80 }] },
  });
  assert.equal(first.status, 200);
  await call(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenJudge,
    body: { items: [{ teamId: s.team1.id, dimension: 'innovation', rawScore: 85 }] },
  });
  const rows = s.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY rowid').all('review.submit');
  const last = JSON.parse(rows[rows.length - 1].detail_json);
  assert.ok(Array.isArray(last.changed) && last.changed.length === 1, '改分必须留痕');
  assert.equal(last.changed[0].from, 80);
  assert.equal(last.changed[0].to, 85);
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 没有评审权限的人读不到评审进度', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', `/api/stages/${s.stage.id}/review-state`, {
    token: s.tokenOutsider,
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 互评的被评队不在名册内 → 404', async () => {
  const s = setup();
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsiderTeam = insertTeam(s.db, {
    editionId: otherEdition.id, name: '外队', captainId: s.admin.id, status: 'active', now: NOW,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/peer-reviews`, {
    token: s.tokenCaptain,
    body: { items: [{ fromTeamId: s.team1.id, toTeamId: outsiderTeam.id, score: 80 }] },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TEAM_NOT_IN_STAGE');
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 请求里的 signatoryUserId 与出题企业不符 → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.team1.id, signatoryUserId: s.judge2.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '签字人写成了别人',
    },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

test('⛔ 不是企业席的人不能签企业确认（哪怕他就是出题企业）', async () => {
  const s = setup();
  // 一支任务包属于 outsider 的队伍；outsider 有 score:write，但**没有** signoff:create
  const pkg3 = createTaskPackage(s.db, {
    editionId: s.stage.edition_id, enterpriseId: s.outsider.id, enterpriseName: '某企业',
    title: '别的题', painPoint: '痛点',
    expectedDelivery: '交付物', acceptanceCriteria: '验收标准',
    submittedBy: s.admin.id, now: NOW,
  });
  const team3 = insertTeam(s.db, {
    editionId: s.stage.edition_id, name: '三队', captainId: s.admin.id, taskPackageId: pkg3.id, status: 'active', now: NOW,
  });
  insertCapability(s.db, 'score:write', '写入评分');
  grantAssignment(s.db, {
    userId: s.outsider.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: s.admin.id,
  });
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenOutsider,
    body: {
      teamId: team3.id, rawScore: 90,
      crossJudgeId: s.judge2.id, content: '我出的题我签',
    },
  });
  assert.equal(res.status, 403, '不是企业席 → 403');
  assert.equal(
    s.db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations WHERE stage_id = ?').get(s.stage.id).n,
    0,
  );
  s.close();
  rmSync(s.dataDir, { recursive: true });
});

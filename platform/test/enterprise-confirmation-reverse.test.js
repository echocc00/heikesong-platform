// platform/test/enterprise-confirmation-reverse.test.js —— 企业确认的逆向路径（P11 · E141 / E148）
//
// ⛔ **这个文件为什么存在**（E141 / E148 的实测结论）：
//   企业确认（企业席分）一旦落库，产品内**没有任何途径**改动它：
//     · 写端点 `POST /api/stages/:stageId/enterprise-confirmations` 只有正向；
//     · 同格重签撞唯一索引 ⇒ **HTTP 500「服务内部错误」**（E148②，违反设计文档 §7.3）；
//     · 仓储层的 `softDeleteEnterpriseConfirmation` **零调用方** —— 写了没人用。
//   ⇒ 一条「只签了一半」（缺跨领域评委签字 = R2 双签只签一边）的确认，
//     企业席按 R2 **恒计 0 分**并挂 `R2_missing_dual_signature` 告警，
//     而组委会与出题企业**在产品里修不了它** —— 初赛 −8 分、决赛 −20 分（E141 实测）。
//
// ⛔ P11 补的三条能力：
//   ① 同格重签 → 409 CONFIRMATION_EXISTS（不是 500），并告诉客户端「要改请走改签」；
//   ② **改签**（resign）⇒ 软删旧行 + 追加新行（同格），更正内容 / 分数；
//   ③ **R2 后补**（resign 带 crossJudgeId = 自己）⇒ 跨领域评委给自己补上另一半签字。
//   ④ **撤回**（withdraw）⇒ 软删，证据留痕。
//
// 规则溯源：
//   · R2「缺双签按 0 分计 + 记 warning」→ S7 §3.1（**计分口径**，不是写入校验 ⇒ 不在写端点强制）
//   · R-JDG-14「签字必须写明内容」→ S7 §4.1
//   · 「评分/积分类记录只增不改，更正走新记录」→ INTERFACES.md §0
//   · 三态状态码 → 设计文档 §7.3
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
import { insertReview } from '../src/db/repo/reviews.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['signoff:create', '企业签字'],
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-entrev-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900002001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900002002', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900002003', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900002004', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900002005', password: 'pw' });
  const outsider = createUser(db, { name: '无关者', phone: '13900002006', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
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
  insertTeamMember(db, { teamId: team1.id, userId: captain.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  // 评委席打分（让队伍进得了 stage_results，企业席分才有观察面）
  for (const dim of ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']) {
    insertReview(db, {
      stageId: stage.id, judgeId: judge.id, teamId: team1.id, dimension: dim,
      rawScore: 88, requestId: `r-${dim}`, calibrated: 0, now: NOW,
    });
  }

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, admin, judge, judge2, enterprise, captain, outsider, team1, stage,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function json(res) {
  return JSON.parse(res.body);
}

/** 算一次，取该队的企业席分与告警。 */
async function computeTeam(s, teamId) {
  const res = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
  assert.equal(res.status, 200, `计算应成功：${res.body}`);
  const body = json(res);
  const team = body.teams.find((t) => t.teamId === teamId);
  return {
    seatE: team?.seatE ?? null,
    total: team?.total ?? null,
    codes: (body.warnings ?? []).map((w) => w.code),
  };
}

test('⛔ E148②：同格重签必须 409（**不是 500**），且要告诉客户端该走「改签」', async () => {
  const s = setup();
  try {
    const body = { teamId: s.team1.id, rawScore: 90, content: '解决了我方库存周转环节' };
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise, body,
    });
    assert.equal(first.status, 200, `第一次签应成功：${first.body}`);

    // ⛔ 判别点：同格（赛段 + 队伍 + 维度 + 企业）再签一次
    const second = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise, body,
    });
    assert.equal(second.status, 409, `同格重签必须是 409，不是 500：${second.status} ${second.body}`);
    assert.equal(json(second).error.code, 'CONFIRMATION_EXISTS');
    assert.match(json(second).error.message, /改签|撤回/, '错误文案要指向逆向路径');

    // 数据库里仍然只有**一条有效**确认
    const rows = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL').all(s.stage.id);
    assert.equal(rows.length, 1, '同格只能有一条有效确认');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ E141：只签一半 ⇒ 企业席恒 0 分；补签（R2 后补）⇒ 分数回来（这条是整个 E141 的要害）', async () => {
  const s = setup();
  try {
    // ① 出题企业先签（**不带** crossJudgeId ⇒ R2 双签只签了一半）
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, content: '解决了我方库存周转环节' },
    });
    assert.equal(first.status, 200, first.body);
    const confirmationId = json(first).id;

    // ② 半条确认 ⇒ 企业席按 R2 计 0 分，并挂 R2_missing_dual_signature
    const before = await computeTeam(s, s.team1.id);
    assert.equal(before.seatE, 0, '缺双签 ⇒ 企业席按 R2 计 0 分');
    assert.ok(before.codes.includes('R2_missing_dual_signature'), `必须挂 R2 告警：${JSON.stringify(before.codes)}`);

    // ③ 跨领域评委给自己**补签**（R2 后补）—— 这是此前产品里根本不存在的路径
    const backfill = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${confirmationId}/resign`, {
      token: s.tokenJudge,
      body: { crossJudgeId: s.judge.id },
    });
    assert.equal(backfill.status, 200, `补签应成功：${backfill.body}`);
    assert.equal(json(backfill).cross_judge_id, s.judge.id, '新行上要有跨领域评委签字');

    // ④ 重新计算 ⇒ 企业席分回来了，R2 告警消失
    const after = await computeTeam(s, s.team1.id);
    assert.equal(after.seatE, 90, '补签后企业席分必须回到 90（此前恒 0 且修不了）');
    assert.ok(!after.codes.includes('R2_missing_dual_signature'), '补签后 R2 告警必须消失');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ E141：撤回 ⇒ 企业席回到 0 分，证据留痕（软删 + 审计）', async () => {
  const s = setup();
  try {
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, crossJudgeId: s.judge.id, content: '解决了我方库存周转环节' },
    });
    assert.equal(first.status, 200, first.body);
    const confirmationId = json(first).id;

    const before = await computeTeam(s, s.team1.id);
    assert.equal(before.seatE, 90, '双签齐全时企业席分正常');

    const withdrawn = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${confirmationId}/withdraw`, {
      token: s.tokenEnterprise,
    });
    assert.equal(withdrawn.status, 200, `撤回应成功：${withdrawn.body}`);
    assert.equal(json(withdrawn).withdrawn, true);

    const after = await computeTeam(s, s.team1.id);
    assert.equal(after.seatE, 0, '撤回后企业席分必须归零');
    // ⚠️ 判别点：撤回后是「**完全没有**确认」（no_enterprise_confirmation），
    //    与「只签了一半」（R2_missing_dual_signature）是**两种不同的降级** ⇒ 告警码不同。
    assert.ok(after.codes.includes('no_enterprise_confirmation'), `撤回后必须重新挂告警（不是静默）：${JSON.stringify(after.codes)}`);

    // 证据留痕：软删 + 审计日志
    const row = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ?').get(confirmationId);
    assert.ok(row.deleted_at, '撤回是软删：deleted_at 必须有值（事后要能查「签过又撤了」）');
    const audit = s.db.prepare("SELECT * FROM audit_log WHERE action = 'enterprise.confirm.withdraw'").get();
    assert.ok(audit, '撤回必须写审计日志');
    assert.equal(audit.entity_id, s.team1.id);

    // 撤回后不能再改签（已不存在）
    const again = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${confirmationId}/resign`, {
      token: s.tokenEnterprise, body: { content: '换个说法' },
    });
    assert.equal(again.status, 404, '撤回过的确认不可再改签');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 改签 = 软删旧行 + 追加新行（只增不改），同格仍只有一条有效', async () => {
  const s = setup();
  try {
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, crossJudgeId: s.judge.id, content: '原来的说法' },
    });
    assert.equal(first.status, 200, first.body);
    const oldId = json(first).id;

    const resigned = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${oldId}/resign`, {
      token: s.tokenEnterprise,
      body: { rawScore: 70, content: '更正后的说法' },
    });
    assert.equal(resigned.status, 200, `改签应成功：${resigned.body}`);
    const body = json(resigned);
    assert.equal(body.replacedId, oldId, '响应要指明替掉了哪一条');
    assert.equal(body.raw_score, 70);
    assert.equal(body.content, '更正后的说法');
    assert.notEqual(body.id, oldId, '改签产生**新行**（只增不改）');

    const active = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE stage_id = ? AND deleted_at IS NULL').all(s.stage.id);
    assert.equal(active.length, 1, '同格仍只能有一条有效确认');
    const old = s.db.prepare('SELECT * FROM enterprise_confirmations WHERE id = ?').get(oldId);
    assert.ok(old.deleted_at, '旧行必须是软删（历史留痕，不是覆盖）');

    const audit = s.db.prepare("SELECT * FROM audit_log WHERE action = 'enterprise.confirm.resign'").get();
    assert.ok(audit, '改签必须写审计日志');
    const detail = JSON.parse(audit.detail_json);
    assert.equal(detail.replacedId, oldId);
    assert.deepEqual(detail.changes.rawScore, { from: 90, to: 70 }, '审计要记下「改了什么」');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 逆向路径的权限闸：外人 403；签字企业能改内容但不能冒别人的名；跨领域评委不能改内容', async () => {
  const s = setup();
  try {
    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, content: '原始说法' },
    });
    const id = json(first).id;

    // ① 无关的人既不能撤也不能改
    const outsiderWithdraw = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/withdraw`, { token: s.tokenOutsider });
    assert.equal(outsiderWithdraw.status, 403, '无关者不能撤回');
    const outsiderResign = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenOutsider, body: { content: '我要改' },
    });
    assert.equal(outsiderResign.status, 403, '无关者不能改签');

    // ② 本赛段评委**不能**改内容与分数（那是出题企业的主张），但**能**给自己补签
    const judgeContent = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenJudge, body: { content: '评委改内容' },
    });
    assert.equal(judgeContent.status, 403, '评委不能改企业确认的内容');
    const judgeBackfill = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenJudge, body: { crossJudgeId: s.judge.id },
    });
    assert.equal(judgeBackfill.status, 200, '本赛段评委可以给自己补签');

    // ③ 评委不能替**别人**补签
    const otherBackfill = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${json(judgeBackfill).id}/resign`, {
      token: s.tokenJudge, body: { crossJudgeId: s.judge2.id },
    });
    assert.equal(otherBackfill.status, 403, '不能替别人补签');

    // ④ 补签的人不能是别的赛段的评委 / 不能与出题企业同一人
    const sameAsEnterprise = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${json(judgeBackfill).id}/resign`, {
      token: s.tokenEnterprise, body: { crossJudgeId: s.enterprise.id },
    });
    assert.equal(sameAsEnterprise.status, 400, '跨领域评委不能与出题企业同一人');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 逆向路径的三态：不存在的确认 → 404；跨赛段取用 → 404；没改任何东西 → 400', async () => {
  const s = setup();
  try {
    const missing = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/nope/withdraw`, { token: s.tokenEnterprise });
    assert.equal(missing.status, 404, '不存在的确认 → 404');
    assert.equal(json(missing).error.code, 'CONFIRMATION_NOT_FOUND');

    const first = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
      token: s.tokenEnterprise,
      body: { teamId: s.team1.id, rawScore: 90, content: '原始说法' },
    });
    const id = json(first).id;

    // 换个赛段取用 → 404（不泄露「这条存在」）
    const otherStage = insertStage(s.db, {
      editionId: s.stage.edition_id, key: 's2', name: '决赛', kind: 'final',
      startsAt: '2026-10-11', endsAt: '2026-10-20', scoringConfigKey: 'final', status: 'open', now: NOW,
    });
    const crossStage = await call(s.app, 'POST', `/api/stages/${otherStage.id}/enterprise-confirmations/${id}/withdraw`, { token: s.tokenEnterprise });
    assert.equal(crossStage.status, 404, '跨赛段取用 → 404');

    // 什么都没改 → 400（不发空转的审计）
    const noop = await call(s.app, 'POST', `/api/stages/${s.stage.id}/enterprise-confirmations/${id}/resign`, {
      token: s.tokenEnterprise, body: { rawScore: 90, content: '原始说法' },
    });
    assert.equal(noop.status, 400, '没有变更 → 400');
    assert.equal(json(noop).error.code, 'NOTHING_TO_CHANGE');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

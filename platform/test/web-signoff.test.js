// platform/test/web-signoff.test.js —— 企业签字台（里程碑签字 + 企业双签）的行为闸
//
// 规则溯源：
//   - 「企业确认 = 双签（出题企业签字 + ≥1 名跨领域评委签字），缺双签按 0 分计」
//     → R-JDG-06（R2）/ S7 §2.4 / src/domain/enterprise-seat.js applyEnterpriseRules
//   - 「企业确认的第二个签字人不能与出题企业签字人相同」
//     → src/http/routes/review.js 的 CROSS_JUDGE_SAME_AS_SIGNATORY（400）
//   - 「签字必须写清解决哪个环节 / 落地时间 / 我方角色」→ R-JDG-14
//   - 「签字不公开」→ R-ENT-04（API 与界面都不回传签字人姓名）
//   - 「撤回是软删除，撤回后回到未达成」→ src/services/milestone.js withdrawSignoff
//   - 「错误态必须带真能点的重试」→ DP-80；「不许整页刷新 / 不许冲掉已填内容」→ DP-81
//   - 「可见性在 API 层过滤，前端只判登录态」→ DP-77 / 全局约束
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js + 机器闸
//
// ⚠️ **全部是行为断言**：断言的是**纯函数的返回值**与**真实发出去的请求**
//   （路径 + 请求体），不是「源码里有没有某个字符串」——
//   字符串断言会被无关代码顶替（前面轮次吃过这个亏）。
//
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

import {
  signoffWorklistItems,
  signoffFormState,
  buildWithdrawPayload,
  enterpriseConfirmRows,
  crossJudgeCandidates,
  enterpriseConfirmFormState,
  enterpriseConfirmPayload,
  signoffWorklistHtml,
  enterpriseConfirmHtml,
  signoffPageHtml,
  renderSignoff,
  seatLabel,
} from '../web/views/signoff.js';

// ── 后端（两个新读端点）的真实装配：跑 app.handle → 路由 → 鉴权 ──────────
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerSignoffRoutes } from '../src/http/routes/signoff.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertMilestones } from '../src/db/repo/tiers.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { callJson } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW_JS = readFileSync(join(here, '..', 'web', 'views', 'signoff.js'), 'utf8');

// ══════════════════════════════════════════════════════════════════
// 零、DOM 桩（最小：没有真 DOM、没有 IntersectionObserver）
// ══════════════════════════════════════════════════════════════════

/** 造一个最小元素桩：只实现视图用到的那几个方法。 */
function makeEl(tag = 'div') {
  return {
    tagName: tag,
    className: '',
    innerHTML: '',
    value: '',
    dataset: {},
    hidden: false,
    _listeners: {},
    _nodes: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of this._listeners[type] || []) fn(event);
    },
    querySelector(sel) {
      return this._nodes[sel] ?? null;
    },
    querySelectorAll(sel) {
      const v = this._nodes[sel];
      return Array.isArray(v) ? v : (v ? [v] : []);
    },
    closest() {
      return null;
    },
    focus() {},
  };
}

/** 造一个假按钮（click 事件的目标）。 */
function fakeButton(dataset) {
  const btn = { dataset, closest: () => btn };
  return btn;
}

/** 让微任务/宏任务队列跑干净（视图里的提交是异步的）。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// ── 后端装配 ────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = join(here, '..', 'db', 'migrations');
const RULES_DIR = join(here, '..', 'rules');
const WEB_DIR = join(here, '..', 'web');
const API_NOW = '2026-10-20T12:00:00.000Z';

/**
 * 造一套「两家出题企业 + 两名跨领域评委 + 组委会 + 无权限者」的最小现场。
 *
 * ⚠️ 两家企业的任务包**必须分开**（enterpriseId 不同）：
 *    否则「企业席只看得到自己出题的队」这条可见性判据测不出来
 *    （一家企业出题 ⇒ 两支队都归它 ⇒ 过滤看起来「没生效」其实生效了）。
 */
function setupApi() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-signoff-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, MIGRATIONS_DIR);
  const { rules } = loadRules(RULES_DIR);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: API_NOW,
  });
  const enterprise = createUser(db, { name: '甲企业', phone: '13900000071', password: 'pw' });
  const enterprise2 = createUser(db, { name: '乙企业', phone: '13900000072', password: 'pw' });
  const judge1 = createUser(db, { name: '评委甲', phone: '13900000073', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000074', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000075', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000076', password: 'pw' });

  for (const [key, desc] of [
    ['signoff:create', '企业签字'],
    ['score:write', '写入评分'],
    ['stage:compute', '触发计算发榜'],
  ]) insertCapability(db, key, desc);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(enterprise.id, 'signoff:create');
  grant(enterprise.id, 'score:write');
  grant(admin.id, 'signoff:create');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');

  const pkgMine = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '甲企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: API_NOW,
  });
  const pkgOther = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise2.id, enterpriseName: '乙企业',
    title: '门店选址', painPoint: '选址靠拍脑袋',
    expectedDelivery: '选址评分模型', acceptanceCriteria: '能给出选址命中率',
    submittedBy: admin.id, now: API_NOW,
  });
  const teamMine = insertTeam(db, {
    editionId: edition.id, name: '拾光队', captainId: judge1.id,
    taskPackageId: pkgMine.id, status: 'active', now: API_NOW,
  });
  const teamOther = insertTeam(db, {
    editionId: edition.id, name: '长风队', captainId: judge2.id,
    taskPackageId: pkgOther.id, status: 'active', now: API_NOW,
  });
  insertMilestones(db, {
    teamId: teamMine.id,
    items: [
      { key: 'problem_confirmed', label: '企业问题确认', countsTowardTier: true },
      { key: 'demo_ready', label: '可演示原型', countsTowardTier: true },
    ],
    now: API_NOW,
  });
  insertMilestones(db, {
    teamId: teamOther.id,
    items: [{ key: 'problem_confirmed', label: '企业问题确认', countsTowardTier: true }],
    now: API_NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: API_NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge1.id, seat: 'judge', now: API_NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: API_NOW });

  const app = createApp({ db, rules, webDir: WEB_DIR });
  // ⚠️ createApp 还没接本模块的路由（**路由接线由集成者做**）⇒ 这里手动挂上，
  //    免得「测试通过」只是因为「端点没注册」。
  registerSignoffRoutes(app.router);

  return {
    db, close, dataDir, app, rules, edition, stage,
    enterprise, enterprise2, judge1, judge2, admin, outsider,
    teamMine, teamOther,
    milestones: db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY rowid').all(teamMine.id),
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenEnterprise2: createSession(db, enterprise2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function teardownApi(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════
// 一、里程碑签字台：三态分组与字段恒定
// ══════════════════════════════════════════════════════════════════

const WORKLIST = {
  scope: 'enterprise',
  items: [
    {
      milestoneId: 'm_pending', teamId: 't_a', teamName: '拾光队',
      key: 'problem_confirmed', label: '企业问题确认', countsTowardTier: true,
      signed: false, signoffId: null, signedAt: null, department: null, content: null,
      revokedAt: null, signedByMe: false, canWithdraw: false,
    },
    {
      milestoneId: 'm_signed', teamId: 't_a', teamName: '拾光队',
      key: 'data_connected', label: '真实数据接入', countsTowardTier: true,
      signed: true, signoffId: 's_1', signedAt: '2026-10-20T04:00:00.000Z',
      department: '业务部', content: '已接入门店实时库存',
      revokedAt: null, signedByMe: true, canWithdraw: true,
    },
    {
      milestoneId: 'm_revoked', teamId: 't_b', teamName: '长风队',
      key: 'pilot_contract', label: '试点合同', countsTowardTier: true,
      signed: false, signoffId: 's_2', signedAt: '2026-10-19T04:00:00.000Z',
      department: '业务部', content: '试点合同已签',
      revokedAt: '2026-10-21T04:00:00.000Z', signedByMe: true, canWithdraw: false,
    },
  ],
};

test('★ 分组：待签 / 已签 / 已撤回 三组各归其位', () => {
  const groups = signoffWorklistItems(WORKLIST);
  assert.deepEqual(groups.pending.map((x) => x.milestoneId), ['m_pending']);
  assert.deepEqual(groups.signed.map((x) => x.milestoneId), ['m_signed']);
  assert.deepEqual(groups.revoked.map((x) => x.milestoneId), ['m_revoked']);
  assert.equal(groups.pending.length + groups.signed.length + groups.revoked.length, 3);
});

test('★ 字段恒定：每一项的字段集合一致，且不出现 undefined', () => {
  const groups = signoffWorklistItems(WORKLIST);
  const keys = [
    'milestoneId', 'teamId', 'teamName', 'key', 'label', 'countsTowardTier',
    'signed', 'signoffId', 'signedAt', 'department', 'content', 'revokedAt',
    'signedByMe', 'canWithdraw',
  ];
  for (const group of [groups.pending, groups.signed, groups.revoked]) {
    for (const row of group) {
      assert.deepEqual(Object.keys(row).sort(), [...keys].sort(), '字段集合必须恒定');
      for (const k of keys) {
        assert.notEqual(row[k], undefined, `${k} 不许是 undefined`);
      }
    }
  }
});

test('缺字段 / 空输入也不许抛，也不许出 undefined', () => {
  const empty = signoffWorklistItems(null);
  assert.deepEqual(empty, { pending: [], signed: [], revoked: [] });
  const partial = signoffWorklistItems({ items: [{ milestoneId: 'm_x' }] });
  assert.equal(partial.pending.length, 1);
  assert.equal(partial.pending[0].teamName, '');
  assert.equal(partial.pending[0].signoffId, null);
  assert.equal(partial.pending[0].canWithdraw, false);
});

// ══════════════════════════════════════════════════════════════════
// 二、提交载荷：字段名必须与后端 body 逐字一致
// ══════════════════════════════════════════════════════════════════

test('★ 里程碑签字载荷：字段名是 department / content（抄错就是 400）', () => {
  const built = signoffFormState({ values: { department: '业务部', content: '解决了库存周转' } });
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.payload, { department: '业务部', content: '解决了库存周转' });
  assert.deepEqual(Object.keys(built.payload).sort(), ['content', 'department']);
});

test('里程碑签字：部门或内容为空 ⇒ 不组装请求（payload 为 null），并给出字段级错误', () => {
  const noDept = signoffFormState({ values: { department: '  ', content: 'x' } });
  assert.equal(noDept.payload, null);
  assert.equal(noDept.errors.length, 1);
  assert.equal(noDept.errors[0].field, 'department');

  const noContent = signoffFormState({ values: { department: '业务部', content: '' } });
  assert.equal(noContent.payload, null);
  assert.equal(noContent.errors[0].field, 'content');
});

test('撤回载荷：字段名是 signoffId（后端读的是 ctx.body.signoffId）', () => {
  const built = buildWithdrawPayload({ signoffId: 's_1' });
  assert.deepEqual(built.payload, { signoffId: 's_1' });
  assert.deepEqual(Object.keys(built.payload), ['signoffId']);
  const bad = buildWithdrawPayload({ signoffId: '' });
  assert.equal(bad.payload, null);
  assert.equal(bad.errors[0].field, 'signoffId');
});

test('★ 企业双签载荷：teamId / dimension / rawScore / content / crossJudgeId', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a',
    dimension: 'enterprise',
    rawScore: '88',
    content: '解决了库存周转环节',
    crossJudgeId: 'u_judge1',
  });
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.payload, {
    teamId: 't_a',
    dimension: 'enterprise',
    rawScore: 88,
    content: '解决了库存周转环节',
    crossJudgeId: 'u_judge1',
  });
});

test('企业双签：不带 signatoryUserId（后端会把它设成 enterpriseId，前端多传反而 403）', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: 'u_judge1',
  });
  assert.equal('signatoryUserId' in built.payload, false);
});

test('★ 企业双签：没填分 ⇒ 报错（空串会被 Number 当成 0 分提交出去）', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '',
    content: 'x', crossJudgeId: 'u_judge1',
  });
  assert.equal(built.payload, null);
  assert.equal(built.errors[0].field, 'rawScore');
});

test('企业双签：分数越界 / 非数字 ⇒ 报错（0–100 百分制）', () => {
  for (const bad of ['101', '-1', 'abc']) {
    const built = enterpriseConfirmPayload({
      teamId: 't_a', dimension: 'enterprise', rawScore: bad,
      content: 'x', crossJudgeId: 'u_judge1',
    });
    assert.equal(built.payload, null, `${bad} 必须被拦`);
    assert.equal(built.errors.some((e) => e.field === 'rawScore'), true);
  }
});

test('★ 企业双签：没选跨领域评委 ⇒ 不许提交（双签制，缺第二签就是白签）', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: '',
  });
  assert.equal(built.payload, null);
  assert.equal(built.errors.some((e) => e.field === 'crossJudgeId'), true);
});

test('企业双签：组委会代录时才带 enterpriseId', () => {
  const withEnt = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: 'u_judge1', enterpriseId: 'u_enterprise1',
  });
  assert.equal(withEnt.payload.enterpriseId, 'u_enterprise1');
  const without = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: 'u_judge1',
  });
  assert.equal('enterpriseId' in without.payload, false);
});

test('企业双签表单初值：字段恒定，不出现 undefined', () => {
  const state = enterpriseConfirmFormState(null);
  assert.deepEqual(state, {
    teamId: '', dimension: '', rawScore: '', content: '', crossJudgeId: '',
  });
  for (const v of Object.values(state)) assert.notEqual(v, undefined);
});

// ══════════════════════════════════════════════════════════════════
// 三、企业双签清单：「还缺哪一签」
// ══════════════════════════════════════════════════════════════════

const BOARD = {
  stage: { id: 'stage_final', key: 'final', name: '决赛赛段' },
  scope: 'enterprise',
  myEnterpriseId: 'u_enterprise1',
  dimensions: [{ key: 'enterprise', name: '企业确认', weight: 0.25, seat: 'enterprise' }],
  teams: [
    { teamId: 't_a', teamName: '拾光队', taskPackageTitle: '库存周转', enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true },
    { teamId: 't_b', teamName: '长风队', taskPackageTitle: '门店选址', enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true },
    { teamId: 't_c', teamName: '自由组', taskPackageTitle: '自由命题', enterpriseId: null, isFreeBrief: true, canSign: true },
  ],
  confirmations: [
    { id: 'c_1', teamId: 't_a', enterpriseId: 'u_enterprise1', dimension: 'enterprise', rawScore: 82, hasCrossJudge: true, signedAt: '2026-10-20T04:00:00.000Z', content: 'x' },
    { id: 'c_2', teamId: 't_b', enterpriseId: 'u_enterprise1', dimension: 'enterprise', rawScore: 70, hasCrossJudge: false, signedAt: '2026-10-20T05:00:00.000Z', content: 'y' },
  ],
  crossJudgeCandidates: [
    { userId: 'u_enterprise1', name: '我自己（企业席）', seat: 'enterprise' },
    { userId: 'u_judge1', name: '李评委', seat: 'judge' },
    { userId: 'u_judge2', name: '王评委', seat: 'judge' },
  ],
};

test('★ 双签缺口：已签但没带跨领域评委 ⇒ 判定缺 crossJudge 这一签', () => {
  const rows = enterpriseConfirmRows(BOARD);
  const rowB = rows.find((r) => r.teamId === 't_b');
  assert.equal(rowB.signed, true, 't_b 已确认');
  assert.equal(rowB.hasCrossJudge, false);
  assert.deepEqual(rowB.missing, ['crossJudge']);
});

test('双签缺口：双签齐全 ⇒ 不缺任何一签', () => {
  const rowA = enterpriseConfirmRows(BOARD).find((r) => r.teamId === 't_a');
  assert.deepEqual(rowA.missing, []);
  assert.equal(rowA.rawScore, 82);
  assert.equal(rowA.signedAt, '2026-10-20T04:00:00.000Z');
});

test('双签缺口：完全没确认 ⇒ 缺 enterprise 这一签', () => {
  const rowC = enterpriseConfirmRows(BOARD).find((r) => r.teamId === 't_c');
  assert.equal(rowC.signed, false);
  assert.deepEqual(rowC.missing, ['enterprise']);
});

test('双签缺口：别家企业签的不算这条队的确认（R1 口径：非本赛道签字不算数）', () => {
  const raw = {
    ...BOARD,
    confirmations: [
      { id: 'c_9', teamId: 't_a', enterpriseId: 'u_other', dimension: 'enterprise', rawScore: 99, hasCrossJudge: true, signedAt: 'x', content: 'x' },
    ],
  };
  const row = enterpriseConfirmRows(raw).find((r) => r.teamId === 't_a');
  assert.equal(row.signed, false, '别家企业签的不能算本赛道企业的确认');
  assert.deepEqual(row.missing, ['enterprise']);
});

test('双签清单行：字段恒定，不出现 undefined', () => {
  for (const row of enterpriseConfirmRows(BOARD)) {
    for (const v of Object.values(row)) assert.notEqual(v, undefined, `${row.teamId} 的字段不许是 undefined`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 四、跨领域评委候选：必须剔除「我自己」
// ══════════════════════════════════════════════════════════════════

test('★ 候选里没有我自己（选了就是 400 CROSS_JUDGE_SAME_AS_SIGNATORY）', () => {
  const candidates = crossJudgeCandidates(BOARD);
  assert.deepEqual(candidates.map((c) => c.userId), ['u_judge1', 'u_judge2']);
  assert.equal(candidates.some((c) => c.userId === 'u_enterprise1'), false);
});

test('候选剔除：组委会代录时还要剔除被代签的那家企业', () => {
  const candidates = crossJudgeCandidates(BOARD, { signatoryId: 'u_judge1' });
  assert.deepEqual(candidates.map((c) => c.userId), ['u_judge2']);
});

test('候选字段恒定', () => {
  for (const c of crossJudgeCandidates(BOARD)) {
    assert.deepEqual(Object.keys(c).sort(), ['name', 'seat', 'userId']);
  }
});

test('席别标签：认不出来的值原样透出（不猜、不吞）', () => {
  assert.equal(seatLabel('judge'), '专家席');
  assert.equal(seatLabel('weird'), 'weird');
  assert.equal(seatLabel(null), '');
});

// ══════════════════════════════════════════════════════════════════
// 五、转义闸：服务端数据里的 HTML 必须被转义
// ══════════════════════════════════════════════════════════════════

test('★ 转义闸：服务端数据里的 <script> 不得变成真标签', () => {
  const raw = {
    scope: 'enterprise',
    items: [{
      milestoneId: 'm_x', teamId: 't_x',
      teamName: '<script>alert(1)</script>',
      key: 'k', label: '<img src=x onerror=alert(2)>',
      countsTowardTier: true, signed: true, signoffId: 's_x',
      signedAt: '2026-10-20T04:00:00.000Z', department: '<b>业务部</b>',
      content: '</textarea><script>alert(3)</script>',
      revokedAt: null, signedByMe: true, canWithdraw: true,
    }],
  };
  const html = signoffWorklistHtml({ raw });
  assert.ok(!html.includes('<script>'), '服务端数据里的 <script> 不得原样进 HTML');
  assert.ok(!html.includes('<img src=x'), '服务端数据里的标签不得原样进 HTML');
  assert.ok(!html.includes('</textarea><script>'), '不得借 textarea 提前闭合');
  assert.ok(html.includes('&lt;script&gt;'), '必须转义成实体');
});

test('★ 转义闸：企业双签清单里的队名 / 任务包同样要转义', () => {
  const raw = {
    ...BOARD,
    teams: [{ teamId: 't_x', teamName: '<script>alert(1)</script>', taskPackageTitle: '"><b>x', enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true }],
  };
  const html = enterpriseConfirmHtml({ board: raw, stages: [], stageId: 'stage_final' });
  assert.ok(!html.includes('<script>'), '服务端数据里的 <script> 不得原样进 HTML');
  assert.ok(html.includes('&lt;script&gt;'));
});

// ══════════════════════════════════════════════════════════════════
// 六、渲染态：加载 / 错误（带重试）/ 空态（带下一步）
// ══════════════════════════════════════════════════════════════════

test('加载态：用 loadingState（有 aria-live，不是一片空白）', () => {
  const html = signoffWorklistHtml({ loading: true });
  assert.ok(html.includes('state--loading'));
  assert.ok(html.includes('aria-live="polite'));
});

test('★ 错误态必须带真能点的重试（DP-80），并标出重试的是哪一块', () => {
  const html = signoffWorklistHtml({ error: '缺少能力：signoff:create' });
  assert.ok(html.includes('state--error'));
  assert.ok(html.includes('data-action="retry"'), '错误态必须带重试按钮');
  assert.ok(html.includes('data-retry-kind="worklist"'), '必须标明重试的是签字清单');
  assert.ok(html.includes('缺少能力'));
});

test('★ 空态必须给可点的下一步（不是死路一条）', () => {
  const html = signoffWorklistHtml({ raw: { items: [] } });
  assert.ok(html.includes('state--empty'));
  assert.ok(html.includes('href="#/team"'), '空态必须给出可点的下一步');
});

test('企业双签区块：没有可用的跨领域评委 ⇒ 明确说清楚（双签凑不齐）并禁用提交', () => {
  const raw = { ...BOARD, crossJudgeCandidates: [{ userId: 'u_enterprise1', name: '我自己', seat: 'enterprise' }] };
  const html = enterpriseConfirmHtml({ board: raw, stages: [], stageId: 'stage_final' });
  assert.ok(html.includes('没有可用的跨领域评委'));
  assert.ok(html.includes('disabled'), '没有第二签字人时提交按钮必须禁用');
});

// ══════════════════════════════════════════════════════════════════
// 七、DOM 桩上的真实交互（路径 + 请求体都断言）
// ══════════════════════════════════════════════════════════════════

/** 造一个可记录调用的 api 桩。 */
function makeApi({ failGet = false, worklist = WORKLIST, board = BOARD, stages = [{ id: 'stage_final', name: '决赛赛段' }] } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      if (failGet) throw new Error('接口挂了');
      if (path === '/api/signoffs/mine') return worklist;
      if (path === '/api/stages') return { items: stages };
      if (path.endsWith('/enterprise-confirmations')) return board;
      throw new Error(`未预期的 GET：${path}`);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      return { ok: true };
    },
  };
}

/** 装上全局 document 桩，并返回「视图根元素」的取法。 */
function installDom() {
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
  };
  return created;
}

test('★ DOM 桩：视图在最小桩上不抛，且渲染出清单', async () => {
  const created = installDom();
  const api = makeApi();
  const view = await renderSignoff({ api, params: { stageId: 'stage_final' } });
  assert.ok(view, '必须返回元素');
  const html = created[0].innerHTML;
  assert.ok(html.includes('企业签字台'));
  assert.ok(html.includes('企业问题确认'), '待签项要渲染出来');
  assert.ok(html.includes('拾光队'));
  // 三组标题都在
  assert.ok(html.includes('待签') && html.includes('已签') && html.includes('已撤回'));
});

test('★ DOM 桩：接口失败 ⇒ 渲染带重试的错误态（不是白屏）', async () => {
  const created = installDom();
  const api = makeApi({ failGet: true });
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const html = created[0].innerHTML;
  assert.ok(html.includes('state--error'), '必须有错误态');
  assert.ok(html.includes('data-action="retry"'), '错误态必须带可点的重试');
  assert.ok(html.includes('企业签字台'), '页头还在（不是白屏）');
});

test('★ DOM 桩：提交成功后重新拉清单（断言真的又 GET 了一次）', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];
  const before = api.calls.filter((c) => c.method === 'GET' && c.path === '/api/signoffs/mine').length;

  root._nodes['[data-signoff="department"][data-milestone="m_pending"]'] = { value: '业务部' };
  root._nodes['[data-signoff="content"][data-milestone="m_pending"]'] = { value: '已确认门店需求' };
  root._nodes['[data-feedback="signoff:m_pending"]'] = { innerHTML: '' };

  root.dispatch('click', {
    target: fakeButton({ action: 'signoff-submit', milestone: 'm_pending' }),
  });
  await flush();

  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/milestones/m_pending/signoff');
  assert.ok(post, '必须真的发了签字请求');
  assert.deepEqual(post.body, { department: '业务部', content: '已确认门店需求' });
  const after = api.calls.filter((c) => c.method === 'GET' && c.path === '/api/signoffs/mine').length;
  assert.ok(after > before, '提交成功后必须重新拉清单');
});

test('★ DOM 桩：撤回请求的路径与请求体（signoffId）都对', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];
  root._nodes['[data-feedback="withdraw:m_signed"]'] = { innerHTML: '' };

  root.dispatch('click', {
    target: fakeButton({ action: 'withdraw-confirm', milestone: 'm_signed', signoff: 's_1' }),
  });
  await flush();

  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/milestones/m_signed/signoff/withdraw');
  assert.ok(post, '必须发撤回请求');
  assert.deepEqual(post.body, { signoffId: 's_1' });
});

test('★ DOM 桩：企业双签提交 —— 路径与请求体逐字对后端', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];

  root._nodes['[data-confirm="team"]'] = { value: 't_a' };
  root._nodes['[data-confirm="dimension"]'] = { value: 'enterprise' };
  root._nodes['[data-confirm="rawScore"]'] = { value: '88' };
  root._nodes['[data-confirm="content"]'] = { value: '解决了库存周转环节' };
  root._nodes['[data-confirm="crossJudge"]'] = { value: 'u_judge1' };
  root._nodes['[data-feedback="confirm"]'] = { innerHTML: '' };

  root.dispatch('click', { target: fakeButton({ action: 'confirm-submit' }) });
  await flush();

  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/stages/stage_final/enterprise-confirmations');
  assert.ok(post, '必须发企业确认请求');
  assert.deepEqual(post.body, {
    teamId: 't_a',
    dimension: 'enterprise',
    rawScore: 88,
    content: '解决了库存周转环节',
    crossJudgeId: 'u_judge1',
  });
});

test('★ DOM 桩：企业双签缺跨领域评委 ⇒ 不发请求（本地拦下）', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];

  root._nodes['[data-confirm="team"]'] = { value: 't_a' };
  root._nodes['[data-confirm="dimension"]'] = { value: 'enterprise' };
  root._nodes['[data-confirm="rawScore"]'] = { value: '88' };
  root._nodes['[data-confirm="content"]'] = { value: 'x' };
  root._nodes['[data-confirm="crossJudge"]'] = { value: '' };
  root._nodes['[data-feedback="confirm"]'] = { innerHTML: '' };

  root.dispatch('click', { target: fakeButton({ action: 'confirm-submit' }) });
  await flush();

  assert.equal(
    api.calls.some((c) => c.method === 'POST' && c.path.includes('enterprise-confirmations')),
    false,
    '缺第二签时不该发请求',
  );
});

// ══════════════════════════════════════════════════════════════════
// 八、撤回是破坏性动作：渲染出的 HTML 里必须有确认环节
// ══════════════════════════════════════════════════════════════════

test('★ 撤回是破坏性动作 ⇒ 渲染出的 HTML 里必须带二次确认', () => {
  const html = signoffWorklistHtml({ raw: WORKLIST });
  // 撤回入口
  assert.ok(html.includes('data-action="withdraw"'), '必须有撤回入口');
  // 二次确认环节（默认 hidden，点第一次才展开）
  assert.ok(html.includes('data-action="withdraw-confirm"'), '必须有确认撤回这一步');
  assert.ok(html.includes('data-action="withdraw-cancel"'), '必须能取消');
  assert.ok(html.includes('data-needs-confirm="true"'), '撤回入口必须标出需要二次确认');
  assert.ok(html.includes('hidden'), '确认区默认收起');
  // 后果说明
  assert.ok(html.includes('未达成'), '必须说清撤回的后果（回到未达成、段位重算降档）');
});

test('★ 撤回的二次确认区是「点了才展开」（默认 hidden）', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];
  const box = { hidden: true, querySelector: () => null };
  root._nodes['[data-confirm="withdraw"][data-milestone="m_signed"]'] = box;

  root.dispatch('click', {
    target: fakeButton({ action: 'withdraw', milestone: 'm_signed', signoff: 's_1' }),
  });
  await flush();

  assert.equal(box.hidden, false, '点「撤回」必须展开确认区');
  assert.equal(
    api.calls.some((c) => c.method === 'POST'),
    false,
    '展开确认区不许发请求（破坏性动作不能一按就发）',
  );
});

// ══════════════════════════════════════════════════════════════════
// 九、纪律闸
// ══════════════════════════════════════════════════════════════════

test('机器闸：不给 noticeState 传 text（它只认 items / list）', () => {
  assert.ok(!/noticeState\(\{[^}]*\btext\s*:/.test(VIEW_JS), 'noticeState 的参数名必须叫 items');
});

test('机器闸：视图里不许出现字面色值（颜色只能走 token）', () => {
  const code = VIEW_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), '视图里不许写十六进制色值');
  assert.ok(!/rgba?\(/.test(code), '视图里不许写 rgb/rgba 色值');
});

test('机器闸：不许整页刷新（DP-81）', () => {
  assert.ok(!/location\.reload/.test(VIEW_JS), '不许整页刷新');
});

test('机器闸：整页渲染时服务端数据里的标签一律不得原样出现', () => {
  const hostile = {
    scope: 'enterprise',
    items: [{
      milestoneId: 'm_x', teamId: 't_x',
      teamName: '<script>alert(1)</script>',
      key: '<b>k</b>', label: '<img src=x onerror=alert(2)>',
      countsTowardTier: true, signed: true, signoffId: 's_x',
      signedAt: '2026-10-20T04:00:00.000Z', department: '<b>业务部</b>',
      content: '</textarea><script>alert(3)</script>',
      revokedAt: null, signedByMe: true, canWithdraw: true,
    }],
  };
  const html = signoffPageHtml({
    worklist: hostile,
    board: {
      ...BOARD,
      teams: [{
        teamId: 't_x', teamName: '<script>alert(4)</script>', taskPackageTitle: '"><b>x',
        enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true,
      }],
    },
    stages: [{ id: 's_x', name: '<script>alert(5)</script>' }],
    stageId: 's_x',
  });
  assert.ok(!/<script/i.test(html), '整页里不许出现真 <script> 标签');
  assert.ok(!/<img\s/i.test(html), '整页里不许出现真 <img> 标签（转义后只剩文本）');
  // ⚠️ 「onerror=」这串**文本**仍会出现在输出里（它是数据的一部分，被转义成普通文本，
  //    不会成为属性）⇒ 断言的是「没有真标签」，不是「字符串消失」。
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), '数据必须被转义成文本节点');
});

test('机器闸：视图里不许出现硬编码的赛制数字（分值区间常量除外）', () => {
  const code = VIEW_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 25% / 10% 这类权重不许出现在前端（一切来自后端）。
  assert.ok(!/25%|10%/.test(code), '前端不许硬编码赛制权重');
});

// ══════════════════════════════════════════════════════════════════
// 十、两个新读端点（API 层）：可见性 / 三态状态码 / 字段形状
//
// ⚠️ 这两个端点是**前端能点得到**的前提：
//   - GET /api/signoffs/mine                    → 给 milestoneId + signoffId
//   - GET /api/stages/:stageId/enterprise-confirmations → 给 crossJudgeId 的候选
//   ⇒ 「界面有了但端点是坏的」= 假完成 ⇒ 这里跑真实的应用装配（app.handle → 路由 → 鉴权）。
// ══════════════════════════════════════════════════════════════════

test('API：未登录读签字台 → 401', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine');
  assert.equal(res.status, 401);
  teardownApi(s);
});

test('API：没有 signoff:create 的人读签字台 → 403（不是 200 空集）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'FORBIDDEN');
  teardownApi(s);
});

test('★ API：企业席只看得到**自己出题**队伍的里程碑（可见性在 API 层过滤）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise });
  assert.equal(res.status, 200);
  assert.equal(res.json.scope, 'enterprise');
  const teams = [...new Set(res.json.items.map((x) => x.teamId))];
  assert.deepEqual(teams, [s.teamMine.id], '别家企业出题的队不许出现在企业席的清单里');
  assert.equal(res.json.items.length, s.milestones.length);
  // 字段恒定：前端要靠 milestoneId / signoffId 调写端点
  for (const item of res.json.items) {
    assert.ok(item.milestoneId, '必须给 milestoneId（写端点的路径参数）');
    assert.equal(item.signoffId, null, '还没签 ⇒ signoffId 必须是 null');
    assert.equal(item.signed, false);
    assert.equal('signatoryName' in item, false, '签字人不公开（R-ENT-04）');
  }
  teardownApi(s);
});

test('★ API：签完字之后，清单里能拿到 signoffId（撤回报文要用）', async () => {
  const s = setupApi();
  const mid = s.milestones[0].id;
  const sign = await callJson(s.app, 'POST', `/api/milestones/${mid}/signoff`, {
    token: s.tokenEnterprise,
    body: { department: '业务部', content: '已确认门店需求' },
  });
  assert.equal(sign.status, 200);
  const list = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise });
  const item = list.json.items.find((x) => x.milestoneId === mid);
  assert.equal(item.signed, true);
  assert.ok(item.signoffId, '签完必须有 signoffId');
  assert.equal(item.canWithdraw, true);
  assert.equal(item.department, '业务部');

  // 撤回（破坏性动作）→ 再读一次，状态变「已撤回」
  const wd = await callJson(s.app, 'POST', `/api/milestones/${mid}/signoff/withdraw`, {
    token: s.tokenEnterprise,
    body: { signoffId: item.signoffId },
  });
  assert.equal(wd.status, 200);
  const after = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise });
  const item2 = after.json.items.find((x) => x.milestoneId === mid);
  assert.equal(item2.signed, false, '撤回后不是「已签」');
  assert.ok(item2.revokedAt, '撤回后必须能看到撤回时间');
  teardownApi(s);
});

test('API：读企业双签清单 —— 未登录 401 / 赛段不存在 404 / 无权限 403', async () => {
  const s = setupApi();
  const path = `/api/stages/${s.stage.id}/enterprise-confirmations`;
  assert.equal((await callJson(s.app, 'GET', path)).status, 401);
  assert.equal((await callJson(s.app, 'GET', '/api/stages/no_such_stage/enterprise-confirmations', { token: s.tokenEnterprise })).status, 404);
  assert.equal((await callJson(s.app, 'GET', path, { token: s.tokenOutsider })).status, 403);
  teardownApi(s);
});

test('★ API：企业双签清单只含自己能签的队，且跨领域评委候选不含自己', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.teams.map((t) => t.teamId), [s.teamMine.id], '只含自己出题的队');
  assert.equal(res.json.myEnterpriseId, s.enterprise.id);
  assert.equal(
    res.json.crossJudgeCandidates.some((c) => c.userId === s.enterprise.id),
    false,
    '候选里不能有我自己（后端会 400 CROSS_JUDGE_SAME_AS_SIGNATORY）',
  );
  assert.ok(res.json.crossJudgeCandidates.length > 0, '必须能选出不是我的人，否则双签永远凑不齐');
  // 企业确认维度来自规则表（不写死）
  assert.ok(res.json.dimensions.length > 0, '必须给出企业确认维度（前端据此组装 dimension）');
  assert.equal(res.json.dimensions[0].seat, 'enterprise');
  teardownApi(s);
});

test('★ API：双签提交之后，清单里能看出「双签齐全」', async () => {
  const s = setupApi();
  const path = `/api/stages/${s.stage.id}/enterprise-confirmations`;
  const before = await callJson(s.app, 'GET', path, { token: s.tokenEnterprise });
  assert.equal(before.json.confirmations.length, 0);
  const candidate = before.json.crossJudgeCandidates[0];
  const post = await callJson(s.app, 'POST', path, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.teamMine.id,
      dimension: before.json.dimensions[0].key,
      rawScore: 88,
      content: '解决了库存周转环节',
      crossJudgeId: candidate.userId,
    },
  });
  assert.equal(post.status, 200);
  const after = await callJson(s.app, 'GET', path, { token: s.tokenEnterprise });
  assert.equal(after.json.confirmations.length, 1);
  assert.equal(after.json.confirmations[0].hasCrossJudge, true, '必须能看出带了跨领域评委签字');
  assert.equal(after.json.confirmations[0].rawScore, 88);
  teardownApi(s);
});

test('★ API：组委会能看到全部队伍的清单（代录视角）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenAdmin,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.scope, 'committee');
  const teams = res.json.teams.map((t) => t.teamId).sort();
  assert.deepEqual(teams, [s.teamMine.id, s.teamOther.id].sort(), '组委会看得到全部队伍');
  teardownApi(s);
});

test('★ API：授权在**届期作用域**上也放行（与写端点同一口径：scopeType=edition）', async () => {
  const s = setupApi();
  // ⚠️ 用**没有任何授权**的另一家企业来测（否则全局授权会把届期作用域的效果盖掉）：
  //   只给「signoff:create」且作用域是 edition（不是 global）。
  const before = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise2 });
  assert.equal(before.status, 403, '没有授权 ⇒ 403（不是 200 空集）');
  grantAssignment(s.db, {
    userId: s.enterprise2.id,
    capability: 'signoff:create',
    scopeType: 'edition',
    scopeId: s.edition.id,
    grantedBy: s.admin.id,
  });
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise2 });
  assert.equal(res.status, 200, '届期作用域授权也要放行（否则出现「写端点能签、列表却 403」）');
  assert.deepEqual(
    [...new Set(res.json.items.map((x) => x.teamId))],
    [s.teamOther.id],
    '只看到自己出题的队',
  );
  teardownApi(s);
});

test('★ API：组委会读签字台 ⇒ 看得到全部队伍的里程碑（代录 / 核查视角）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(res.json.scope, 'committee');
  const teams = [...new Set(res.json.items.map((x) => x.teamId))].sort();
  assert.deepEqual(teams, [s.teamMine.id, s.teamOther.id].sort(), '组委会看得到全部队伍');
  teardownApi(s);
});

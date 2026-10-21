// platform/test/workflow-e2e.test.js —— P5 Task 6 端到端验收 + 前端任务清单页
//
// 规则溯源：
//   - R-OPS-13 任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成
//   - R-OPS-14 禁止岗位制：任务**只能自主领取**（⛔ 页面不得出现指派 / 按岗位分工的控件）
//   - 「前端只渲染，不做过滤」→ 可见性在 API 层完成（设计文档 §6.6）——前端隐藏 = 数据已泄露
//
// ⚠️ 本文件覆盖**三块**（计划原块只覆盖第 ① 块）：
//   ① 后端闭环：建工作流 → 建任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜
//   ② 前端视图的**纯函数**：三段分类 / 可用操作 / 行内容（P1 的 web/views/*.js 同款做法）
//   ③ 前端**接线**：web/app.js 注册了 /tasks/:workflowId 且把路由参数透传给视图
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { createPublicToken } from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';
import { stripComments } from '../test-helpers/strip-comments.js';
import {
  classifyTasks, taskMode, taskActions, buildTaskItem, buildTaskSections,
} from '../web/views/tasks.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });

  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000041', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_b', '乙', '13900000042', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_admin', '组委会', '13900000043', 'x', 'mba', '组委会', 1, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_admin', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_b', 'tp_1', 'D', 'active', '2026-10-01T00:00:00.000Z', NULL);
    -- ⚠️ P1 建了部分唯一索引 idx_team_members_active(user_id) WHERE left_at IS NULL：
    --    「同一人只能同时在一个战队」，所以 u_b 只能在一支队里
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'u_b', 'captain', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL);
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z');
  `);

  return { db, close, dataDir, app };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

test('端到端：工作流 → 任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜单', async () => {
  const { db, close, dataDir, app } = setup();
  const member = createSession(db, 'u_a', { ttlDays: 1 });
  const admin = createSession(db, 'u_admin', { ttlDays: 1 });

  // ① 工作流（任务包 → 工作流）
  const wfRes = await call(app, 'POST', '/api/workflows', {
    token: member.token,
    body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '风控助手工作流' },
  });
  assert.equal(wfRes.status, 200, wfRes.body);
  const workflowId = JSON.parse(wfRes.body).workflow.id;

  // ② 任务清单（工作流 → 任务）
  const taskRes = await call(app, 'POST', `/api/workflows/${workflowId}/tasks`, {
    token: member.token,
    body: { title: '跑通风控模型', detail: '需要一个可演示的 demo', ownerTeamId: 'tm_1', dueAt: '2026-10-12' },
  });
  assert.equal(taskRes.status, 200, taskRes.body);
  const taskId = JSON.parse(taskRes.body).task.id;

  // ③ 看到任务清单
  const listRes = await call(app, 'GET', `/api/workflows/${workflowId}/tasks`, { token: member.token });
  assert.equal(listRes.status, 200);
  const tasks = JSON.parse(listRes.body).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'todo');
  assert.equal(tasks[0].claim, null);

  // ④ 自主领取
  const claimRes = await call(app, 'POST', `/api/tasks/${taskId}/claim`, {
    token: member.token, body: { teamId: 'tm_1' },
  });
  assert.equal(claimRes.status, 200, claimRes.body);
  assert.equal(JSON.parse(claimRes.body).task.status, 'in_progress');

  // ⑤ 再领一次 → 409（同一任务不能被两个人领取）
  const again = await call(app, 'POST', `/api/tasks/${taskId}/claim`, {
    token: member.token, body: { teamId: 'tm_1' },
  });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(again.body).error.code, 'TASK_ALREADY_CLAIMED');

  // ⑥ 纯文字进度说明 → 400
  const bad = await call(app, 'POST', `/api/tasks/${taskId}/complete`, {
    token: member.token, body: { evidence: { summary: '今天还在弄' } },
  });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error.code, 'EVIDENCE_REQUIRED');

  // ⑦ 带可运行证据完成
  const done = await call(app, 'POST', `/api/tasks/${taskId}/complete`, {
    token: member.token,
    body: { evidence: { kind: 'runnable', summary: '跑通了', artifactUrl: 'https://git.example.com/demo/risk', version: 'v0.1' } },
  });
  assert.equal(done.status, 200, done.body);
  assert.equal(JSON.parse(done.body).task.status, 'done');

  // ⑧ 同步三池
  const syncRes = await call(app, 'POST', '/api/pools/sync', {
    token: admin.token, body: { editionId: 'ed_1' },
  });
  assert.equal(syncRes.status, 200, syncRes.body);
  const sync = JSON.parse(syncRes.body);
  assert.equal(sync.talents.total, 1, '人才池里应该有一个人');

  // ⑨ 人才池读回：积分终生累计
  const talentsRes = await call(app, 'GET', '/api/pools/talents?editionId=ed_1', { token: admin.token });
  assert.equal(talentsRes.status, 200);
  const talents = JSON.parse(talentsRes.body).talents;
  assert.equal(talents.length, 1);
  assert.equal(talents[0].userId, 'u_a');
  assert.equal(talents[0].totalPoints, 10);

  // ⑩ 公开 API 拉榜单（无需登录，带 token）
  // ⚠️ 有效期给到 2099：这个用例走真实时钟，避免"计划隔年执行就必然过期"的时间炸弹
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2099-01-01T00:00:00.000Z', now: '2026-10-20T00:00:00.000Z',
  });
  const pub = await call(app, 'GET', `/api/public/leaderboard?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(pub.status, 200, pub.body);
  const payload = JSON.parse(pub.body);
  const names = payload.stages.flatMap((s) => s.rows.map((r) => r.teamName));
  assert.ok(names.includes('一队'), 'C 段队伍应公示');
  assert.equal(names.includes('二队'), false, 'D 段队伍不公示');
  assert.equal(pub.body.includes('某银行'), false, '企业名不公示');
  assert.equal(pub.body.includes('u_admin'), false, '不泄露内部身份');

  // ⑪ 无 token → 403
  const noToken = await call(app, 'GET', '/api/public/leaderboard?editionId=ed_1');
  assert.equal(noToken.status, 403);

  cleanup(db, close, dataDir);
});

// ── 以下为 P5 Task 6 实跑后补齐的用例（计划原块只覆盖后端闭环，
//    前端任务清单页与 web/app.js 的接线**零覆盖**）──

const TASKS = [
  { id: 't1', title: '没人领的任务', detail: '', status: 'todo', claim: null },
  { id: 't2', title: '我领的', detail: '细节', status: 'in_progress', claim: { userId: 'u_a', teamId: 'tm_1' } },
  { id: 't3', title: '别人领的', detail: '', status: 'in_progress', claim: { userId: 'u_b', teamId: 'tm_2' } },
  { id: 't4', title: '做完了', detail: '', status: 'done', claim: { userId: 'u_a', teamId: 'tm_1' }, completedAt: '2026-10-12T00:00:00.000Z' },
];

test('★ 三段分类：可领取的 / 我领取的 / 已完成的', () => {
  const s = classifyTasks(TASKS, 'u_a');
  assert.deepEqual(s.claimable.map((t) => t.id), ['t1']);
  assert.deepEqual(s.mine.map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(s.done.map((t) => t.id), ['t4']);
});

test('★ 前端不做可见性过滤：每个任务都落进且只落进一段，一个都不丢', () => {
  // ⛔ 「前端隐藏 = 数据已泄露」—— 可见性在 API 层完成。
  //    前端只能**重新分桶**，不能少给一条：少给一条 = 用户看不到自己有权看的任务。
  const s = classifyTasks(TASKS, 'u_a');
  assert.equal(s.claimable.length + s.mine.length + s.done.length, TASKS.length);
  const ids = [...s.claimable, ...s.mine, ...s.done].map((t) => t.id).sort();
  assert.deepEqual(ids, TASKS.map((t) => t.id).sort());
  // 换个登录人，分桶跟着变，但**条数不变**
  const other = classifyTasks(TASKS, 'u_b');
  assert.equal(other.claimable.length + other.mine.length + other.done.length, TASKS.length);
});

test('★ 任务模式：未领=可领取 / 本人领=mine / 他人领=taken / 已完成=done', () => {
  assert.equal(taskMode(TASKS[0], 'u_a'), 'claimable');
  assert.equal(taskMode(TASKS[1], 'u_a'), 'mine');
  assert.equal(taskMode(TASKS[2], 'u_a'), 'taken');
  assert.equal(taskMode(TASKS[3], 'u_a'), 'done');
  assert.equal(taskMode(TASKS[2], 'u_b'), 'mine', '同一个人看自己的任务就是 mine');
});

test('★ R-OPS-14：任务只有一个入口 —— 自主领取；⛔ 没有任何指派 / 按岗位分工的操作', () => {
  assert.deepEqual(taskActions(TASKS[0], 'u_a'), ['claim'], '未领取的任务只有「自主领取」');
  assert.deepEqual(taskActions(TASKS[1], 'u_a'), ['complete', 'release'], '本人领的：可提交完成 / 可释放');
  assert.deepEqual(taskActions(TASKS[2], 'u_a'), [], '别人领的：不可动');
  assert.deepEqual(taskActions(TASKS[3], 'u_a'), [], '已完成的：不可动');
  // ⛔ 白名单：任何模式下都不得出现「指派 / 按岗位」类操作
  const allowed = new Set(['claim', 'complete', 'release']);
  for (const t of TASKS) {
    for (const me of ['u_a', 'u_b', null]) {
      for (const a of taskActions(t, me)) {
        assert.ok(allowed.has(a), `出现了计划外的操作「${a}」`);
      }
    }
  }
});

test('★ 视图源码里没有任何指派 / 岗位控件（剥掉注释后扫）', () => {
  const src = stripComments(readFileSync(join(here, '..', 'web', 'views', 'tasks.js'), 'utf8'));
  for (const word of ['指派', 'assign', 'Assign', '岗位分工', '<select', 'role=']) {
    assert.equal(
      src.includes(word),
      false,
      `任务清单页不得出现「${word}」（R-OPS-14：任务只能自主领取）`,
    );
  }
});

test('★ 行内容：标题与详情必须转义（innerHTML 插值 = 存储型 XSS）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = buildTaskItem({ id: 't', title: evil, detail: evil, status: 'todo', claim: null }, 'u_a');
  assert.equal(html.includes(evil), false, `原始 payload 不得出现在 HTML 里：${html}`);
  assert.equal(/<img/i.test(html), false, `不得出现真实的 <img> 标签：${html}`);
  assert.ok(html.includes('&lt;img'), `payload 必须被转义：${html}`);
});

test('★ 行内容：已完成的任务显示完成时间；无人领取的显示「无人领取」', () => {
  const doneHtml = buildTaskItem(TASKS[3], 'u_a');
  assert.ok(doneHtml.includes('完成于'), doneHtml);
  assert.ok(doneHtml.includes('2026-10-12T00:00:00.000Z'), doneHtml);
  const freeHtml = buildTaskItem(TASKS[0], 'u_a');
  assert.ok(freeHtml.includes('无人领取'), freeHtml);
  const takenHtml = buildTaskItem(TASKS[2], 'u_a');
  assert.ok(takenHtml.includes('领取人：u_b'), takenHtml);
});

test('★ 三段的行内容由同一套纯函数产出（视图与断言不会各写一套）', () => {
  const sections = buildTaskSections(TASKS, 'u_a');
  assert.ok(sections.claimable.includes('没人领的任务'), sections.claimable);
  assert.ok(sections.mine.includes('我领的'), sections.mine);
  assert.ok(sections.mine.includes('别人领的'), sections.mine);
  assert.ok(sections.done.includes('做完了'), sections.done);
  assert.equal(sections.claimable.includes('做完了'), false, '已完成的任务不得出现在「可领取的」里');
});

// ── 前端接线：web/app.js 注册了 /tasks/:workflowId 且把路由参数透传给视图 ──

/** 最小 DOM 桩（同 test/web.test.js 的做法）：够 web/app.js + 任务清单页跑起来 */
function installDom(hash, tasks = []) {
  const calls = [];
  const makeEl = (tag = 'div') => {
    const el = {
      tagName: tag,
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      placeholder: '',
      id: '',
      children: [],
      listeners: {},
      appendChild(child) { el.children.push(child); return child; },
      replaceChildren(...kids) { el.children = kids; },
      addEventListener(evt, fn) { el.listeners[evt] = fn; },
      querySelector(sel) {
        el.__sels = el.__sels ?? {};
        if (!el.__sels[sel]) el.__sels[sel] = makeEl();
        return el.__sels[sel];
      },
      querySelectorAll() { return []; },
    };
    return el;
  };
  const appEl = makeEl('div');
  globalThis.window = {
    location: { search: '', hash },
    addEventListener: () => {},
  };
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => appEl,
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const body = url === '/api/me'
      ? { user: { id: 'u_a', name: '甲' } }
      : { tasks };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, appEl };
}

test('★ web/app.js 注册了 /tasks/:workflowId 且把 workflowId 透传给视图', async () => {
  const { calls, appEl } = installDom('#/tasks/wf_123');
  // ?v=tag → 每个用例一个独立的 app.js 模块实例（ESM 只求值一次）
  await import(`../web/app.js?v=taskroute`);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    calls.some((c) => c.url === '/api/workflows/wf_123/tasks'),
    `路由必须把 workflowId 透传给视图，实际请求：${JSON.stringify(calls)}`,
  );
  // 页面骨架：三段标题都在
  const html = appEl.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('可领取的'), `页面必须有「可领取的」段：${html}`);
  assert.ok(html.includes('我领取的'), `页面必须有「我领取的」段：${html}`);
  assert.ok(html.includes('已完成的'), `页面必须有「已完成的」段：${html}`);
});

test('★ 任务清单页的 DOM 接线：无人领取的任务挂「自主领取」按钮，点它发 POST /api/tasks/<id>/claim', async () => {
  const { calls, appEl } = installDom('#/tasks/wf_123', [
    { id: 't1', title: '没人领的任务', detail: '', status: 'todo', claim: null },
  ]);
  await import(`../web/app.js?v=claimbtn`);
  await new Promise((r) => setTimeout(r, 30));
  const wrap = appEl.children?.[0];
  const list = wrap?.querySelector('#task-claimable');
  const li = list?.children?.[0];
  assert.ok(li, '「可领取的」段里应有任务行');
  const btn = li.children.find((c) => c.textContent === '自主领取');
  assert.ok(
    btn,
    `任务行里应有「自主领取」按钮，实际子节点：${JSON.stringify(li.children.map((c) => c.textContent))}`,
  );
  await btn.listeners.click();
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, `点「自主领取」必须发 POST，实际调用：${JSON.stringify(calls)}`);
  assert.equal(post.url, '/api/tasks/t1/claim');
});

test('★ 没有登记 /tasks/:workflowId 的路由 → 渲染「页面不存在」（反向对照：上面的用例不是恒绿）', async () => {
  const { calls } = installDom('#/no-such-page');
  await import(`../web/app.js?v=notasks`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    calls.some((c) => c.url.includes('/api/workflows/')),
    false,
    `未知路由不得触发任务清单请求，实际请求：${JSON.stringify(calls)}`,
  );
});

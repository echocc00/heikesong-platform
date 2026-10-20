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

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

const FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};

const PAYLOAD = {
  title: '门店排班优化',
  painPoint: '排班靠店长经验，旺季人不够、淡季人浪费',
  expectedDelivery: '可运行的排班推荐原型',
  acceptanceCriteria: '用真实门店历史数据跑出一版排班表，店长认可',
  enterpriseName: '某零售',
  consent: { accepted: true, items: ['no_data_export'] },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-tpapi-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31',
  });
  const enterprise = createUser(db, { name: '企业甲', phone: '13900005001', password: 'pw', mbaStatus: 'other' });
  const admin = createUser(db, { name: '组委会', phone: '13900005002', password: 'pw', mbaStatus: 'mba' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900005003', password: 'pw', mbaStatus: 'mba' });
  // ⚠️ 2026-10-21 独立评审修正（Important I-3：**三条路由的能力点常量不可区分**）：
  //    独立评审变异 M37/M37b/M37c：`write`↔`read`、`approve`↔`read` 互换后
  //    全量用例照样全绿 —— 因为测试里的企业账号同时有 write + read，
  //    超管又绕过一切检查 → 换掉常量没有任何用例会红。
  //    这里造两个**只有单一能力点**的账号，把「哪个端点要哪个能力点」钉死。
  const reader = createUser(db, { name: '只读账号', phone: '13900005006', password: 'pw', mbaStatus: 'mba' });
  const writer = createUser(db, { name: '可写不可签级账号', phone: '13900005007', password: 'pw', mbaStatus: 'mba' });
  setSuperadmin(db, admin.id);
  // 能力点必须先注册（grantAssignment 会校验 capabilities 表）
  insertCapability(db, 'task_package:read', '读取任务卡');
  insertCapability(db, 'task_package:write', '提交/编辑任务卡');
  insertCapability(db, 'task_package:approve', '任务卡分级签约');
  grantAssignment(db, {
    userId: enterprise.id, capability: 'task_package:write',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: enterprise.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: reader.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grantAssignment(db, {
    userId: writer.id, capability: 'task_package:write',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  // 「可写不可签级」账号**同时给 read** —— 这样把 approve 端点的能力点
  // 换成 read 时它仍然能通过 → 用例必须变红（否则换掉常量无人察觉）。
  grantAssignment(db, {
    userId: writer.id, capability: 'task_package:read',
    scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, edition, enterprise, admin, outsider, reader, writer,
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
    tokenReader: createSession(db, reader.id).token,
    tokenWriter: createSession(db, writer.id).token,
  };
}

function call(app, method, path, { token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers: token ? { cookie: `hk_session=${token}` } : {},
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
      on() {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
      end(payload) {
        if (payload) this.body = payload.toString();
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };
    app.handle(req, res);
  });
}

test('POST /api/task-packages 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', {
    body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(res.status, 401);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages 已登录但无 task_package:write → 403（能力点必须真的被校验）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（覆盖缺口）：Task 4 原计划的 17 条用例
  //    **一条都不碰路由**。而 P1 Task 3 验收发现的两个真实缺陷
  //    （A1 能力点从未被校验 / A2 error.detail 零断言）正是在路由层。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenOutsider, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(res.status, 403, `没有能力点必须回 403，实际 ${res.status}`);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  // 拒绝之后不得留下任何任务卡
  const list = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(JSON.parse(list.body).items.length, 0, '被拒绝的提交不得留下记录');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages 缺 editionId → 400 MISSING_EDITION_ID', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', { token: s.tokenEnterprise, body: PAYLOAD });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'MISSING_EDITION_ID');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages 成功 → 200 + 状态 submitted', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'submitted');
  assert.equal(body.isFreeBrief, false);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 不带 editionId → 200（不得因绑定 undefined 抛 500）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Important）：仓储层原来写死
  //    `WHERE edition_id = ?` → editionId 缺省时 node:sqlite 抛
  //    「Provided value cannot be bound to SQLite parameter 1.」→ 500。
  const s = setup();
  const res = await call(s.app, 'GET', '/api/task-packages', { token: s.tokenAdmin });
  assert.equal(res.status, 200, `缺 editionId 不得 500，实际 ${res.status}`);
  assert.ok(Array.isArray(JSON.parse(res.body).items));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 无 task_package:read 权限 → 200 + 空集', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenOutsider });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).items, []);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 配比体检数得出自由题，且只算已进池的卡（分母 + 形状回归）', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Critical ×2）：
  //    ① **形状错配**：路由把 presentTaskPackage 的**驼峰**视图对象喂给
  //       checkTaskMix，而实现读的是 `p.is_free_brief` → 自由题恒算 0 →
  //       体检恒报「自由命题占比 0%」（父代理预审实跑复现）。
  //    ② **分母用错**：R-ENT-09 原文「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」
  //       是四档瓜分**整个任务池**；原来实现用 `enterprise * ratio`（B 端子集为分母）
  //       → 10 张池子里 4 张 A 级被判成「4/7 超出目标 40%」→ 明明合规却报错。
  //    这条用例把 4A/2B/1C/3自由（= 40%/20%/10%/30%）全部发布进池后断言体检达标：
  //    分母用错、形状错配、只看未分级卡 —— 三种错法都会让它变红。
  const s = setup();
  const enterprisePlan = [
    { title: 'E0', grade: 'A' }, { title: 'E1', grade: 'A' },
    { title: 'E2', grade: 'A' }, { title: 'E3', grade: 'A' },
    { title: 'E4', grade: 'B' }, { title: 'E5', grade: 'B' },
    { title: 'E6', grade: 'C' },
  ];
  async function submitAndPublish(body, grade) {
    const created = await call(s.app, 'POST', '/api/task-packages', {
      token: s.tokenEnterprise, body: { ...body, editionId: s.edition.id },
    });
    assert.equal(created.status, 200, created.body);
    const id = JSON.parse(created.body).id;
    const assessed = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
      token: s.tokenEnterprise, body: { answers: FULL },
    });
    assert.equal(assessed.status, 200, assessed.body);
    const approved = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
      token: s.tokenAdmin, body: { grade },
    });
    assert.equal(approved.status, 200, approved.body);
  }
  for (const p of enterprisePlan) {
    await submitAndPublish({ ...PAYLOAD, title: p.title }, p.grade);
  }
  for (let i = 0; i < 3; i += 1) {
    await submitAndPublish(
      { ...PAYLOAD, title: `F${i}`, isFreeBrief: true, enterpriseName: null },
      'A',
    );
  }
  // 再交一张**未分级**的卡：它不进池，配比体检不该把它算进去
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, title: 'PENDING', editionId: s.edition.id },
  });

  const res = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 11, '组委会看到全部 11 张');
  assert.ok(body.mix, '组委会必须拿到配比体检结果');
  assert.equal(body.mix.total, 10, '配比只算已发布（进池）的卡');
  assert.equal(body.mix.free, 3, `自由题应被算成 3，实际 ${body.mix.free}`);
  assert.equal(body.mix.enterprise, 7);
  assert.deepEqual(body.mix.byGrade, { A: 4, B: 2, C: 1 });
  assert.equal(body.mix.ok, true, body.mix.errors.join('；'));
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 无权限 → 403', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenOutsider, body: { answers: FULL },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 有权限 → 200 + 等级与承诺', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.solvabilityScore, 12);
  assert.equal(body.solvabilityGrade, 'A');
  assert.equal(body.commitment, '试点承诺');
  assert.equal(body.status, 'assessed');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 取值越界 → 400 INVALID_SOLVABILITY_ANSWERS', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, validation: 9 } },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_SOLVABILITY_ANSWERS');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 无权限 → 403', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenOutsider, body: { grade: 'A' },
  });
  assert.equal(res.status, 403);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 未评估就签级 → 400 SOLVABILITY_NOT_ASSESSED', async () => {
  // ⚠️ 2026-10-21 父代理预审修正（Important）：评估闸门必须在 HTTP 层也拦得住。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'SOLVABILITY_NOT_ASSESSED');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 组委会签级 → 200 + published', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.grade, 'A');
  assert.equal(body.status, 'published');
  assert.equal(body.agreement, '试点承诺书 + 数据授权说明');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/approve 非法等级 → 400 INVALID_GRADE', async () => {
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenAdmin, body: { grade: 'X' },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_GRADE');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('POST /api/task-packages/:id/solvability 任务卡不存在 → 404', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages/not-a-real-id/solvability', {
    token: s.tokenEnterprise, body: { answers: FULL },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TASK_PACKAGE_NOT_FOUND');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('能力点常量钉死：只有 task_package:read 不能评估，只有 task_package:write 不能签级', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-3）。
  //    「提交/评估」要 write，「分级签约」要 approve，「读列表」要 read ——
  //    三个常量互换，任何一个用例都不会红（独立评审变异 M37/M37b/M37c SURVIVED）。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  assert.equal(created.status, 200, created.body);
  const id = JSON.parse(created.body).id;

  // 只读账号：有 read 没有 write → 评估必须 403
  const byReader = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenReader, body: { answers: FULL },
  });
  assert.equal(byReader.status, 403, '只有 read 的账号不得评估');

  // 只写账号：有 write 没有 approve → 签级必须 403
  const byWriter = await call(s.app, 'POST', `/api/task-packages/${id}/approve`, {
    token: s.tokenWriter, body: { grade: 'A' },
  });
  assert.equal(byWriter.status, 403, '只有 write 的账号不得分级签约');
  assert.equal(JSON.parse(byWriter.body).error.code, 'FORBIDDEN');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('配比体检只对组委会开放（非组委会拿不到 mix）', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Important I-4）：
  //    原来「mix 只对组委会开放」这条规则**没有任何断言** ——
  //    把 mix 对所有人开放，全量用例照样全绿（独立评审变异 M46/M47 SURVIVED）。
  //    mix 是任务池的经营数据（配比是否达标），不该流向普通选手/企业。
  const s = setup();
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const byEnterprise = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenEnterprise });
  assert.equal(byEnterprise.status, 200);
  assert.equal(JSON.parse(byEnterprise.body).mix, null, '非组委会不得拿到配比体检结果');
  const byAdmin = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.ok(JSON.parse(byAdmin.body).mix, '组委会必须拿到配比体检结果');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('六维取值越界（负数 / 非整数）→ 400 INVALID_SOLVABILITY_ANSWERS', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4：负数取值分支零断言）。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const negative = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, problem_clarity: -1 } },
  });
  assert.equal(negative.status, 400);
  assert.equal(JSON.parse(negative.body).error.code, 'INVALID_SOLVABILITY_ANSWERS');
  const fractional = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, validation: 1.5 } },
  });
  assert.equal(fractional.status, 400);
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('自报未知否决项 → 400 INVALID_VETO_KEY', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4：INVALID_VETO_KEY 分支零断言）。
  const s = setup();
  const created = await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  const id = JSON.parse(created.body).id;
  const res = await call(s.app, 'POST', `/api/task-packages/${id}/solvability`, {
    token: s.tokenEnterprise, body: { answers: { ...FULL, vetoes: ['not_a_real_veto'] } },
  });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'INVALID_VETO_KEY');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('approve 不存在的任务卡 → 404', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-4：approve 的 404 分支零断言）。
  const s = setup();
  const res = await call(s.app, 'POST', '/api/task-packages/not-a-real-id/approve', {
    token: s.tokenAdmin, body: { grade: 'A' },
  });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'TASK_PACKAGE_NOT_FOUND');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('GET /api/task-packages 不带 editionId → 返回全部届期的卡', async () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-3：editionId 缺省语义未钉住）。
  //    只断言「不 500」不够 —— 语义必须写死：缺省 = 不按届期过滤。
  const s = setup();
  const otherEdition = createEdition(s.db, {
    name: '第二届', city: '北京', startsAt: '2027-10-01', endsAt: '2027-10-31',
  });
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, editionId: s.edition.id },
  });
  await call(s.app, 'POST', '/api/task-packages', {
    token: s.tokenEnterprise, body: { ...PAYLOAD, title: '第二届的题', editionId: otherEdition.id },
  });
  const all = await call(s.app, 'GET', '/api/task-packages', { token: s.tokenAdmin });
  assert.equal(all.status, 200);
  assert.equal(JSON.parse(all.body).items.length, 2, '不带 editionId 必须返回全部届期');
  const one = await call(s.app, 'GET', `/api/task-packages?editionId=${s.edition.id}`, { token: s.tokenAdmin });
  assert.equal(JSON.parse(one.body).items.length, 1, '带 editionId 必须只返回本届');
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
});

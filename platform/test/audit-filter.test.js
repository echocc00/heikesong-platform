// platform/test/audit-filter.test.js —— 审计/复核/申诉三端点的过滤键闸（E181 · A3，2026-10-27）
//
// 规则溯源：
//   - 设计文档 §7.3 三态状态码（未登录 401 / 无权限 403 / 不满足 200+空集 / 单条 404）
//   - 设计文档 §6.6「可见性在 API 层过滤」
//   - 缺陷（E181 实测）：`pickFilter` 用**一份并集白名单**给三个端点用
//     ⇒ `/api/audit/log?status=open` 被**接受**但仓储层不认识 status ⇒ **过滤被静默丢弃**
//     ⇒ 调用方拿到**未筛选的全量**却以为自己筛过了。
//
// ⚠️ **判别性要求**：
//   ① 「未知键 ⇒ 400」用例必须真的红在「400」这个数字上（不是「非 200」）；
//   ② 「已知键 ⇒ 真的过滤」用例必须断言**返回行数变少**，否则把过滤实现抽掉也测不出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { createUser, getUserById, setSuperadmin } from '../src/db/repo/users.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { insertAuditLogRow } from '../src/db/repo/audit-log.js';
import { createFlag } from '../src/db/repo/flags.js';
import { insertAppeal } from '../src/db/repo/appeals.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-auditfilter-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const admin = createUser(db, { name: '组委会', phone: '13800000001', password: 'pw' });
  setSuperadmin(db, admin.id);
  const adminUser = getUserById(db, admin.id);
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertCapability(db, 'audit:write', '裁决复核项与申诉');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'admin', 'audit:read');
  insertRoleCapability(db, 'admin', 'audit:write');
  insertUserRole(db, adminUser.id, 'admin');
  const token = createSession(db, adminUser.id).token;
  return { db, close, dataDir, app, rules, admin: adminUser, token };
}

/** 造两条不同 action 的审计行。 */
function seedAuditRows(db, actorId) {
  insertAuditLogRow(db, {
    actorId, action: 'leaderboard.publish', entity: 'stage', entityId: 'st1',
    detailJson: '{}', createdAt: '2026-10-20T10:00:00.000Z',
  });
  insertAuditLogRow(db, {
    actorId, action: 'flag.resolve', entity: 'flag', entityId: 'f1',
    detailJson: '{}', createdAt: '2026-10-20T11:00:00.000Z',
  });
}

test('/api/audit/log：未知过滤键 ⇒ 400（不再**静默丢弃**过滤条件）', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    // ⛔ `status` 是**复核队列**的过滤键，审计日志端点**不支持** ⇒ 之前被静默忽略
    const res = await callJson(s.app, 'GET', '/api/audit/log?status=open', { token: s.token });
    assert.equal(res.status, 400, '未知过滤键必须 400，而不是返回未筛选的全量');
    assert.ok(res.json?.error?.message?.includes('status'), '错误文案要点名是哪个参数');
  } finally {
    s.close();
  }
});

test('/api/audit/log：拼错的参数名 ⇒ 400', async () => {
  const s = setup();
  try {
    const res = await callJson(s.app, 'GET', '/api/audit/log?acton=leaderboard.publish', { token: s.token });
    assert.equal(res.status, 400);
  } finally {
    s.close();
  }
});

test('/api/audit/log：支持的过滤键 ⇒ 200 且**真的过滤**（行数变少）', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    const all = await callJson(s.app, 'GET', '/api/audit/log', { token: s.token });
    assert.equal(all.status, 200);
    assert.equal(all.json.rows.length, 2, '先确认有两条');

    const filtered = await callJson(s.app, 'GET', '/api/audit/log?action=flag.resolve', { token: s.token });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.rows.length, 1, '按 action 过滤后必须只剩一条');
    assert.equal(filtered.json.rows[0].action, 'flag.resolve');
  } finally {
    s.close();
  }
});

test('/api/audit/log：`entity` 过滤键同样生效', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    const res = await callJson(s.app, 'GET', '/api/audit/log?entity=stage', { token: s.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.rows.length, 1);
    assert.equal(res.json.rows[0].entity, 'stage');
  } finally {
    s.close();
  }
});

test('/api/audit/log：非法分页参数（limit=abc）**仍然 200**（既有契约不破）', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    // ⚠️ 这条是既有契约（test/audit-api.test.js 钉住「不得打成 500」）：
    //    非法 limit/offset 是**静默忽略**，不是 400 —— 本次修复只治「过滤键静默失效」。
    const res = await callJson(s.app, 'GET', '/api/audit/log?limit=abc&offset=xyz', { token: s.token });
    assert.equal(res.status, 200);
  } finally {
    s.close();
  }
});

test('/api/audit/flags：未知过滤键 ⇒ 400（entity 不属于复核队列）', async () => {
  const s = setup();
  try {
    createFlag(s.db, { stageId: 'st1', kind: 'low_variance', detail: { judgeId: 'j1' } });
    const res = await callJson(s.app, 'GET', '/api/audit/flags?entity=stage', { token: s.token });
    assert.equal(res.status, 400);
  } finally {
    s.close();
  }
});

test('/api/audit/flags：`kind` / `status` 过滤键 ⇒ 200 且**真的过滤**', async () => {
  const s = setup();
  try {
    createFlag(s.db, { stageId: 'st1', kind: 'low_variance', detail: { judgeId: 'j1' } });
    createFlag(s.db, { stageId: 'st1', kind: 'burst_submit', detail: { subjectId: 'j2' } });

    const all = await callJson(s.app, 'GET', '/api/audit/flags', { token: s.token });
    assert.equal(all.status, 200);
    assert.equal(all.json.rows.length, 2, '先确认有两条');

    const byKind = await callJson(s.app, 'GET', '/api/audit/flags?kind=low_variance', { token: s.token });
    assert.equal(byKind.status, 200);
    assert.equal(byKind.json.rows.length, 1, '按 kind 过滤后必须只剩一条');
    assert.equal(byKind.json.rows[0].kind, 'low_variance');

    const byStatus = await callJson(s.app, 'GET', '/api/audit/flags?status=open', { token: s.token });
    assert.equal(byStatus.status, 200);
    assert.ok(Array.isArray(byStatus.json.rows));
  } finally {
    s.close();
  }
});

test('/api/appeals：未知过滤键 ⇒ 400（action 不属于申诉列表）', async () => {
  const s = setup();
  try {
    insertAppeal(s.db, { subjectType: 'team_result', subjectId: 'st1:t1', filedBy: s.admin.id, reason: '算错了', now: NOW });
    const res = await callJson(s.app, 'GET', '/api/appeals?action=leaderboard.publish', { token: s.token });
    assert.equal(res.status, 400);
  } finally {
    s.close();
  }
});

test('/api/appeals：`subjectType` 过滤键 ⇒ 200 且**真的过滤**', async () => {
  const s = setup();
  try {
    insertAppeal(s.db, { subjectType: 'team_result', subjectId: 'st1:t1', filedBy: s.admin.id, reason: '算错了', now: NOW });
    insertAppeal(s.db, { subjectType: 'registration', subjectId: 'r1', filedBy: s.admin.id, reason: '报名有问题', now: NOW });

    const all = await callJson(s.app, 'GET', '/api/appeals', { token: s.token });
    assert.equal(all.status, 200);
    assert.equal(all.json.rows.length, 2, '先确认有两条');

    const filtered = await callJson(s.app, 'GET', '/api/appeals?subjectType=registration', { token: s.token });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.rows.length, 1, '按 subjectType 过滤后必须只剩一条');
    assert.equal(filtered.json.rows[0].subjectType, 'registration');
  } finally {
    s.close();
  }
});

test('三端点的白名单**互不相同**（同一个键在另一个端点必须 400）', async () => {
  const s = setup();
  try {
    // action 只属于 audit/log；kind 只属于 flags；subjectType 只属于 appeals
    assert.equal((await callJson(s.app, 'GET', '/api/audit/log?kind=x', { token: s.token })).status, 400);
    assert.equal((await callJson(s.app, 'GET', '/api/audit/flags?action=x', { token: s.token })).status, 400);
    assert.equal((await callJson(s.app, 'GET', '/api/appeals?kind=x', { token: s.token })).status, 400);
  } finally {
    s.close();
  }
});

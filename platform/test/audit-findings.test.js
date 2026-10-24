// platform/test/audit-findings.test.js — 本次系统性测试新增的回归用例
//
// 覆盖 2026-10-23 全量审计确认的 4 个缺陷（每个都是**先复现、后修复**）：
//   F1  POST /api/stages/:stageId/enterprise-confirmations 未登录 ⇒ 500（应为 401）
//       review.js:304 在鉴权前解引用 ctx.user.id
//   F2  POST /api/workflows 传入不存在的 editionId/taskPackageId ⇒ 500（应为 404）
//       外键原文漏到 HTTP 层（与 server.js「三态状态码」契约冲突）
//   F3  scripts/build-demo.js / bash-var-scan.js / temp-leak-scan.js 的主程序判定
//       用裸字符串比较 ⇒ 经软链调用时**静默不跑、退出码 0**（E166 同款病根，
//       audit-scan.js 已用 realpath 修好，这三个没修）
//   F4  rules/audit.json 里的 reviewSubmit / judgeHourly 两个限频 profile
//       **从未被任何生产代码引用** ⇒ 评审提交无限频
//
// ⚠️ 用例全部走**真实调用链**（起 HTTP 服务 / 跑真脚本），不做「直接调函数」的假验证。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http, { createServer } from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser, setSuperadmin, getUserById, toPublicUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertUserRole, insertRole } from '../src/db/repo/roles.js';
import { insertRoleCapability, insertCapability } from '../src/db/repo/capabilities.js';
import { insertPeerReview } from '../src/db/repo/peer-reviews.js';
import { grantAssignment, can, scopeClause } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');
const webDir = join(platformDir, 'web');
const scriptsDir = join(platformDir, 'scripts');

// ── 起一个真服务器 ────────────────────────────────────────────────
async function withServer(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-find-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, db });
  } finally {
    await new Promise((r) => server.close(r));
    close();
  }
}

// ⚠️ headers 参数（F27/F28 用）：跨源预检要带 Origin / X-Forwarded-Proto 才能测到分支。
//    这是**加参**不是改断言：原有调用方一律不传 headers ⇒ 行为完全不变。
async function call(base, method, path, { body, cookie, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // ⚠️ headers 一并返回：限频用例要验 429 的 **Retry-After** 头（不静默丢包）。
  const out = {};
  res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return { status: res.status, text, headers: out };
}

/**
 * 裸 HTTP 请求（不走 fetch）。
 * ⚠️ 为什么需要它：undici 的 fetch **不支持 TRACE 方法**（直接抛
 *    "'TRACE' HTTP method is unsupported."）⇒ F27 的 TRACE 对照组必须走 node:http。
 */
function rawCall(base, method, path) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}` },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, text: body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
// F1：未登录访问企业确认写端点 ⇒ 500，不是 401
// ══════════════════════════════════════════════════════════════════
test('F1 未登录 POST 企业确认端点必须返回 401，不得 500', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'POST', '/api/stages/any-stage/enterprise-confirmations', {
      body: { teamId: 't1', dimension: 'enterprise', rawScore: 80, content: 'x' },
    });
    // 修复前：ctx.user.id 在鉴权前解引用 ⇒ TypeError ⇒ 500
    assert.equal(r.status, 401, `未登录必须是 401，实际 ${r.status}：${r.text}`);
    assert.match(r.text, /UNAUTHENTICATED/);
  });
});

test('F1b 未登录访问其它写端点也是 401（对照组：不是全局都 500）', async () => {
  await withServer(async ({ base }) => {
    const paths = [
      '/api/stages/s/reviews',
      '/api/stages/s/calibration',
      '/api/stages/s/peer-reviews',
      '/api/stages/s/self-review',
      '/api/stages/s/recusals',
      '/api/stages/s/compute',
      '/api/stages/s/publish',
      '/api/appeals',
      '/api/workflows',
      '/api/teams',
    ];
    for (const p of paths) {
      const r = await call(base, 'POST', p, { body: {} });
      assert.notEqual(r.status, 500, `${p} 未登录返回了 500：${r.text}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// F2：外键原文漏到 HTTP 层 ⇒ 500（应为 404 / 400）
// ══════════════════════════════════════════════════════════════════
test('F2 建工作流时传入不存在的 editionId 不得返回 500', async () => {
  await withServer(async ({ base, db }) => {
    // 建一个超管用户 + 会话
    insertCapability(db, 'task_package:read', 'x');
    insertRole(db, 'admin', '组委会');
    insertRoleCapability(db, 'admin', 'task_package:read');
    const u = createUser(db, { name: 'A', phone: '13900000091', password: 'pw' });
    insertUserRole(db, u.id, 'admin');
    setSuperadmin(db, u.id);
    const { token } = createSession(db, u.id);

    const r = await call(base, 'POST', '/api/workflows', {
      cookie: `hk_session=${token}`,
      body: { editionId: 'no-such-edition', taskPackageId: 'no-such-package', name: 'W' },
    });
    // 修复前：FOREIGN KEY constraint failed ⇒ 500（外键原文漏到 HTTP 层）
    assert.notEqual(r.status, 500, `外键错误漏成 500：${r.text}`);
    assert.ok(r.status === 404 || r.status === 400, `期望 404/400，实际 ${r.status}：${r.text}`);
    // 且响应体绝不能含 SQLite 原文
    assert.doesNotMatch(r.text, /FOREIGN KEY constraint failed/i);
  });
});

// ══════════════════════════════════════════════════════════════════
// F3：脚本经软链调用时静默不跑（E166 同款病根）
// ══════════════════════════════════════════════════════════════════
test('F3 build-demo.js 经软链调用必须真的构建（不能静默退出 0）', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'hks-demo-'));
  const link = join(outDir, 'build-link.js');
  symlinkSync(join(scriptsDir, 'build-demo.js'), link);
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [link, '--out', outDir], { encoding: 'utf8' });
  // 修复前：isMain 判定为 false ⇒ 什么都不做、退出码 0、产物为空
  assert.ok(
    existsSync(join(outDir, 'index.html')),
    `build-demo.js 经软链调用没有产出 index.html（静默假绿）。stdout=${res.stdout} stderr=${res.stderr}`,
  );
});

test('F3b bash-var-scan.js 经软链调用必须真的扫描（不能静默退出 0）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-bv-'));
  const link = join(dir, 'bv-link.js');
  symlinkSync(join(scriptsDir, 'bash-var-scan.js'), link);
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  // 修复前：无任何输出、退出码 0（闸静默失效 = 假绿）
  assert.match(
    res.stdout + res.stderr,
    /bash-var-scan/,
    `bash-var-scan.js 经软链调用没有任何输出（闸静默失效 = 假绿）。stdout=${res.stdout}`,
  );
});

test('F3c temp-leak-scan.js 在含空格的路径下必须真的扫描', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-tl-'));
  const spaced = join(dir, 'with space');
  mkdirSync(spaced, { recursive: true });
  const copy = join(spaced, 'temp-leak-scan.js');
  writeFileSync(copy, readFileSync(join(scriptsDir, 'temp-leak-scan.js'), 'utf8'));
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [copy], { encoding: 'utf8' });
  // 修复前：import.meta.url 含 %20 而 argv[1] 含空格 ⇒ 主程序判定为 false ⇒ 静默不跑
  assert.match(
    res.stdout + res.stderr,
    /temp-leak-scan/,
    `temp-leak-scan.js 在含空格路径下没有任何输出（闸静默失效 = 假绿）。stdout=${res.stdout}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F5：单写者约束（README 的头号架构承诺）在启动时**没有任何强制**
// ══════════════════════════════════════════════════════════════════
test('F5 同一 DATA_DIR 起第二个实例必须被拒绝（单写者约束）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-writer-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  close();

  const { spawn } = await import('node:child_process');
  const start = (port) => spawn(process.execPath, [join(platformDir, 'src/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const a = start(19301);
  let aOut = '';
  a.stdout.on('data', d => { aOut += d; });
  a.stderr.on('data', d => { aOut += d; });
  await new Promise(r => setTimeout(r, 2500));

  const b = start(19302);
  let bOut = '';
  b.stdout.on('data', d => { bOut += d; });
  b.stderr.on('data', d => { bOut += d; });
  await new Promise(r => setTimeout(r, 2500));

  try {
    // 修复前：第二个实例照常启动（B 与 A 共用同一个库文件）
    assert.ok(
      b.exitCode !== null || /已在运行|拒绝|refus|already/i.test(bOut),
      `同一 DATA_DIR 起第二个实例没有被拒绝（单写者约束失效）。B 输出：${bOut.trim().slice(0, 200)}`,
    );
  } finally {
    a.kill('SIGTERM');
    b.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
});

test('F5b pid 文件缺失但服务还在跑时，恢复闸必须判为「还在跑」（fail closed）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-guard-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  close();

  const { spawn } = await import('node:child_process');
  const { checkServiceState } = await import('../scripts/restore.js');
  const proc = spawn(process.execPath, [join(platformDir, 'src/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '19303' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise(r => setTimeout(r, 2500));

  try {
    // 正常态：pid 文件在 → 必须判为 running
    assert.equal(checkServiceState({ dataDir }).running, true, 'pid 文件在时必须判为还在跑');

    // 异常态：pid 文件没了（第二个实例覆盖后删掉 / 被误删 / 残留清理）
    //   而服务**还在跑** —— 恢复闸必须 fail closed（拒绝恢复）
    const pidFile = join(dataDir, 'app.pid');
    if (existsSync(pidFile)) rmSync(pidFile);
    const health = await fetch('http://127.0.0.1:19303/api/health');
    assert.equal(health.status, 200, '前提：服务确实还在跑');
    // 修复前：判为 running=false ⇒ 允许恢复 ⇒ 恢复时服务正在写被替换的库
    assert.equal(
      checkServiceState({ dataDir }).running, true,
      'pid 文件缺失但服务还在跑时，恢复闸必须 fail closed（判为还在跑）',
    );
  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
});

// ══════════════════════════════════════════════════════════════════
// F7：stage_results.rank / points / tied_with **从来没有被写入过**
//     ⇒ 公开榜单接口返回 rank:null，且排序退化成 team_id 序（低分队排第一）
// ══════════════════════════════════════════════════════════════════
test('F7 发榜后公开榜单必须带有名次与积分（stage_results.rank/points 不得为 NULL）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  db.exec(`INSERT INTO users (id,name,phone,password_hash,mba_status,org,is_superadmin,active,created_at) VALUES ('u1','U','13800000001','x','mba',NULL,1,1,'${now}')`);
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
  // 队伍 id 的字典序与分数序【相反】：tm_aaa 低分、tm_zzz 高分
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_aaa','ed1','低分队','u1','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_zzz','ed1','高分队','u1','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s1','st1','tm_aaa','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s2','st1','tm_zzz','${now}')`);
  db.exec(`INSERT INTO stage_judges (stage_id,user_id,seat,scope_type,scope_id,assigned_at) VALUES ('st1','u1','judge','global',NULL,'${now}')`);
  for (const [team, score] of [['tm_aaa', 20], ['tm_zzz', 90]]) {
    for (const dim of ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']) {
      db.prepare(`INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,request_id,calibrated,submitted_at) VALUES (?,?,?,?,?,?,?,0,?)`)
        .run(`r_${team}_${dim}`, 'st1', 'u1', team, dim, score, `req_${team}_${dim}`, now);
    }
  }

  try {
    const { computeStage } = await import('../src/services/compute.js');
    const { publishLeaderboard } = await import('../src/services/leaderboard.js');
    computeStage({ db, stageId: 'st1', actorId: 'u1', now, rules });
    publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: 'u1', now, rules });

    // ① stage_results 的名次/积分列必须被填上
    const rows = db.prepare('SELECT team_id, total, rank, points FROM stage_results WHERE stage_id = ?').all('st1');
    assert.equal(rows.length, 2, '应有 2 行赛段结果');
    for (const r of rows) {
      assert.notEqual(r.rank, null, `stage_results.rank 未被写入（队伍 ${r.team_id}）`);
      assert.notEqual(r.points, null, `stage_results.points 未被写入（队伍 ${r.team_id}）`);
    }

    // ② 公开榜单接口必须给出名次，且高分队排在前面
    db.exec(`UPDATE tier_records SET tier = 'C'`);   // 抬到 C 段，绕过 D 段不公示的规则
    const mod = await import('../src/services/public-api.js');
    const created = mod.createPublicToken({ db, scope: 'all', editionId: 'ed1', expiresAt: null, ttlDays: 7, rules, now });
    const pub = await mod.getPublicLeaderboard({ db, editionId: 'ed1', rules, token: created.token });
    const pubRows = pub.stages[0].rows;
    assert.equal(pubRows.length, 2, '公开榜单应有 2 行');
    for (const r of pubRows) {
      assert.notEqual(r.rank, null, `公开榜单返回了 rank:null（队伍 ${r.teamName}）`);
    }
    assert.ok(
      pubRows[0].total >= pubRows[1].total,
      `公开榜单顺序错乱：第一行 total=${pubRows[0].total} < 第二行 total=${pubRows[1].total}（排序退化成 team_id 序）`,
    );
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F8：src/db/tx.js 用 SAVEPOINT（DEFERRED），WAL 下撞 SQLITE_BUSY_SNAPSHOT(517)
//     且 busy_timeout 不覆盖 517 ⇒ 0ms 硬失败
// ══════════════════════════════════════════════════════════════════
test('F8 withTransaction 在并发写下不得因 517 硬失败（WAL 快照升级）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-wal-'));
  const A = openDatabase({ dataDir });
  const B = openDatabase({ dataDir });
  A.db.exec('CREATE TABLE t (v TEXT)');
  A.db.exec("INSERT INTO t VALUES ('init')");

  const { withTransaction } = await import('../src/db/tx.js');
  let err = null;
  try {
    withTransaction(A.db, () => {
      A.db.prepare('SELECT count(*) AS n FROM t').get();  // 先读 ⇒ 取到快照
      B.db.exec("INSERT INTO t VALUES ('from B')");         // 另一连接提交（WAL 前移）
      A.db.exec("INSERT INTO t VALUES ('from A')");         // 升级写锁 ⇒ 517
    });
  } catch (e) { err = e; }
  A.close(); B.close();

  // 修复前：errcode=517（SQLITE_BUSY_SNAPSHOT），busy_timeout 对它无效
  assert.ok(
    !err || err.errcode !== 517,
    `withTransaction 撞了 SQLITE_BUSY_SNAPSHOT(517)：${err?.errstr ?? ''}（busy_timeout 不覆盖该错误码）`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F10：突发提交检测器把「评分格子」当「提交动作」⇒ 正常评审被误判为刷分
// ══════════════════════════════════════════════════════════════════
test('F10 正常评审（1 评委 2 队 5 维度）不得触发 burst_submit 误报', async () => {
  const { detectBurstSubmission } = await import('../src/domain/anticheat.js');
  const auditCfg = JSON.parse(readFileSync(join(rulesDir, 'audit.json'), 'utf8'));
  const burst = auditCfg.antiCheat.burst;

  // compute.js 喂进去的 events 是 stage_reviews 的每一行（= 每队×每维度一行）
  const now = Date.parse('2026-10-23T10:00:00.000Z');
  const events = [];
  for (let i = 0; i < 10; i++) {           // 1 评委 × 2 队 × 5 维度 = 10 个格子
    events.push({ subjectId: 'u_judge_A', at: new Date(now + i * 1000).toISOString() });
  }
  const r = detectBurstSubmission({ events, windowSeconds: burst.windowSeconds, threshold: burst.threshold });
  // 修复前：flags.length = 1（count 6 > threshold 5）⇒ 正常评审被判为刷分
  assert.equal(
    r.flags.length, 0,
    `正常的 2 队评审被误判为 burst_submit（${JSON.stringify(r.flags)}）—— 检测器的输入应是「提交动作」不是「评分格子」`,
  );
});

// ═══ F8b：517 必须归类为「可重试」（而不是 500 级内部错误）═══
test('F8b SQLite 并发冲突（517/5/6）必须归类为可重试，其它错误不得误判', async () => {
  const { isRetryableDbError } = await import('../src/db/tx.js');
  assert.equal(
    isRetryableDbError({ errcode: 517, code: 'ERR_SQLITE_ERROR', message: 'database is locked' }),
    true, '517（SQLITE_BUSY_SNAPSHOT）必须可重试',
  );
  assert.equal(isRetryableDbError({ errcode: 5 }), true, '5（SQLITE_BUSY）必须可重试');
  assert.equal(isRetryableDbError({ errcode: 6 }), true, '6（SQLITE_LOCKED）必须可重试');
  assert.equal(
    isRetryableDbError({ errcode: 19, message: 'UNIQUE constraint failed' }),
    false, '唯一约束冲突不是并发冲突 ⇒ 不得误判成可重试（否则真错误会被当成「稍后再说」）',
  );
  assert.equal(isRetryableDbError(new Error('普通错误')), false);
});

// ══════════════════════════════════════════════════════════════════
// F11：告警裁剪漏了 errors/stats ⇒ 评委 ID 泄漏给匿名访客
// ══════════════════════════════════════════════════════════════════
test('F11 匿名访客看到的告警里不得含评委 ID', async () => {
  const { checkJudgePool } = await import('../src/domain/judge-pool.js');
  const { applyWarningVisibility } = await import('../src/domain/visibility.js');

  const pool = checkJudgePool({
    judges: [
      { judgeId: 'u_judge_A', seat: 'judge' },
      { judgeId: 'u_judge_A', seat: 'judge' },   // 重复 ⇒ error.message 里带原始 judgeId
      { judgeId: 'u_judge_B', seat: 'judge' },
    ],
    config: {
      votingSeats: ['judge'], nonVotingSeats: ['observer'],
      minJudgesPerDimension: 7, minEnterpriseSeatShare: 0.3, maxExpertSeatShare: 0.6,
    },
  });
  assert.equal(pool.ok, false, '前提：评委池应被判为不合规');

  const warning = {
    code: 'judge_pool_invalid',
    message: `评委池不合规（${pool.errors.length} 项）：${pool.errors.map((e) => e.code).join(', ')}`,
    errors: pool.errors,
    stats: pool.stats,
  };
  // 匿名访客（没有 audit:read）
  const visible = applyWarningVisibility([warning], { canAudit: false });
  const text = JSON.stringify(visible);
  assert.ok(
    !text.includes('u_judge_A') && !text.includes('u_judge_B'),
    `匿名访客的告警里泄漏了评委 ID：${text.slice(0, 300)}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F12：发榜前必须检查「算过没有」⇒ 不能发一个空榜
// ══════════════════════════════════════════════════════════════════
test('F12 没计算过的赛段不得发榜（必须 409 而不是发一个空榜）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-nopub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  db.exec(`INSERT INTO users (id,name,phone,password_hash,mba_status,org,is_superadmin,active,created_at) VALUES ('u1','U','13800000001','x','mba',NULL,1,1,'${now}')`);
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);

  try {
    const { publishLeaderboard } = await import('../src/services/leaderboard.js');
    let err = null;
    try {
      publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: 'u1', now, rules });
    } catch (e) { err = e; }
    assert.ok(err, '没算过的赛段竟然发榜成功了');
    assert.ok(
      err.status === 409 || err.status === 400,
      `期望 409/400（未计算），实际 ${err.status}：${err.message}`,
    );
    // 且不得留下「已发榜」的痕迹
    const snaps = db.prepare('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE stage_id = ?').get('st1');
    assert.equal(snaps.n, 0, '未计算的赛段不该留下榜单快照');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F13：启动失败（端口被占）会留下陈旧 pid 文件 ⇒ 恢复闸误判「服务没在跑」
//     （server.js:583 先写 pid 文件，591 才 listen；listen 无 'error' 处理器）
// ══════════════════════════════════════════════════════════════════
test('F13 启动失败（端口被占）不得留下陈旧 pid 文件', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-bind-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  close();

  const { spawn } = await import('node:child_process');
  const pidFile = join(dataDir, 'app.pid');
  const start = (port) => spawn(process.execPath, [join(platformDir, 'src/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const a = start(19411);
  let aOut = '';
  a.stdout.on('data', d => { aOut += d; });
  await new Promise(r => setTimeout(r, 2500));

  try {
    assert.equal(a.exitCode, null, '前提：实例 A 应当已启动');
    const pidA = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : null;
    assert.ok(pidA, '前提：A 应当已写 pid 文件');

    // 实例 B：同一个 DATA_DIR、同一个端口 ⇒ 绑定失败 ⇒ 崩溃
    const b = start(19411);
    let bOut = '';
    b.stdout.on('data', d => { bOut += d; });
    b.stderr.on('data', d => { bOut += d; });
    await new Promise(r => setTimeout(r, 2500));
    assert.notEqual(b.exitCode, null, '前提：B 应当因端口被占而启动失败');

    // 修复前：B 在崩溃前已覆盖写了 pid 文件（写 pid 在 listen 之前），
    //          留下一个指向【已死进程】的陈旧 pid ⇒ 恢复闸判「服务没在跑」
    const pidAfter = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : null;
    assert.ok(
      pidAfter === pidA,
      `启动失败后 pid 文件被覆盖成 ${pidAfter}（原 ${pidA}）—— 陈旧 pid 会让恢复闸误判「服务没在跑」`,
    );

    // 并且恢复闸必须仍然判定「还在跑」（A 还活着）
    const { checkServiceState } = await import('../scripts/restore.js');
    assert.equal(
      checkServiceState({ dataDir }).running, true,
      'A 还活着但恢复闸判成「没在跑」⇒ 恢复会在服务正在写库时进行',
    );

    // ⚠️ 追加场景（E169 变异检验发现的判别性缺口）：
    //    同一个 DATA_DIR 的实例 B 现在会被**单写者闸**提前拦掉 ⇒ 它根本走不到
    //    「写 pid 文件 → listen 失败」那段 ⇒ 上面那条断言已经**不再判别**
    //    （把「写 pid 挪回 listen 之前」这个变异注入进去，本用例如然全绿 ⇒ 变异存活）。
    //    ⇒ 补一条**不同 DATA_DIR、同一端口**的场景：C 能通过单写者闸（它自己的目录
    //    里没有 pid 文件）⇒ 于是真的走到 listen ⇒ 绑定失败 ⇒ 它**不得留下 pid 文件**。
    const dataDir2 = mkdtempSync(join(tmpdir(), 'hks-bind2-'));
    const { db: db2, close: close2 } = openDatabase({ dataDir: dataDir2 });
    applyMigrations(db2, migrationsDir);
    close2();
    const c = spawn(process.execPath, [join(platformDir, 'src/server.js')], {
      env: { ...process.env, DATA_DIR: dataDir2, PORT: '19411' }, // 同一个端口 ⇒ 必然绑定失败
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cOut = '';
    c.stdout.on('data', d => { cOut += d; });
    c.stderr.on('data', d => { cOut += d; });
    await new Promise(r => setTimeout(r, 2500));
    try {
      assert.notEqual(c.exitCode, null, `前提：C 应当因端口被占而启动失败（C 输出：${cOut.slice(0, 200)}）`);
      const pidPath2 = join(dataDir2, 'app.pid');
      const pidC = existsSync(pidPath2) ? readFileSync(pidPath2, 'utf8').trim() : null;
      assert.equal(
        pidC, null,
        `启动失败后留下了陈旧 pid 文件（${pidC}）—— 指向已死进程 ⇒ 恢复闸会误判「服务没在跑」`,
      );
      // 并且失败信息要人话（不是一坨未捕获异常栈）
      assert.match(cOut, /启动失败|EADDRINUSE|地址已使用/, `启动失败必须给出人话报错（C 输出：${cOut.slice(0, 200)}）`);
    } finally {
      c.kill('SIGKILL');
      rmSync(dataDir2, { recursive: true, force: true });
    }
  } finally {
    a.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 600));
  }
});

// ══════════════════════════════════════════════════════════════════
// F14：can() 对【角色授权】不做作用域判定 ⇒ 任意队长能管理【别人的】队伍
// ══════════════════════════════════════════════════════════════════
test('F14 A 队队长不得汰换 B 队成员（跨队越权）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-xt-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  const { insertCapability, insertRoleCapability } = await import('../src/db/repo/capabilities.js');
  const { insertRole, insertUserRole } = await import('../src/db/repo/roles.js');
  for (const [k, d] of [['team:manage', '管理战队成员'], ['team:read', '读取战队']]) insertCapability(db, k, d);
  for (const [k, d] of [['captain', '队长'], ['member', '组员']]) insertRole(db, k, d);
  insertRoleCapability(db, 'captain', 'team:manage');
  insertRoleCapability(db, 'captain', 'team:read');
  insertRoleCapability(db, 'member', 'team:read');

  const capA = createUser(db, { name: 'A队长', phone: '13800000901', password: 'pw', mbaStatus: 'mba' });
  const capB = createUser(db, { name: 'B队长', phone: '13800000902', password: 'pw', mbaStatus: 'mba' });
  const memB = createUser(db, { name: 'B组员', phone: '13800000903', password: 'pw', mbaStatus: 'mba' });
  const spare = createUser(db, { name: '闲人', phone: '13800000904', password: 'pw', mbaStatus: 'mba' });
  insertUserRole(db, capA.id, 'captain');
  insertUserRole(db, capB.id, 'captain');
  insertUserRole(db, memB.id, 'member');

  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_a','ed1','甲队','${capA.id}','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_b','ed1','乙队','${capB.id}','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_a','${capA.id}','captain','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_b','${capB.id}','captain','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_b','${memB.id}','member','${now}')`);
  for (const u of [capA, capB, memB, spare]) {
    db.exec(`INSERT INTO registrations (id,edition_id,user_id,answers_json,dimension_scores_json,raw_score,level,level_final,status,created_at)
             VALUES ('r_${u.id}','ed1','${u.id}','{}','{}',80,'B','B','accepted','${now}')`);
  }

  try {
    const { replaceMember } = await import('../src/services/team.js');
    let err = null;
    try {
      replaceMember({
        db, teamId: 'team_b', outUserId: memB.id, inUserId: spare.id,
        actorId: capA.id, now, rules,
      });
    } catch (e) { err = e; }
    // 修复前：A 队长成功汰换了 B 队的成员（can() 对角色授权不做作用域判定）
    assert.ok(err, 'A 队队长成功汰换了 B 队成员（跨队越权）—— can() 对角色授权未做作用域判定');
    assert.equal(err.status, 403, `期望 403，实际 ${err.status}：${err.message}`);
    // 且 B 队成员没被动过
    const members = db.prepare('SELECT user_id, role FROM team_members WHERE team_id = ? AND left_at IS NULL').all('team_b');
    assert.equal(members.length, 2, 'B 队成员被改动了');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F15：claimTask 不校验任务归属 ⇒ 跨队抢走别人的任务
// ══════════════════════════════════════════════════════════════════
test('F15 A 队不得领取 B 队的任务（跨队抢任务）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-hj-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();

  const capA = createUser(db, { name: 'A队长', phone: '13800000911', password: 'pw', mbaStatus: 'mba' });
  const capB = createUser(db, { name: 'B队长', phone: '13800000912', password: 'pw', mbaStatus: 'mba' });
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_a','ed1','甲队','${capA.id}','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_b','ed1','乙队','${capB.id}','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_a','${capA.id}','captain','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_b','${capB.id}','captain','${now}')`);
  db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
           VALUES ('tp_b','ed1',NULL,'某企业','乙队任务包','p','e','a',0,'${capB.id}','published','{}','${now}')`);
  db.exec(`INSERT INTO workflows (id,edition_id,task_package_id,name,created_at) VALUES ('wf_b','ed1','tp_b','乙队工作流','${now}')`);
  db.exec(`INSERT INTO workflow_tasks (id,workflow_id,title,detail,owner_team_id,status,due_at,created_at) VALUES ('wt1','wf_b','乙队的任务','d','team_b','todo',NULL,'${now}')`);

  try {
    const { claimTask } = await import('../src/services/workflow.js');
    let err = null;
    try {
      claimTask({ db, taskId: 'wt1', userId: capA.id, teamId: 'team_a', now });
    } catch (e) { err = e; }
    // 修复前：A 队成功领取 B 队的任务（claimTask 从不校验任务归属）
    assert.ok(err, 'A 队成功领取了 B 队的任务（跨队抢任务）—— claimTask 未校验任务归属');
    assert.equal(err.status, 403, `期望 403，实际 ${err.status}：${err.message}`);
    // B 队的任务状态没被动过
    const t = db.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get('wt1');
    assert.equal(t.status, 'todo', 'B 队的任务状态被改动了');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F16：签级表单在【第一次评估之后】永久失效（packages 投影缺 minScore/maxScore）
// ══════════════════════════════════════════════════════════════════
test('F16 签级表单：评估过一次任务卡后仍必须能签级', async () => {
  const W = join(platformDir, 'web/views/admin-task-packages.js');
  const { solvabilitySpecFromPackages, solvabilitySpecFromRules, gradeTiers } = await import(W);
  const rules = JSON.parse(readFileSync(join(rulesDir, 'solvability.json'), 'utf8'));

  // 评估前：没有任务卡带 explain ⇒ 走规则投影 ⇒ 档位齐
  const before = solvabilitySpecFromPackages([{ id: 'p1', status: 'submitted' }])
    ?? solvabilitySpecFromRules(rules);
  assert.equal(gradeTiers(before).complete, true, '前提：评估前签级档位应就绪');

  // 评估后：那一张卡带上了 meta.solvability.explain **与服务端投影的完整档位定义**
  //   （服务端修复后会把 grades 一并投影进 meta.solvability —— 见 services/taskPackage.js）
  const serverGrades = rules.grades.map((g) => ({
    key: g.key,
    minScore: g.minScore,
    maxScore: g.maxScore,
    commitment: g.commitment ?? '',
    agreement: g.agreement ?? '',
  }));
  const after = solvabilitySpecFromPackages([{
    id: 'p1', status: 'assessed', grade: 'B',
    meta: { solvability: { explain: [
      { dimension: 'capability', label: '能力维度', weight: 0.35, max: 5 },
    ], grades: serverGrades } },
  }]) ?? solvabilitySpecFromRules(rules);
  const tiers = gradeTiers(after);
  // 修复前：前端**不读** meta.solvability.grades ⇒ 投影出的 grades 只有 key、没有 minScore
  //        ⇒ gradeTiers 判定「档位未就绪」⇒ 签级控件整片消失（自锁）
  assert.equal(
    tiers.complete, true,
    '评估过一次任务卡后签级档位就绪状态丢失（packages 投影缺 minScore/maxScore）',
  );
  assert.ok(tiers.approve.length > 0, '签级下拉框没有可选项');

  // ⚛️ 另一半的病根也必须钉住：**视图的取规格路径要规则优先**。
  //    只修投影、不修优先级的话：生产环境不挂 /rules/（只有 DEMO_MODE=1）⇒ 规则投影取不到，
  //    而**旧数据**（修复前评估过的卡）没有 grades ⇒ 包投影残缺 ⇒ 照样「档位未就绪」。
  //    视图里那两个解析器曾**相反**（resolveSolvabilitySpec 规则优先 / load() 包投影优先）。
  const viewSrc = readFileSync(join(webDir, 'views', 'admin-task-packages.js'), 'utf8');
  assert.ok(
    viewSrc.includes('resolveSolvabilitySpec({ packages, rules:'),
    '视图必须走 resolveSolvabilitySpec（规则投影优先）—— 包投影优先会让签级自锁',
  );
  assert.ok(
    !/solvabilitySpecFromPackages\(packages\)\s*\?\?/.test(viewSrc),
    '视图里不得再出现「包投影 ?? 规则投影」这种把残缺规格放在前面的写法',
  );
});

// ══════════════════════════════════════════════════════════════════
// F17：演示站「建队」100% 失败（前端不带 memberIds，演示版按人数下限拒）
//      真实后端却接受同样的 body ⇒ 演示与生产漂移
// ══════════════════════════════════════════════════════════════════
test('F17 演示站建队必须与真实后端同口径（前端不发 memberIds 也能建队）', async () => {
  const { demoTeamFormation } = await import('../web/api.demo.js');
  const rules = JSON.parse(readFileSync(join(rulesDir, 'team-formation.json'), 'utf8'));

  // 前端 web/views/team.js:468-472 发的 body：{ editionId, name, taskPackageId }（无 memberIds）
  const team = {
    id: 'team_demo_1', name: '演示战队', packageId: 'tp_demo_1',
    captainId: 'u_mba_1', memberIds: [], tier: 'D', status: 'forming',
  };
  const state = {
    users: [{ id: 'u_mba_1', mbaStatus: 'mba' }],
    taskPackages: [{ id: 'tp_demo_1' }],
  };
  const formation = demoTeamFormation({ team, state, rules });
  // 修复前：size 0 < min 2 ⇒ 400 TEAM_FORMATION_INVALID（演示站建队按钮 100% 失败）
  assert.equal(
    formation.ok, true,
    `演示站建队被拒：${JSON.stringify(formation.errors)}（真实后端接受同样的 body：队长自动成为首个成员）`,
  );
});

// ═══ F11（运行时）：匿名访客的榜单响应里不得出现评委 id ═══
// ⚠️ 上面那条用例只测**裁剪函数**本身；它抓不住「告警明细里真的带了评委 id」。
//    ⇒ 这里走完整路径：真算一次赛段（评委池只有 1 人 ⇒ 池不合规 ⇒ 告警明细带 judgeId）
//      → 公开榜单（匿名访客）⇒ 响应里不得出现那个 id。
test('F11 运行时：匿名访客的榜单响应里不得泄漏评委 id（走真实计算 + 榜单路径）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const now = '2026-10-23T10:00:00.000Z';
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
    const judge = createUser(db, { name: '评委甲', phone: '13900000081', password: 'pw' });
    const captain = createUser(db, { name: '一队队长', phone: '13900000082', password: 'pw' });
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm1','ed1','一队','${captain.id}','${now}')`);
    assignStageJudge(db, { stageId: 'st1', userId: judge.id, seat: 'judge', now });
    db.exec(
      `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
       VALUES ('r1','st1','${judge.id}','tm1','track_fit',80,'${now}','req_1',0)`,
    );

    const { insertSnapshot } = await import('../src/db/repo/computations.js');
    // ⚠️ 泄漏的真实载体是**计算快照里的告警明细**（榜单把快照的 warnings 直接带给访客）。
    //    ⇒ 这里写一份**带评委 id 明细**的快照（等价于「历史上算出来的那一份」），
    //      再看公开榜单会不会把它原样端出去。
    const leakId = 'u_judge_leak_0001';
    insertSnapshot(db, {
      kind: 'stage_score', editionId: 'ed1', stageId: 'st1', teamId: null,
      ruleVersion: '2026-10-23',
      input: {}, trace: {},
      output: {
        // ⚠️ **形状照抄生产代码**（compute.js:212-217）：`message` 只列错误 **code**，
        //    带原始 judgeId 的是 `errors[].message` ⇒ 泄漏就发生在 `errors` 这个字段上。
        warnings: [{
          code: 'judge_pool_invalid',
          message: '评委池不合规（1 项）：duplicate_judge',
          errors: [{ code: 'duplicate_judge', message: `评委名单里有 1 个重复的 judgeId：${leakId}` }],
          stats: { total: 3, voting: 3, enterprise: 1, expert: 2, observer: 0, perDimension: { all: 3 } },
        }],
      },
      revision: 1, now,
    });

    // 公开榜单（匿名访客 = viewer 为 null）
    const { getLeaderboard } = await import('../src/services/leaderboard.js');
    const lb = getLeaderboard({ db, stageId: 'st1', scope: 'rank', viewer: null, rules });
    const dumped = JSON.stringify(lb);
    assert.ok(
      !dumped.includes(leakId),
      `匿名访客的榜单里泄漏了评委 id：${dumped.slice(0, 400)}`,
    );
    // 告警**一条都不许少**（裁的是字段，不是告警）
    assert.ok(
      (lb.warnings ?? []).some((w) => w.code === 'judge_pool_invalid'),
      '告警本身必须保留（降级必须显式展示，不静默）',
    );
    // 正对照：有 audit:read 的人**必须**拿到完整明细（否则就成了「把告警藏起来」）
    const admin = createUser(db, { name: '组委会', phone: '13900000083', password: 'pw' });
    setSuperadmin(db, admin.id);
    insertCapability(db, 'audit:read', '读审计日志');
    grantAssignment(db, {
      userId: admin.id, capability: 'audit:read', scopeType: 'global', scopeId: null, grantedBy: admin.id,
    });
    const lbAudit = getLeaderboard({ db, stageId: 'st1', scope: 'rank', viewer: admin, rules });
    assert.ok(
      JSON.stringify(lbAudit).includes(leakId),
      '有 audit:read 的人必须拿到完整告警明细（裁剪只针对公开视角，不许把告警藏起来）',
    );
  } finally { close(); }
});

// ═══ F17（运行时）：演示站用前端真实的 body 建队必须成功 ═══
// ⚠️ 上面那条用例只测 `demoTeamFormation` 这个纯函数；它抓不住「演示站的前端
//    真的按这个 body 建队失败」。⇒ 这里走**演示站的 HTTP 适配器**：登录 → 按前端
//    真实发的 body 建队 ⇒ 必须成功。
test('F17 运行时：演示站按前端真实的 body 建队必须成功（不是 100% 失败）', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const seed = JSON.parse(rf(join(platformDir, 'web', 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(rulesDir);
  const { createDemoApi } = await import('../web/api.demo.js');
  const m = new Map();
  const storage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
  const api = createDemoApi({ storage, seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  // ⚠️ 前端 web/views/team.js 真实发的 body：**不带 memberIds**
  const team = await api.post('/api/teams', { editionId: 'ed_demo', name: '演示新队', taskPackageId: 'tp_retail' });
  assert.ok(team?.id, `演示站建队必须成功，实际返回：${JSON.stringify(team)}`);
  assert.equal(team.name, '演示新队');
});

// ══════════════════════════════════════════════════════════════════
// F18：前端路由的畸形百分号编码会抛 URIError ⇒ 整页白屏（后端同类问题已修）
// ══════════════════════════════════════════════════════════════════
test('F18 前端路由遇到畸形百分号编码不得抛异常（白屏）', async () => {
  const { route, match } = await import('../web/router.js');
  route('/review/:stageId', () => {});
  route('/audit/:computationId', () => {});
  route('/tiebreak/:stageId', () => {});
  for (const p of ['/review/%E0%A4%A', '/audit/%', '/review/%zz', '/tiebreak/%']) {
    let err = null;
    try { match(p); } catch (e) { err = e; }
    // 修复前：URIError 抛出，而 app.js 的 match() 在 try 之外 ⇒ 错误卡片永远不渲染 ⇒ 白屏
    assert.equal(err, null, `前端路由对 ${p} 抛了 ${err?.name}：${err?.message}（会白屏）`);
  }
});

// ══════════════════════════════════════════════════════════════════
// F19：限频计数被幂等事务回滚 ⇒ 加个 requestId 就能绕过唯一的限频端点
// ══════════════════════════════════════════════════════════════════
test('F19 幂等事务内的限频计数不得被回滚（否则限频可被 requestId 绕过）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rl-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  try {
    const { assertRateLimit } = await import('../src/services/rate-limit.js');
    const { withIdempotency } = await import('../src/services/idempotency.js');
    const limits = rules.audit.rateLimit;
    const subjectKey = 'appeal:u1';

    // 连续 6 次：限频在事务内，业务层随后抛错 ⇒ 计数被 ROLLBACK TO 回滚
    for (let i = 0; i < 6; i++) {
      try {
        withIdempotency({ db, key: `r${i}`, scope: 'appeal:u1', requestId: `r${i}`, now }, () => {
          assertRateLimit({ db, subjectKey, rule: 'appealSubmit', now, limits, subjects: { default: subjectKey } });
          throw new Error('业务层失败');
        });
      } catch { /* expected */ }
    }
    const rows = db.prepare('SELECT COUNT(*) AS n FROM rate_limit_events WHERE subject_key = ?').get(subjectKey);
    // 修复前：0（连 5 秒提交锁那一行都被回滚了）⇒ 限频完全失效
    assert.ok(
      rows.n > 0,
      '限频计数被幂等事务的回滚清空了（连提交锁都没有留下）⇒ 加上 requestId 就能无限绕过限频',
    );
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F6：CI 必须真的跑完 5 道机器闸，且 `RW` 提取为空时要报错（不能按 0 放行）
// ══════════════════════════════════════════════════════════════════
test('F6 CI 必须真跑 5 道机器闸，且 RW 提取为空不得按 0 放行', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  // 1) 5 道闸都必须出现在 CI 里
  const gates = [
    'scripts/audit-scan.js',
    'scripts/temp-leak-scan.js',
    'scripts/bash-var-scan.js',
    'docs/tools/dead-service-scan.mjs',
    'docs/tools/plan-block-audit.mjs',
  ];
  const missing = gates.filter((g) => !ci.includes(g));
  assert.deepEqual(missing, [], `CI 缺少这些机器闸：${missing.join(', ')}`);

  // 2) `RW` 提取为空时不能当成 0 放行 —— 现在是 `${RW:-0}`，提取失败就静默按 0 处理
  const rwLine = ci.split('\n').find((l) => l.includes('RW=') && l.includes(':-0'));
  assert.equal(
    rwLine, undefined,
    `CI 的 RW 提取为空时会按 0 放行（假绿）：${rwLine?.trim()}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F4：rules/audit.json 里的限频 profile 必须真的被生产代码引用
// ══════════════════════════════════════════════════════════════════
test('F4 rules/audit.json 里的每个限频 profile 都必须有生产调用方', async () => {
  const auditCfg = JSON.parse(readFileSync(join(rulesDir, 'audit.json'), 'utf8'));
  const profiles = Object.keys(auditCfg.rateLimit ?? {});
  assert.ok(profiles.length > 0, 'audit.json 应当有至少一个限频 profile');

  // 扫 src/ 下所有生产代码，看每个 profile 名有没有被引用
  const { readdirSync, statSync } = await import('node:fs');
  const srcFiles = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) srcFiles.push(p);
    }
  };
  walk(join(platformDir, 'src'));

  const missing = [];
  for (const name of profiles) {
    const used = srcFiles.some((f) => {
      const t = readFileSync(f, 'utf8');
      return new RegExp(`['"\`]${name}['"\`]`).test(t);
    });
    if (!used) missing.push(name);
  }
  // 修复前：reviewSubmit / judgeHourly 从未被引用 ⇒ 评审提交无限频、评委无每小时配额
  assert.deepEqual(
    missing, [],
    `这些限频 profile 配了却没有任何生产代码引用（配置在说谎）：${missing.join(', ')}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F4（运行时交叉验证）：静态引用只是「配置不再说谎」，
//   **限频到底有没有真的生效**必须用真实请求证明 ——
//   修复前实测：评委连打 40 次评分 → 状态直方图 { '200': 40 } ⇒ 一个 429 都没有。
// ══════════════════════════════════════════════════════════════════

/**
 * 造一个「能打分」的最小现场：届期 + 出题企业 + 任务包 + 队伍 + 赛段 + 评委。
 * 返回评委的 session cookie 与打分所需的 stageId / teamId。
 * ⚠️ 造**两个**评委：正对照要用（限频必须按评委分 subject，不能一刀切全站皆禁）。
 */
function seedJudgeStage(db) {
  const NOW = '2026-10-23T12:00:00.000Z';
  const edition = createEdition(db, {
    name: '限频现场 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900008801', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900008802', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900008804', password: 'pw' });
  insertCapability(db, 'score:write', '写入评分');
  for (const u of [judge, judge2]) {
    grantAssignment(db, {
      userId: u.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: enterprise.id,
    });
  }
  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: enterprise.id, now: NOW,
  });
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: judge.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  return {
    stageId: stage.id,
    teamId: team.id,
    cookie: `hk_session=${createSession(db, judge.id).token}`,
    cookie2: `hk_session=${createSession(db, judge2.id).token}`,
  };
}

test('F4 评审提交端点必须真的限频（连打必须出现 429，不能全是 200）', async () => {
  const { rules } = loadRules(rulesDir);
  const profile = rules.audit.rateLimit.reviewSubmit;
  const max = profile.sliding.max;
  await withServer(async ({ base, db }) => {
    const { stageId, teamId, cookie, cookie2 } = seedJudgeStage(db);
    const statuses = [];
    let last = null;
    for (let i = 0; i < max + 5; i += 1) {
      const res = await call(base, 'POST', `/api/stages/${stageId}/reviews`, {
        cookie,
        body: { items: [{ teamId, dimension: 'innovation', rawScore: 80 }] },
      });
      statuses.push(res.status);
      last = res;
    }
    // 修复前：40 次连打全部 200（实测「一个 429 都没有 ⇒ 限频根本没生效」）
    assert.ok(
      statuses.includes(429),
      `连打 ${max + 5} 次必须出现 429（限频没生效）：${statuses.join(',')}`,
    );
    assert.equal(
      statuses[max], 429,
      `第 ${max + 1} 次必须被限频（滑动窗口 ${max}/${profile.sliding.seconds}s）：${statuses.join(',')}`,
    );
    assert.equal(JSON.parse(last.text).error.code, 'RATE_LIMITED');
    assert.ok(
      last.headers['retry-after'],
      '429 必须带 Retry-After 头（限频触发要告诉调用方等多久，不静默丢包）',
    );
    // ⛔ 正对照：限频是**按评委**算的（subject = 评委 id）——
    //    别的评委必须照常提交。若这里也 429，说明限频接成了「全局一刀切」。
    const other = await call(base, 'POST', `/api/stages/${stageId}/reviews`, {
      cookie: cookie2,
      body: { items: [{ teamId, dimension: 'innovation', rawScore: 80 }] },
    });
    assert.equal(other.status, 200, `别的评委必须照常提交（限频按评委分 subject）：${other.text}`);
  });
});

test('F4 登录端点必须真的限频（连续错误口令必须出现 429）', async () => {
  const { rules } = loadRules(rulesDir);
  const max = rules.audit.rateLimit.loginAttempt.sliding.max;
  await withServer(async ({ base, db }) => {
    const phone = '13900008803';
    createUser(db, { name: '爆破目标', phone, password: 'right-password' });
    // ⛔ 正对照先跑：**成功**的登录不消耗配额
    //    （否则正常用户多设备/多标签页反复登录会被自己的配额挡住 —— 那是误伤）
    for (let i = 0; i < max + 3; i += 1) {
      const ok = await call(base, 'POST', '/api/auth/login', { body: { phone, password: 'right-password' } });
      assert.equal(ok.status, 200, `第 ${i + 1} 次正确登录必须成功（成功不消耗限频配额）：${ok.text}`);
    }
    const statuses = [];
    let last = null;
    for (let i = 0; i < max + 5; i += 1) {
      const res = await call(base, 'POST', '/api/auth/login', { body: { phone, password: 'wrong-password' } });
      statuses.push(res.status);
      last = res;
    }
    // 修复前：30 次错误口令全部 401、零 429 ⇒ 可无限爆破
    assert.ok(
      statuses.includes(429),
      `连续 ${max + 5} 次错误口令必须出现 429（登录端点完全无限频）：${statuses.join(',')}`,
    );
    assert.equal(
      statuses[max], 429,
      `第 ${max + 1} 次错误口令必须被限频（滑动窗口 ${max}/60s）：${statuses.join(',')}`,
    );
    assert.equal(JSON.parse(last.text).error.code, 'RATE_LIMITED');
    assert.ok(last.headers['retry-after'], '429 必须带 Retry-After 头');
  });
});

// ══════════════════════════════════════════════════════════════════
// 第二批（来自 auth / domain 两路审计）：跨队 / 跨企业 / 跨届期的写权限缺口
//   F31 任务卡提交可冒用任意企业主体（enterpriseId 未校验归属）
//   F34 team_result 申诉无归属校验
//   F35 破同分链用 String(value) 分桶 ⇒ 1 ULP 之差被判为不同名次
//   F36 review_state 的 FINALIZED 没有任何生产者 ⇒ team_result 申诉整条链路是死的
//   F37 publishLeaderboard 无事务
//   F38 行为分可无限刷（weekly_progress 无 once / 无节奏 / 无去重）
// ══════════════════════════════════════════════════════════════════

// ── 第二批用的辅助 ───────────────────────────────────────────────
function freshDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-b2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close };
}

// 角色 ⇒ 能力点 = 全局授权（这正是 F14/F29 的根因：can() 对角色授权不做作用域判定）
function grantRole(db, roleKey, caps) {
  insertRole(db, roleKey, roleKey);
  for (const c of caps) {
    insertCapability(db, c, c);
    insertRoleCapability(db, roleKey, c);
  }
}

// ═══ F31：任务卡提交可冒用任意企业主体 ═══
test('F31 提交任务卡时 enterpriseId 必须属于提交人，不得冒用他人企业', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const { submitTaskPackage } = await import('../src/services/taskPackage.js');
    const now = new Date().toISOString();
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);

    const entA = createUser(db, { name: '企业A', phone: '13900000001', password: 'pw', mbaStatus: 'other' });
    const entB = createUser(db, { name: '企业B', phone: '13900000002', password: 'pw', mbaStatus: 'other' });
    grantRole(db, 'enterprise', ['task_package:submit']);

    const pkg = submitTaskPackage({
      db, userId: entA.id, rules, now,
      payload: {
        editionId: 'ed1', title: '题', painPoint: '痛点',
        expectedDelivery: '交付', acceptanceCriteria: '验收',
        enterpriseId: entB.id,                 // ← 冒用企业B
        enterpriseName: '企业B',
        consent: { accepted: true },
      },
    });
    // 修复前：enterprise_id 变成 entB.id —— 攻击者替别人挂名
    assert.notEqual(
      pkg.enterpriseId, entB.id,
      `任务卡的 enterprise_id 被写成了别人的企业（${pkg.enterpriseId}）—— 冒用成功`,
    );
  } finally { close(); }
});

// ═══ F34：team_result 申诉无归属校验 ═══
test('F34 对他人队伍的结果提交申诉必须被拒（须校验申诉人属于该队）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const { fileAppeal } = await import('../src/services/review-state.js');
    const now = new Date().toISOString();
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    const capA = createUser(db, { name: 'A队长', phone: '13900000011', password: 'pw', mbaStatus: 'mba' });
    grantRole(db, 'captain', ['appeal:write']);
    insertUserRole(db, capA.id, 'captain');

    let err = null;
    try {
      fileAppeal({
        db, filedBy: capA.id, now, rules,
        subjectType: 'team_result',
        subjectId: 'st1:teamB',       // ← 别人的队伍
        reason: 'ha',
      });
    } catch (e) { err = e; }
    // 修复前：不是 403 —— 要么因状态不对 409，要么直接受理（无归属校验）
    assert.equal(
      err?.status ?? 403, 403,
      `对他人队伍结果申诉未被 403 拒绝（实际：${err?.code ?? '受理成功'} ${err?.message ?? ''}）—— 申诉无归属校验`,
    );
  } finally { close(); }
});

// ═══ F36：review_state 的 FINALIZED 没有任何生产者 ═══
test('F36 review_state 必须有 FINALIZED 的生产者（否则 team_result 申诉整条链路是死的）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const srcDir = join(platformDir, 'src');
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(srcDir);

  // 缺陷的本质：**没有任何代码把 review_state 推进到 FINALIZED**。
  //   转移表里 CONFIRMED → FINALIZED 是允许的，但 src/ 里没有一处 transition({... to: 'FINALIZED' })。
  //   现有的两处 transition() 调用（review-state.js:359/364）都写着 from: 'FINALIZED'，
  //   也就是说它们【消费】FINALIZED，却【不生产】它 —— 状态机是个闭环。
  // ⇒ fileAppeal 对 team_result 永远 409，decideAppeal 的「撤销终稿 → 重算」分支永远不可达。
  const producers = files.filter((f) => {
    const s = readFileSync(f, 'utf8');
    return /to\s*:\s*['"]FINALIZED['"]/.test(s);
  });
  assert.ok(
    producers.length > 0,
    `没有任何代码把 review_state 推进到 FINALIZED（找到的写入方：${producers.join(', ') || '无'}）`
    + ' —— 转移表允许 CONFIRMED → FINALIZED，但 src/ 里没有一处 transition({..., to: \'FINALIZED\' })。'
    + '发布/计算终稿时必须写这条迁移，否则 fileAppeal 对 team_result 永远 409、'
    + 'decideAppeal 的撤销终稿分支永远不可达',
  );
});

// ═══ F36（运行时）：发榜后 team_result 申诉必须真的能被受理 ═══
// ⚠️ 上面那条用例只是**静态扫描**（查源码里有没有 `to: 'FINALIZED'` 字面量）——
//    它能抓住「生产者根本不存在」，但抓不住「生产者写了、却写错了状态/主体/时机」。
//    ⇒ 这里补一条**端到端**用例：真的发一次榜，然后真的去提交一条 team_result 申诉。
test('F36 发榜后对赛段结果提交申诉必须被受理（FINALIZED 的生产者真的在工作）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const now = new Date().toISOString();
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
    const admin = createUser(db, { name: '组委会', phone: '13900000031', password: 'pw' });
    const captain = createUser(db, { name: '一队队长', phone: '13900000032', password: 'pw' });
    insertCapability(db, 'stage:compute', '触发计算发榜');
    grantAssignment(db, {
      userId: admin.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: admin.id,
    });
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm1','ed1','一队','${captain.id}','${now}')`);
    // 赛段结果已算出来（否则 F12 的闸会拦下发榜）
    db.exec(`INSERT INTO stage_results (id,stage_id,team_id,total,seat_p,seat_e,created_at) VALUES ('sr1','st1','tm1',80,80,0,'${now}')`);
    // 档位 D（可申诉档位：rules/audit.json 的 appealAllowedTiers = ['D']）
    db.exec(`INSERT INTO tier_records (id,team_id,tier,milestone_count,business_signoff_count,reasons_json,computed_at) VALUES ('tr1','tm1','D',0,0,'[]','${now}')`);

    const { publishLeaderboard } = await import('../src/services/leaderboard.js');
    const published = publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: admin.id, now, rules });
    assert.equal(published.reviewState, 'FINALIZED', '发榜后赛段结果的复核状态必须是 FINALIZED');

    // 三步迁移都要留痕（可复盘）
    const moves = db.prepare("SELECT detail_json FROM audit_log WHERE action = 'review_state.transition' ORDER BY rowid").all();
    assert.equal(moves.length, 3, `发榜应写 3 条状态迁移（SUBMITTED→PENDING_REVIEW→CONFIRMED→FINALIZED），实际 ${moves.length} 条`);

    // 关键：队长对**本队**的结果提申诉 —— 必须被受理（修复前永远 409「未进入复核」）
    const { fileAppeal } = await import('../src/services/review-state.js');
    const appeal = fileAppeal({
      db, filedBy: captain.id, now, rules,
      subjectType: 'team_result',
      subjectId: 'st1:tm1',
      reason: '名次有异议',
    });
    assert.ok(appeal?.id, `发榜后申诉必须被受理，实际返回：${JSON.stringify(appeal)}`);
  } finally { close(); }
});

// ═══ F10（运行时）：生产路径必须按「提交动作」归并评分行 ═══
// ⚠️ 上面那条用例只测了**检测器**的输入契约；它抓不住「调用方仍然按行喂」。
//    ⇒ 这里走**完整生产路径**：真算一次赛段（computeStage → runDetection → flagged_reviews）。
//       ① 一次正常评审（1 评委 × 2 队 × 5 维度 = 10 行，同一个 request_id）⇒ **不得**有 burst 告警；
//       ② 6 次**真的**的提交（6 个 request_id）⇒ **必须**有 burst 告警（不能把检测改成永远不报）。
test('F10 生产路径必须按「提交动作」归并评分行（一次提交写 10 行 ≠ 10 次提交）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const now = '2026-10-23T10:00:00.000Z';
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
    const judge = createUser(db, { name: '评委甲', phone: '13900000071', password: 'pw' });
    const captain1 = createUser(db, { name: '一队队长', phone: '13900000072', password: 'pw' });
    const captain2 = createUser(db, { name: '二队队长', phone: '13900000073', password: 'pw' });
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm1','ed1','一队','${captain1.id}','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm2','ed1','二队','${captain2.id}','${now}')`);
    assignStageJudge(db, { stageId: 'st1', userId: judge.id, seat: 'judge', now });

    const dims = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];
    const insertReview = (id, team, dim, requestId, at) => db.exec(
      `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
       VALUES ('${id}','st1','${judge.id}','${team}','${dim}',80,'${at}','${requestId}',0)`,
    );

    // ① 一次正常评审：10 行，同一个 request_id
    for (const team of ['tm1', 'tm2']) {
      for (const dim of dims) insertReview(`r_${team}_${dim}`, team, dim, 'req_1', now);
    }
    const { computeStage } = await import('../src/services/compute.js');
    computeStage({ db, stageId: 'st1', actorId: judge.id, now, rules });

    const burst = db.prepare("SELECT id, detail_json FROM flagged_reviews WHERE kind = 'burst_submit'").all();
    assert.equal(
      burst.length, 0,
      `一次正常评审（10 行、同一个 request_id）被误判为刷分：${JSON.stringify(burst).slice(0, 300)}`,
    );

    // ② 6 次真的提交（6 个 request_id）⇒ 必须报得出（不能把检测改成永远不报）
    //    ⚠️ `stage_reviews` 对 (stage_id, judge_id, team_id, dimension) 有唯一约束
    //    ⇒ 同一个评委不能对同一队同一维度重复插 ⇒ 改用**第二位评委**的 6 个格子。
    const judge2 = createUser(db, { name: '评委乙', phone: '13900000074', password: 'pw' });
    assignStageJudge(db, { stageId: 'st1', userId: judge2.id, seat: 'judge', now });
    const combos = [['tm1', 'track_fit'], ['tm1', 'innovation'], ['tm1', 'feasibility'],
      ['tm2', 'track_fit'], ['tm2', 'innovation'], ['tm2', 'feasibility']];
    combos.forEach(([team, dim], i) => {
      const at = new Date(Date.parse(now) + i * 1000).toISOString();
      db.exec(
        `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
         VALUES ('r3_${i}','st1','${judge2.id}','${team}','${dim}',80,'${at}','req_${i}',0)`,
      );
    });
    computeStage({ db, stageId: 'st1', actorId: judge.id, now: '2026-10-23T10:00:10.000Z', rules });
    const burst2 = db.prepare("SELECT id, detail_json FROM flagged_reviews WHERE kind = 'burst_submit'").all();
    assert.equal(burst2.length, 1, '6 次提交必须仍然触发 burst_submit（检测器不能被改成永远不报）');
    const detail = JSON.parse(burst2[0].detail_json);
    assert.equal(detail.subjectId, judge2.id);
    assert.ok(detail.findingKey, '告警必须带稳定标识（不含时间戳）⇒ 重算不再刷屏');

    // ③ 没有 request_id 的行 ⇒ 无法归并成「提交动作」⇒ 不参与检测，且必须**显式告警**（不静默）
    const judge3 = createUser(db, { name: '评委丙', phone: '13900000075', password: 'pw' });
    assignStageJudge(db, { stageId: 'st1', userId: judge3.id, seat: 'judge', now });
    db.exec(
      `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
       VALUES ('r4_0','st1','${judge3.id}','tm1','completeness',80,'${now}',NULL,0)`,
    );
    const out3 = computeStage({ db, stageId: 'st1', actorId: judge.id, now: '2026-10-23T10:00:20.000Z', rules });
    const blind = (out3.warnings ?? []).find((w) => w.code === 'anticheat_burst_blind_spot');
    assert.ok(blind, '没有 request_id 的评分行必须显式告警（这条检测对它是盲区，不许静默）');
  } finally { close(); }
});

// ═══ F35：破同分链用 String(value) 分桶 ═══
test('F35 破同分分桶不得用 String(value) —— 1 ULP 之差会被判为不同名次', async () => {
  const { applyTiebreakChain } = await import('../src/domain/ranking.js');
  const chain = [
    { key: 'total', scope: 'always' },
    { key: 'teamId', scope: 'always', deterministic: true },
  ];
  const data = { byTeam: { A: { total: 70 }, B: { total: 70.00000000000001 } } };
  const candidates = [
    { teamId: 'A', values: { total: 70 } },
    { teamId: 'B', values: { total: 70.00000000000001 } },
  ];
  const out = applyTiebreakChain({ candidates, chain, data });
  const groups = out?.groups ?? out?.tieGroups ?? [];
  assert.ok(
    groups.length === 1,
    `total 差 1 ULP（1.42e-14）被判为不同组：${JSON.stringify(groups)} —— 分桶键用了 String(value)`,
  );
});

// ═══ F37：publishLeaderboard 无事务 ═══
test('F37 publishLeaderboard 必须在一个事务里（否则中途失败留下半成品）', async () => {
  const src = readFileSync(join(platformDir, 'src', 'services', 'leaderboard.js'), 'utf8');
  const fn = src.match(/export function publishLeaderboard[\s\S]{0,4000}/)?.[0] ?? '';
  assert.ok(
    /withTransaction|BEGIN IMMEDIATE|db\.exec\('BEGIN/.test(fn),
    'publishLeaderboard 里没有事务：写快照 → 写档位 → 记积分 → 写审计，任何一步失败都会留下半成品'
    + '（compute.js 已按同一纪律加了事务，publish 路径没有）',
  );
});

// ═══ F38：行为分可无限刷 ═══
test('F38 行为分必须有频次/去重约束（weekly_progress 无 once 且无节奏检查）', async () => {
  const { rules } = loadRules(rulesDir);
  const evs = rules.behavior.events ?? [];
  const repeatable = evs.filter((e) => !e.once);
  assert.ok(
    repeatable.length === 0,
    `这些行为事件没有 once 约束：${repeatable.map((e) => e.key).join(', ')}`
    + ' —— 同一事件可无限提交刷分（weekly_progress×40 = 80 分，完赛线 60）',
  );
  const svc = readFileSync(join(platformDir, 'src', 'services', 'behavior.js'), 'utf8');
  assert.ok(
    /idempot|dedup|duplicate|perWeek|cadence|window/i.test(svc),
    'behavior 写入路径没有任何去重/幂等/周期检查',
  );
});

// ══════════════════════════════════════════════════════════════════
// 第 7 批（E173）：授权 / 归属类 4 条 —— F30 / F40 / F42 / F33
//   F30 任意企业可伪造**他企**队伍的里程碑签字（被当作客观事实消费）
//   F40 竞品可往**任意队**写行为事件（改变对方的完赛认定）
//   F42 跨企业**签级重评**被授权（改的是进池的输入）
//   F33 人才池读取**不按届期隔离**（不带 editionId ⇒ 全表）
//
// ⚠️ **夹具按生产口径造**：企业席提交任务卡 ⇒ `task_packages.enterprise_id` = 提交人自己
//    （F31 修完后的服务层口径）。旧夹具把 enterprise_id 留空 ⇒ 那是「无主卡」，
//    根本触发不了「跨企业」这条路径 ⇒ **夹具不符合契约，用例就是假绿**。
// ⚠️ 每条用例都带**对照组**（本企业/本队必须仍然成功）——
//    只测「被拒」不测「该过的还过」，实现可以靠「一律拒」骗绿。
// ══════════════════════════════════════════════════════════════════

const SOLVABILITY_FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};
const BEHAVIOR_EVIDENCE = { repo: 'git@example.com:team/repo', version: 'v1.2.0', artifact: 'demo.zip' };

/** 两家企业 + 两支队的越权夹具（真实库 + 真 HTTP 服务）。 */
async function withTwoEnterprises(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-ent-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = new Date().toISOString();
  try {
    for (const [k, d] of [
      ['signoff:create', '企业里程碑签字'],
      ['task_package:write', '提交任务卡'],
      ['behavior:write', '提交行为分记录'],
    ]) insertCapability(db, k, d);

    // 两家企业，org 不同 ⇒「同企业」判定不能把甲误判成乙
    const entA = createUser(db, { name: '甲企业', phone: '13800001701', password: 'pw', org: '甲公司' });
    const entB = createUser(db, { name: '乙企业', phone: '13800001702', password: 'pw', org: '乙公司' });
    const capA = createUser(db, { name: 'A队长', phone: '13800001703', password: 'pw', mbaStatus: 'mba' });
    const capB = createUser(db, { name: 'B队长', phone: '13800001704', password: 'pw', mbaStatus: 'mba' });

    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    // ⚠️ 出题企业 = 乙公司（enterprise_id 与 submitted_by 都是乙企业本人）
    db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
             VALUES ('tp_b','ed1','${entB.id}','乙公司','乙队任务包','p','e','a',0,'${entB.id}','submitted','{}','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at) VALUES ('team_b','ed1','乙队','${capB.id}','tp_b','active','${now}')`);
    db.exec(`INSERT INTO team_members (id,team_id,user_id,role,joined_at) VALUES ('tm_b','team_b','${capB.id}','captain','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at) VALUES ('team_a','ed1','甲队','${capA.id}','tp_b','active','${now}')`);
    db.exec(`INSERT INTO team_members (id,team_id,user_id,role,joined_at) VALUES ('tm_a','team_a','${capA.id}','captain','${now}')`);
    db.exec(`INSERT INTO milestones (id,team_id,key,label,counts_toward_tier,requires_signoff,fixed_at,created_at)
             VALUES ('ms_b','team_b','problem_confirmed','企业问题确认',1,1,'${now}','${now}')`);

    const grant = (userId, capability) => grantAssignment(db, {
      userId, capability, scopeType: 'global', scopeId: null, grantedBy: null,
    });
    for (const u of [entA, entB]) { grant(u.id, 'signoff:create'); grant(u.id, 'task_package:write'); }
    for (const u of [capA, capB]) grant(u.id, 'behavior:write');

    await fn({
      base, db, now, entA, entB, capA, capB,
      tokenEntA: createSession(db, entA.id).token,
      tokenEntB: createSession(db, entB.id).token,
      tokenCapA: createSession(db, capA.id).token,
      tokenCapB: createSession(db, capB.id).token,
    });
  } finally {
    await new Promise((r) => server.close(r));
    close();
  }
}

// ═══ F30：任意企业可伪造他企队伍的里程碑签字 ═══
test('F30 任意企业不得给他企队伍的里程碑签字（伪造客观事实）', async () => {
  await withTwoEnterprises(async ({ base, db, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'POST', '/api/milestones/ms_b/signoff', {
      cookie: `hk_session=${tokenEntA}`,
      body: { department: '业务部', content: '确认已落地' },
    });
    assert.equal(r.status, 403, `甲企业给乙企业的队伍签字必须被拒，实际 ${r.status}：${r.text}`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs').get().n, 0,
      '伪造的签字不得落库（签字是「客观事实」，被系统消费后直接影响段位）',
    );
    // 对照组：出题企业本人签字必须成功（不能靠「一律拒」骗绿）
    const ok = await call(base, 'POST', '/api/milestones/ms_b/signoff', {
      cookie: `hk_session=${tokenEntB}`,
      body: { department: '业务部', content: '确认已落地' },
    });
    assert.equal(ok.status, 200, `出题企业本人签字必须成功：${ok.text}`);
  });
});

// ═══ F40：竞品可往任意队写行为事件 ═══
test('F40 竞品不得往他队写行为事件（行为分直接改变对方的完赛认定）', async () => {
  await withTwoEnterprises(async ({ base, db, tokenCapA, tokenCapB }) => {
    const r = await call(base, 'POST', '/api/teams/team_b/behavior-events', {
      cookie: `hk_session=${tokenCapA}`,
      body: { type: 'weekly_progress', evidence: BEHAVIOR_EVIDENCE },
    });
    assert.equal(r.status, 403, `A 队队长给 B 队写行为事件必须被拒，实际 ${r.status}：${r.text}`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n, 0,
      '他队的行为事件不得落库',
    );
    // 对照组：本队队长写自己的队必须成功
    const ok = await call(base, 'POST', '/api/teams/team_b/behavior-events', {
      cookie: `hk_session=${tokenCapB}`,
      body: { type: 'weekly_progress', evidence: BEHAVIOR_EVIDENCE },
    });
    assert.equal(ok.status, 200, `本队队长写本队必须成功：${ok.text}`);
  });
});

// ═══ F42：跨企业签级重评被授权 ═══
test('F42 跨企业签级重评必须被拒（他企任务卡的评级不得被改）', async () => {
  await withTwoEnterprises(async ({ base, db, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'POST', '/api/task-packages/tp_b/solvability', {
      cookie: `hk_session=${tokenEntA}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(r.status, 403, `甲企业重评乙企业的任务卡必须被拒，实际 ${r.status}：${r.text}`);
    const row = db.prepare('SELECT solvability_score FROM task_packages WHERE id = ?').get('tp_b');
    assert.equal(row.solvability_score, null, '他企任务卡的评级被改了');
    // 对照组：出题企业本人重评必须成功
    const ok = await call(base, 'POST', '/api/task-packages/tp_b/solvability', {
      cookie: `hk_session=${tokenEntB}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(ok.status, 200, `出题企业本人重评必须成功：${ok.text}`);
  });
});

// ═══ F42b：提交人本人仍可评自己提交的卡（代提交场景）═══
test('F42b 代提交场景：提交人本人可评自己提交的卡（提交人是唯一凭据时）', async () => {
  await withTwoEnterprises(async ({ base, db, entA, entB, tokenEntA, tokenEntB }) => {
    // 「企业管理员代企业 B 提交」：submitted_by = 管理员 A，enterprise_id = 出题企业 B
    // ⇒ A（提交人）可评；B（出题企业）可评；**别人**不可评。
    db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
             VALUES ('tp_c','ed1','${entB.id}','乙公司','代提交卡','p','e','a',0,'${entA.id}','submitted','{}','${new Date().toISOString()}')`);

    // 提交人 A：可评（他提交的卡）
    const bySubmitter = await call(base, 'POST', '/api/task-packages/tp_c/solvability', {
      cookie: `hk_session=${tokenEntA}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(bySubmitter.status, 200, `提交人本人必须能评自己提交的卡：${bySubmitter.text}`);

    // 出题企业 B：可评（这是他出的题）
    db.exec(`UPDATE task_packages SET status = 'submitted' WHERE id = 'tp_c'`);
    const byIssuer = await call(base, 'POST', '/api/task-packages/tp_c/solvability', {
      cookie: `hk_session=${tokenEntB}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(byIssuer.status, 200, `出题企业本人必须能能评自己出的题：${byIssuer.text}`);
  });
});

// ═══ F33：人才池读取不按届期隔离 ═══
test('F33 人才池读取必须按届期隔离（不带 editionId 不得返回其它届期的行）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const viewer = createUser(db, { name: '参赛者', phone: '13800001711', password: 'pw', mbaStatus: 'mba' });
    grantAssignment(db, {
      userId: viewer.id, capability: 'pool:read', scopeType: 'global', scopeId: null, grantedBy: null,
    });
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    // 参赛者报名了 ed_1 ⇒ 缺省届期应落到 ed_1
    db.exec(`INSERT INTO registrations (id,edition_id,user_id,answers_json,dimension_scores_json,raw_score,level,level_final,status,created_at)
             VALUES ('r_v','ed_1','${viewer.id}','{}','{}',80,'B','B','accepted','${now}')`);
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_1','${viewer.id}','ed_1','本人','某公司',10,'mba',1,'[]','${now}')`);
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${viewer.id}','ed_2','别届的人','别家公司',99,'other',3,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');
    const all = listPoolTalents({ db, filter: {}, viewer });
    assert.ok(
      all.every((r) => r.editionId === 'ed_1'),
      `不带 editionId 读人才池返回了其它届期的行：${JSON.stringify(all.map((r) => r.editionId))}`
      + ' —— 届期隔离是平台级约束（S2），池读取必须按届期隔离',
    );
    // 对照组：显式指定届期仍然只返回该届
    const scoped = listPoolTalents({ db, filter: { editionId: 'ed_1' }, viewer });
    assert.equal(scoped.length, 1, '指定届期时只返回该届的行');
    assert.equal(scoped[0].editionId, 'ed_1');
  } finally {
    close();
  }
});

// ═══ F33b：F33 的**残留面** —— 显式传 editionId 时也必须按届期隔离 ═══
// ⚠️ **为什么这是独立的一条**：F33 第一版只钉了「不带 editionId」的路径。
//    显式传 editionId 时 `canReadPool` 走 `can()` 的**角色分支**
//    （角色授权是全局的，INTERFACES.md:22）⇒ 任何持有 `pool:read` 的登录用户
//    带上**别届**的 editionId 就能读到别届参赛者的姓名 / 单位 / 积分 / MBA 状态。
//    ⇒ 届期隔离（S2）在显式路径上仍然是破的。
// ⚠️ **判别性要求**：本条必须同时钉住「别届读不到」**和**「本届读得到」
//    （只钉前者 ⇒ 实现退化成「一律拒」也能骗绿）。
test('F33b 显式传别届 editionId 也必须读不到（届期隔离在显式路径上不能是破的）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-b-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const viewer = createUser(db, { name: '参赛者', phone: '13800001721', password: 'pw', mbaStatus: 'mba' });
    // ⚠️ 授权走**角色**（captain/member/enterprise 都持有 pool:read）⇒ 角色分支全局命中
    insertRole(db, 'member', '组员');
    insertRoleCapability(db, 'member', 'pool:read');
    insertUserRole(db, viewer.id, 'member');
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    // 参赛者只报名了 ed_1
    db.exec(`INSERT INTO registrations (id,edition_id,user_id,answers_json,dimension_scores_json,raw_score,level,level_final,status,created_at)
             VALUES ('r_v','ed_1','${viewer.id}','{}','{}',80,'B','B','accepted','${now}')`);
    // 本届的池行（自己）
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_1','${viewer.id}','ed_1','本人','某公司',10,'mba',1,'[]','${now}')`);
    // **别届**的池行：别届的另一个人
    const other = createUser(db, { name: '别届的人', phone: '13800001722', password: 'pw', mbaStatus: 'other' });
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${other.id}','ed_2','别届的人','别家公司',99,'other',3,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');

    // ① 别届：必须读不到
    const otherEdition = listPoolTalents({ db, filter: { editionId: 'ed_2' }, viewer });
    assert.deepEqual(
      otherEdition, [],
      `显式传别届 editionId 却读到了 ${otherEdition.length} 行 —— 届期隔离（S2）在显式路径上是破的`
      + `（角色授权全局命中 ⇒ can() 表达不了「他属于哪一届」）`,
    );

    // ② 对照组：本届必须仍然读得到（防「一律拒」骗绿）
    const own = listPoolTalents({ db, filter: { editionId: 'ed_1' }, viewer });
    assert.equal(own.length, 1, '本人报名的那一届必须仍然读得到（不能把闸修成「一律拒」）');
    assert.equal(own[0].editionId, 'ed_1');
  } finally {
    close();
  }
});

// ═══ F33c：对照组 —— 组委会可以跨届读（防止把闸修成「谁都读不到」）═══
test('F33c 组委会（admin 角色）必须能跨届读池（闸不能修成「一律拒」）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-c-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const chair = createUser(db, { name: '组委会', phone: '13800001731', password: 'pw' });
    insertRole(db, 'admin', '组委会');
    insertRoleCapability(db, 'admin', 'pool:read');
    insertUserRole(db, chair.id, 'admin');
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    const someone = createUser(db, { name: '别届的人', phone: '13800001732', password: 'pw' });
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${someone.id}','ed_2','别届的人','别家公司',99,'other',3,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');
    const rows = listPoolTalents({ db, filter: { editionId: 'ed_2' }, viewer: chair });
    assert.equal(rows.length, 1, '组委会必须能跨届读池（跨届调度是组委会的职责）');
    assert.equal(rows[0].editionId, 'ed_2');
  } finally {
    close();
  }
});

// ═══ F33d：对照组 —— 企业侧（不报名，只出题）必须能读该届人才池 ═══
// ⚠️ 这一条钉的是**业务不回归**：企业通过提交任务卡参与，**不报名**
//    ⇒ 关联判据若只认报名，企业就永远看不到人才池（而人才池正是给企业挑人用的）。
test('F33d 出题企业（不报名）必须能读该届人才池（关联判据不能只认报名）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-d-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const ent = createUser(db, { name: '出题企业', phone: '13800001741', password: 'pw' });
    insertRole(db, 'enterprise', '企业席');
    insertRoleCapability(db, 'enterprise', 'pool:read');
    insertUserRole(db, ent.id, 'enterprise');
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    // 企业在 ed_2 出了一张任务卡（**没有报名记录**）
    db.exec(`INSERT INTO task_packages
              (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,status,submitted_by,submitted_at,deleted_at)
             VALUES ('tp_1','ed_2','${ent.id}','出题企业','题目','痛点','交付','验收','published','${ent.id}','${now}',NULL)`);
    const someone = createUser(db, { name: '人才', phone: '13800001742', password: 'pw' });
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${someone.id}','ed_2','人才','某公司',50,'mba',2,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');
    const rows = listPoolTalents({ db, filter: { editionId: 'ed_2' }, viewer: ent });
    assert.equal(rows.length, 1, '出题企业必须能读该届人才池（企业侧不报名 ⇒ 关联判据不能只认报名）');
    assert.equal(rows[0].editionId, 'ed_2');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// 第 8 批（E174）：领域算法 4 条 —— F43 / F44 / F45 / F46
//   F43 `scope:'tied_only'` 根本没实现（配置在说谎：改链序就能让互评变成主排序键）
//   F44 少维度的队伍被结构性抬高（**复核后判定为不成立**，见用例注释）
//   F45 去极值在评委数边界不连续（S7 §3.2 明写的整数阶跃 ⇒ 配置必须显式声明）
//   F46 归一化回退把整个赛段降级（S7 §3.1 的样本数口径 ⇒ 配置必须显式声明）
// ══════════════════════════════════════════════════════════════════

// ═══ F43：`tied_only` 作用域必须真的被实现 ═══
test('F43 破同分链的 tied_only 项必须排在 total 之后（互评不得进主排序）', async () => {
  const { applyTiebreakChain } = await import('../src/domain/ranking.js');

  // ① `tied_only` 的项排在 `total` **之前** ⇒ **必须拒绝对这条链算分**
  //    （R-RNK-05：互评只做破同分，从不进入主排序 —— 排在 total 之前就变成主排序键）
  //    ⚠️ 这条链**只**违反这一条（末项 deterministic、有 total、无 behavior 项）
  //    ⇒ 报错原因唯一，判别性不会被别的规则污染。
  //    ⚠️ **为什么需要这条闸（审计当时以为要「实现 tied_only」，那是错的）**：
  //    本引擎的排序是**字典序** ⇒ `always` 与 `tied_only` 在运行时**等价**
  //    （后面的键本来就只在前面的键打平时才比较）⇒ 「实现这个 scope」根本改不了输出
  //    （实测：真去实现它，6 条既有破同分用例当场变红 —— 字典序被破坏）。
  //    ⇒ 真正能破坏 R-RNK-05 的**只有链序**，而链序是**配置** ⇒ 必须机器闸。
  const badChain = [
    { key: 'peer', label: '互评分', direction: 'desc', scope: 'tied_only', source: 'S7 §3.3' },
    { key: 'total', label: '总分', direction: 'desc', scope: 'always', source: 'S7 §3.1' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always', deterministic: true, source: 'C-03' },
  ];
  assert.throws(
    () => applyTiebreakChain({
      candidates: [{ teamId: 'A', total: 90 }, { teamId: 'B', total: 50 }],
      chain: badChain,
      data: {},
    }),
    /tied_only/,
    '链首是 tied_only 的链必须被拒（否则改配置就能让互评变成主排序键）',
  );

  // ② 总分**相同**的两队 ⇒ 并列组里 `tied_only` 的键必须**真的生效**（否则破同分失效）
  const chain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always', source: 'S7 §3.1' },
    { key: 'peer', label: '互评分', direction: 'desc', scope: 'tied_only', source: 'S7 §3.3' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always', deterministic: true, source: 'C-03' },
  ];
  const out = applyTiebreakChain({
    candidates: [
      { teamId: 'A', total: 90, peer: 10 },
      { teamId: 'B', total: 90, peer: 99 },
    ],
    chain,
    data: {},
  });
  assert.deepEqual(
    out.ordered.map((c) => c.teamId), ['B', 'A'],
    '并列组里互评分必须能拆开（tied_only 不是「永不生效」）',
  );

  // ③ 总分**不同**的两队 ⇒ `tied_only` 的键**不得**把它们拆开（R-RNK-05 的实际效果）
  const out2 = applyTiebreakChain({
    candidates: [
      { teamId: 'A', total: 90, peer: 10 },
      { teamId: 'B', total: 50, peer: 99 },
    ],
    chain,
    data: {},
  });
  assert.deepEqual(
    out2.ordered.map((c) => c.teamId), ['A', 'B'],
    '互评只做破同分：总分不同的两队不得被互评分拆开',
  );
});

// ═══ F44：少维度的队伍被结构性抬高 —— **复核后判定为不成立**（本用例是「口径钉子」）═══
test('F44 缺分维度的权重按「记 0（不参与分子分母）」处理，且必须列入 warnings', async () => {
  // ⚠️ **这条审计结论经复核后判定为不成立**，理由（证据链）：
  //   ① 设计文档 §11「错误处理与失效防护」表原文：「某维度无人打分 | 该维度权重记 0
  //      并列入 warnings，**不静默当 0**」⇒ 规格要求的是「**权重**记 0」；
  //   ② 「权重记 0」的数学含义 = 该维度对分数**无影响**（既不加分也不减分）
  //      = 分子分母都不含它 = 现有实现（`seatScore` 的分母是**实际参与权重和**）；
  //   ③ 审计报告用「(0.2×80+0.2×80)/0.9 = 35.56」这个**「分数记 0」**的公式
  //      去检验「**权重**记 0」的规格 ⇒ 拿 A 去量 B ⇒ 「文案与行为不一致」的结论不成立；
  //   ④ 代码里的告警文案（`scoring.js`：「该维度权重记 0」）与实现**逐字一致**。
  //   ⇒ 结论：**不改计分行为**。本用例把口径**钉死**：将来若有人把它改成「缺分记 0」，
  //   这条用例会红 ⇒ 逼他先改规格。
  const { seatScore } = await import('../src/domain/trim.js');
  const out = seatScore({ dimensionScores: { a: 80 }, weights: { a: 0.5, b: 0.5 } });
  assert.equal(out.weightSum, 0.5, '缺分维度的权重不进分母（= 权重记 0）');
  assert.equal(out.score, 80, '结果是「已有维度上的相对加权平均」');
  assert.deepEqual(out.missing, ['b'], '缺分维度必须进 missing（⇒ 会被列成 warning，不静默）');

  // 文案与行为必须**对得上**：文案说「权重记 0」⇒ 权重确实不进分母
  const src = readFileSync(join(platformDir, 'src', 'domain', 'scoring.js'), 'utf8');
  assert.match(src, /该维度权重记 0/, '告警文案必须说明「权重记 0」');
  assert.match(src, /dimension_no_scores/, '缺分维度必须出 warning（不静默当 0）');
});

// ═══ F45 / F46：规则必须**显式声明**那些「刻意的阶跃与口径」 ═══
test('F45/F46 去极值阶跃与归一化样本数口径必须由规则显式声明，且有机器闸', async () => {
  const { loadRules, validateRules } = await import('../src/config.js');
  const { rules } = loadRules(rulesDir);

  // ① 规则里必须**写明**这两件事（配置自解释：否则下一个人会当 bug 去「修」）
  for (const key of ['initial', 'final']) {
    const cfg = rules.scoring[key];
    assert.equal(
      cfg.trimPolicy, 'threshold',
      `scoring.${key}.trimPolicy 必须显式声明「整数阶跃去极值」（S7 §3.2）—— 没有声明 ⇒ 没人知道这个阶跃是刻意的`,
    );
    assert.equal(
      cfg.minSamplesScope, 'judge_ratings_count',
      `scoring.${key}.minSamplesScope 必须显式声明「样本数 = 该评委在本赛段评过的队伍数」（S7 §3.1）`,
    );
  }

  // ② 机器闸：把声明**删掉** ⇒ 必须报错（不许悄悄生效）
  for (const key of ['initial', 'final']) {
    const broken = JSON.parse(JSON.stringify(rules));
    delete broken.scoring[key].trimPolicy;
    const errs = validateRules(broken, Object.keys(broken).length);
    assert.ok(
      errs.some((e) => e.includes(`scoring.${key}.trimPolicy`)),
      `删掉 scoring.${key}.trimPolicy 必须报错（配置在说谎 ⇒ 机器闸必须拦住）`,
    );

    const broken2 = JSON.parse(JSON.stringify(rules));
    delete broken2.scoring[key].minSamplesScope;
    const errs2 = validateRules(broken2, Object.keys(broken2).length);
    assert.ok(
      errs2.some((e) => e.includes(`scoring.${key}.minSamplesScope`)),
      `删掉 scoring.${key}.minSamplesScope 必须报错`,
    );
  }

  // ③ 机器闸：破同分链首改成 tied_only ⇒ 必须报错（R-RNK-05）
  const brokenChain = JSON.parse(JSON.stringify(rules));
  brokenChain.tiebreak.chain[0] = { ...brokenChain.tiebreak.chain[0], scope: 'tied_only' };
  const errs3 = validateRules(brokenChain, Object.keys(brokenChain).length);
  assert.ok(
    errs3.some((e) => e.includes('tied_only')),
    '把破同分链首改成 tied_only 必须报错（否则改配置就能让互评变成主排序键）',
  );
});

// ══════════════════════════════════════════════════════════════════
// F27：HEAD / OPTIONS 全部 404，且没有任何 CORS 头
//   缺陷溯源：内部审计报告 §3.5「F27 · Low · HEAD/OPTIONS 全部 404，无 CORS」
//   现象：HEAD /api/health → 404（朴素存活探针会误判服务已死）；
//        OPTIONS → 404 且不带任何 Access-Control-Allow-*。
//   根因：src/http/router.js 是**方法精确匹配**（`if (route.method !== m) continue;`）。
//   修法（本文件钉住的口径）：
//     ① HEAD 语义等价 GET（RFC 9110 §9.3.2）⇒ 命中同名 GET 路由，**只丢响应体、保留 Content-Length**；
//     ② OPTIONS 回 **204 + Allow**（明确列出该路径支持的方法）；
//     ③ CORS **默认关闭**（不破坏现有部署），**可配置开启**（白名单）。
// ══════════════════════════════════════════════════════════════════
test('F27 HEAD 必须命中同名 GET 路由：200 + 保留 Content-Length + 无响应体', async () => {
  await withServer(async ({ base }) => {
    const head = await call(base, 'HEAD', '/api/health');
    assert.equal(head.status, 200, `HEAD /api/health 必须 200（修复前是 404），实际 ${head.status}：${head.text}`);
    assert.ok(head.headers['content-length'], 'HEAD 必须保留 Content-Length（探针要靠它判断体量）');
    assert.equal(head.text, '', 'HEAD 不得返回响应体');

    // ⚠️ 对照组：同一个路由的 GET 必须**仍然**返回体
    //    （否则这条用例就变成了「一律清空响应体」的恒绿）。
    const get = await call(base, 'GET', '/api/health');
    assert.equal(get.status, 200);
    assert.ok(get.text.length > 0, 'GET 必须仍然返回响应体（HEAD 不得把 GET 也清空）');
  });
});

test('F27b HEAD 不得放宽方法边界：未注册路径仍 404、只有 POST 的端点仍 404', async () => {
  await withServer(async ({ base }) => {
    const unknown = await call(base, 'HEAD', '/api/this-route-does-not-exist');
    assert.equal(unknown.status, 404, '未注册的路径仍然必须 404（HEAD 不是万能通行证）');
    // ⚠️ 对照组：/api/auth/login 只注册了 POST ⇒ HEAD 不得命中它
    //    （HEAD 只等价 GET，不等价 POST —— 否则一个只该写的端点会被探针摸到）。
    const postOnly = await call(base, 'HEAD', '/api/auth/login');
    assert.equal(postOnly.status, 404, '只有 POST 的端点不得被 HEAD 命中（HEAD 只等价 GET）');
    // ⚠️ 对照组：TRACE 必须仍然 404（缺陷报告 §3.5 F27 原文：
    //    「TRACE → 404（**好的一面**：不会回显）」）—— HEAD 的回退不得顺带把 TRACE 也放开。
    //    ⚠️ fetch 不支持 TRACE ⇒ 这条走裸 HTTP。
    const trace = await rawCall(base, 'TRACE', '/api/health');
    assert.equal(trace.status, 404, 'TRACE 必须仍然 404（不得回显，也不得被 HEAD 回退带出来）');
  });
});

test('F27c HEAD 必须真的走 GET 的处理器（鉴权照旧生效，不是无条件 200）', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'HEAD', '/api/me');
    assert.equal(r.status, 401, 'HEAD /api/me 未登录必须仍是 401（HEAD 与 GET 同语义，不是无条件 200）');
  });
});

test('F27d HEAD 也必须能命中静态页（探针常探 / 而不是 /api/health）', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'HEAD', '/index.html');
    assert.equal(r.status, 200, `HEAD 静态页必须 200（修复前是 404），实际 ${r.status}：${r.text}`);
    assert.equal(r.text, '', 'HEAD 静态页不得返回响应体');
    assert.ok(r.headers['content-length'], 'HEAD 静态页必须保留 Content-Length');
  });
});

test('F27e OPTIONS 必须回 204 + Allow（未注册路径仍 404）', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'OPTIONS', '/api/health');
    assert.equal(r.status, 204, `OPTIONS 必须回 204（修复前是 404），实际 ${r.status}：${r.text}`);
    const allow = r.headers['allow'] || '';
    assert.match(allow, /GET/, `Allow 必须列出 GET，实际：${allow}`);
    assert.match(allow, /HEAD/, `Allow 必须列出 HEAD，实际：${allow}`);
    assert.match(allow, /OPTIONS/, `Allow 必须列出 OPTIONS，实际：${allow}`);

    // ⚠️ 对照组：POST 端点的 Allow 必须列 POST，且**不得**列 GET
    //    （Allow 写错 ⇒ 客户端以为这个端点能读，其实只能写）。
    const p = await call(base, 'OPTIONS', '/api/auth/login');
    assert.equal(p.status, 204);
    const pAllow = p.headers['allow'] || '';
    assert.match(pAllow, /POST/, `Allow 必须列出 POST，实际：${pAllow}`);
    assert.doesNotMatch(pAllow, /GET/, `只注册了 POST 的端点不得在 Allow 里出现 GET，实际：${pAllow}`);

    // ⚠️ 对照组：未注册的路径仍然 404（OPTIONS 不是万能 204）。
    const unknown = await call(base, 'OPTIONS', '/api/nope-not-here');
    assert.equal(unknown.status, 404, '未注册的路径 OPTIONS 仍然必须 404');
  });
});

test('F27f CORS 默认关闭：不得凭空出现 Access-Control-Allow-Origin（不破坏现有部署）', async () => {
  // ⚠️ 依据：缺陷报告 §3.5 F27 修法 ③「CORS 是否要开是产品决策（目前刻意不开）」
  //    ⇒ 默认一个 Access-Control-* 头都不给（8444 演示站是**另一个 origin**的静态站，
  //    平台 API 走同源；凭空开跨域等于给公网多开一个面）。
  await withServer(async ({ base }) => {
    const r = await call(base, 'GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined, '默认不得开跨域');
    const opt = await call(base, 'OPTIONS', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(opt.status, 204);
    assert.equal(opt.headers['access-control-allow-origin'], undefined, '默认预检也不得开跨域');
  });
});

test('F27g CORS 可配置开启：白名单内的来源必须拿到预检头，白名单外拿不到', async () => {
  const prev = process.env.CORS_ALLOW_ORIGIN;
  process.env.CORS_ALLOW_ORIGIN = 'https://demo.example.com';
  try {
    await withServer(async ({ base }) => {
      const ok = await call(base, 'OPTIONS', '/api/health', {
        headers: { Origin: 'https://demo.example.com', 'Access-Control-Request-Method': 'GET' },
      });
      assert.equal(ok.status, 204);
      assert.equal(ok.headers['access-control-allow-origin'], 'https://demo.example.com', '白名单内的来源必须被放行');
      assert.match(ok.headers['access-control-allow-methods'] || '', /GET/, '预检必须列出允许的方法');
      assert.ok(ok.headers['access-control-allow-headers'], '预检必须列出允许的请求头');
      assert.match(ok.headers['access-control-max-age'] || '', /^\d+$/, '预检必须带 Max-Age（否则每次都预检）');

      // ⚠️ 对照组：不在白名单的来源不得拿到放行头。
      const bad = await call(base, 'OPTIONS', '/api/health', {
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
      });
      assert.equal(bad.status, 204);
      assert.equal(bad.headers['access-control-allow-origin'], undefined, '白名单外的来源不得被放行');

      // ⚠️ 对照组：普通（简单）跨源请求也要带 ACAO，否则预检过了、实际请求又被拦。
      const simple = await call(base, 'GET', '/api/health', { headers: { Origin: 'https://demo.example.com' } });
      assert.equal(simple.status, 200);
      assert.equal(simple.headers['access-control-allow-origin'], 'https://demo.example.com');
    });
  } finally {
    if (prev === undefined) delete process.env.CORS_ALLOW_ORIGIN;
    else process.env.CORS_ALLOW_ORIGIN = prev;
  }
});

// ══════════════════════════════════════════════════════════════════
// F28：完全没有安全响应头
//   缺陷溯源：内部审计报告 §3.5「F28 · Low · 完全没有安全响应头」
//   验收口径（报告原文）：「所有响应都带 X-Content-Type-Options: nosniff 与 X-Frame-Options」。
//   本文件追加的口径：
//     · HSTS **仅在 https 下**（明文连接带 HSTS 是误导；浏览器也会忽略明文来的 HSTS）；
//     · **不得**加会拦掉页面资源的 Content-Security-Policy
//       （前端视图里有内联 style 属性 ⇒ 严格 CSP 会把整站搞坏）。
// ══════════════════════════════════════════════════════════════════
test('F28 所有响应都必须带安全响应头（API / 404 / 静态页一律带）', async () => {
  await withServer(async ({ base }) => {
    const api = await call(base, 'GET', '/api/health');
    assert.equal(api.status, 200);
    assert.equal(api.headers['x-content-type-options'], 'nosniff', 'API 响应必须带 X-Content-Type-Options: nosniff');
    assert.ok(api.headers['referrer-policy'], 'API 响应必须带 Referrer-Policy');
    assert.ok(api.headers['x-frame-options'], 'API 响应必须带 X-Frame-Options（防点击劫持）');

    // ⚠️ 对照组：404 响应也必须带（不是只有成功路径才有）。
    const nf = await call(base, 'GET', '/api/nope-not-here');
    assert.equal(nf.status, 404);
    assert.equal(nf.headers['x-content-type-options'], 'nosniff', '404 响应也必须带安全头');
    assert.ok(nf.headers['x-frame-options'], '404 响应也必须带 X-Frame-Options');

    // ⚠️ 对照组：静态页也必须带（管理后台 SPA 是点击劫持的主要目标）。
    const html = await call(base, 'GET', '/index.html');
    assert.equal(html.status, 200);
    assert.equal(html.headers['x-content-type-options'], 'nosniff', '静态页也必须带安全头');
    assert.ok(html.headers['x-frame-options'], '静态页也必须带 X-Frame-Options');
  });
});

test('F28b HSTS 只在 https 下出现（明文连接不得带 Strict-Transport-Security）', async () => {
  await withServer(async ({ base }) => {
    const plain = await call(base, 'GET', '/api/health');
    assert.equal(plain.headers['strict-transport-security'], undefined, '明文连接不得带 HSTS');

    // ⚠️ 对照组：https（nginx 透传 X-Forwarded-Proto $scheme）必须带。
    const tls = await call(base, 'GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(
      tls.headers['strict-transport-security'] || '',
      /max-age=\d+/,
      'https 下必须带 Strict-Transport-Security',
    );

    // ⚠️ 对照组：明文协议头不得触发 HSTS。
    const http = await call(base, 'GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(http.headers['strict-transport-security'], undefined, 'X-Forwarded-Proto: http 不得带 HSTS');
  });
});

test('F28c 不得默认加 Content-Security-Policy（前端视图有内联 style ⇒ CSP 会拦掉页面资源）', async () => {
  // ⚠️ 前提核对：前端视图里确实有内联 style 属性（web/views/landing.js 等）。
  //    这个前提变了（内联样式被清掉）⇒ 必须重新决策 CSP，而不是让这条用例悄悄绿。
  const viewSrc = readFileSync(join(platformDir, 'web', 'views', 'landing.js'), 'utf8');
  assert.match(viewSrc, /style="/, '前提：web/views 里有内联 style 属性（前提变了要重新决策 CSP）');

  await withServer(async ({ base }) => {
    const r = await call(base, 'GET', '/index.html');
    assert.equal(r.status, 200);
    assert.equal(
      r.headers['content-security-policy'],
      undefined,
      '默认不得加 CSP（前端有内联 style，严格 CSP 会把整站搞坏）',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// F20：`GET /api/audit/computations/:id/diff` **会写库** ⇒ 状态变更型 GET
//   缺陷溯源：内部审计报告 §3.5「F20 · Medium · GET .../diff 会写库」
//   现象：复算会写一条 `computation.recompute` 审计日志（services/audit.js 的
//        writeAuditLog）⇒ 它是**有副作用的动作**；而路由注册的是 GET ⇒
//        `SameSite=Lax` 在**顶层 GET 导航**上会带 Cookie（跨站 POST/XHR 才会被挡）
//        ⇒ 该 GET **跨站可达** ⇒ `<img src=".../diff">` 就能以受害者身份
//        写一条审计记录 ⇒ 污染审计日志 ⇒ 破坏「审计日志可信」这个前提。
//   修法（审计建议）：复算改成 **POST**（幂等语义下复算本就不该是 GET）。
//   本用例钉住的口径：
//     ① GET 复算端点**不得写库**（audit_log 行数不变）—— 跨站可达的那条路径；
//     ② 对照组：POST 才是复算入口 ⇒ 真的复算（返回体带 diff）+ 真的留痕。
// ══════════════════════════════════════════════════════════════════
test('F20 复算 diff 只能由 POST 触发（GET 不得写库：audit_log 行数不变）', async () => {
  await withServer(async ({ base, db }) => {
    const { rules } = loadRules(rulesDir);
    const { recordComputation } = await import('../src/services/audit.js');
    const { scoreStage } = await import('../src/domain/scoring.js');

    // ── 夹具：超管 + 会话 + 一份「总分被改过」的计算快照 ──────────────
    const admin = createUser(db, { name: '组委会', phone: '13900001721', password: 'pw' });
    setSuperadmin(db, admin.id);
    const { token } = createSession(db, admin.id);
    const cookie = `hk_session=${token}`;

    const input = {
      configKey: 'scoring.final',
      ruleVersion: `scoring.final@${rules.scoring.final.version}`,
      config: rules.scoring.final,
      judges: [{ judgeId: 'j1', seat: 'judge' }],
      submissions: [{ judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 }],
      enterpriseConfirmations: [],
      peerReviews: [],
    };
    // ⚠️ 快照必须存「真实引擎算出来的结果，只把总分改了」——
    //    拿手写的假输出当快照 ⇒ 复算恒判一致 ⇒ 对照组失去判别性。
    const output = scoreStage({
      config: input.config,
      judges: input.judges,
      submissions: input.submissions,
      enterpriseConfirmations: [],
      peerReviews: [],
    });
    output.teams[0].total = 999;
    const { id } = recordComputation({
      db, kind: 'stage_score', ruleVersion: input.ruleVersion, input, output, trace: {},
    });

    const countAudit = () => db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const before = countAudit();

    // ① GET（跨站可达的那条路径）⇒ 不得触发复算、不得写库
    const get = await call(base, 'GET', `/api/audit/computations/${id}/diff`, { cookie });
    assert.ok(
      get.status === 404 || get.status === 405,
      `GET 必须被明确拒绝（404 无此接口 / 405 方法不允许），实际 ${get.status}：${get.text}`,
    );
    assert.ok(
      !get.text.includes('"identical"') && !get.text.includes('"diff":'),
      `GET 不得返回复算结果（它不是复算入口）：${get.text.slice(0, 200)}`,
    );
    assert.equal(
      countAudit(), before,
      'GET 复算端点之后 audit_log 行数必须不变（GET 不得写库，否则审计日志可被跨站污染）',
    );

    // ② 对照组：POST 才是复算入口 ⇒ 真的复算 + 真的留痕
    const post = await call(base, 'POST', `/api/audit/computations/${id}/diff`, { cookie });
    assert.equal(post.status, 200, `POST 复算端点必须可用（实际 ${post.status}：${post.text}）`);
    const body = JSON.parse(post.text);
    assert.equal(body.identical, false, '快照被改过 ⇒ 复算必须报不一致');
    assert.ok(Array.isArray(body.diff) && body.diff.length > 0, '复算结果必须带 diff');
    assert.ok(Array.isArray(body.warnings), '复算结果必须带 warnings');
    assert.equal(
      countAudit(), before + 1,
      'POST 复算必须留一条审计日志（对照组：复算真的发生了，不是空转）',
    );
    const last = db.prepare('SELECT action FROM audit_log ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(last.action, 'computation.recompute', '新增的那条必须是复算留痕');
  });
});

test('F20b 复算端点不得再以 GET 注册（路由清单里只有 POST）', async () => {
  // ⚠️ 行为闸之外再加一道**结构闸**：路由清单里如果还有 GET 版复算端点，
  //    将来谁再把 handler 挂回 GET ⇒ F20 立刻复发（结构闸先于行为闸报警）。
  const { createApp } = await import('../src/server.js');
  const { openDatabase } = await import('../src/db/sqlite.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f20-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  try {
    const app = createApp({ db, rules, webDir });
    const routes = app.router.list().map((r) => `${r.method} ${r.pattern}`);
    assert.ok(
      routes.includes('POST /api/audit/computations/:id/diff'),
      `复算端点必须注册为 POST，实际路由清单：${routes.filter((r) => r.includes('audit/computations')).join('、')}`,
    );
    assert.ok(
      !routes.includes('GET /api/audit/computations/:id/diff'),
      '复算端点不得再注册 GET（GET 跨站可达 ⇒ 可被 <img> 触发写库）',
    );
    // ⚠️ 对照组：纯读口（取快照本身）**必须仍然是 GET** ——
    //    否则就改错了（读口没有副作用，本来就该是 GET）。
    assert.ok(
      routes.includes('GET /api/audit/computations/:id'),
      '取计算快照仍是只读口 ⇒ 必须保留 GET',
    );
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F24：会话**中途** 401 不清 UI（web/api.js 记了 err.status，全站零消费方）
//   缺陷溯源：内部审计报告 §3.5「F24 · Medium · 会话中途 401 不清 UI」
//   现象：会话过期后界面**仍显示为已登录**（顶栏 / 组委会导航区块都在），
//        后续每个读写都变成错误卡片；用户**永远不会**被送回 #/login（只能手工敲 #/logout）。
//   根因：web/api.js:14-18 记下了 err.status，但**全站没有任何消费方**
//        （app.js 没有 401 分支、store.js 没有失效路径、restoreSession 只在启动时跑一次）。
//   修法（本文件钉住的口径）：
//     ① 401 ⇒ 清本地会话态（store.user = null）+ 跳 #/login + 显式标记「会话已失效」；
//     ② **403 = 权限不足 ⇒ 绝不清会话**（清了会把「权限不够」误导成「请重新登录」）；
//     ③ 200 正常路径 ⇒ 绝不清会话、绝不跳登录页；
//     ④ 401 但**口令不对**（INVALID_CREDENTIALS：登录 / 改密）⇒ 不是会话失效 ⇒ 不清、不改文案；
//     ⑤ 访客（本来就没会话）拿到 401 ⇒ 不弹登录页（落地页必须保持公开可用，P9 M6）；
//     ⑥ 登录页必须**明说「会话已过期，请重新登录」**（不能是一张没有解释的空表单）。
// ══════════════════════════════════════════════════════════════════

/**
 * 装一个够 web/api.js 用的最小浏览器环境（fetch + window.location）。
 * @param {{status:number, code?:string, message?:string, body?:any}} resp
 */
function installBrowser({ status, code = '', message = '', body = null }) {
  globalThis.window = { location: { search: '', hash: '' }, addEventListener: () => {} };
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body ?? { error: { code, message } }),
  });
}

/**
 * ⚠️ **全局污染必须还原（2026-10-23 审计 F24 的连带教训）**
 *
 * `installBrowser()` 替换的是**全局** `globalThis.fetch` 与 `globalThis.window`。
 * 如果替换后不还原 ⇒ **本文件后续所有用例**拿到的都是这个浏览器桩：
 *   · 任何走 `fetch` 的用例会拿到桩的固定响应（而不是真实 HTTP）；
 *   · 更危险的是：桩常被设成 **401**，而 **401 也是 4xx**
 *     ⇒ 任何「断言状态码 ∈ 4xx」的扫描类闸门会**假绿**（测的是桩，不是真后端）。
 *
 * ⚠️ 这个坑是**真的踩过**的：F9 的「全写端点扫描」用例一度全部打到这个桩上，
 *   每个探针都回 401 ⇒ 闸门看着是绿的，**实际上一个端点都没真测到**。
 *   ⇒ F9 段改用「模块加载时捕获的真实 fetch」绕开（那一层保险保留），
 *     但**根治**在这里：每个用例跑完立刻把全局还原。
 *
 * ⇒ 还原点在 `afterEach`（不是 `beforeEach`）：
 *   `beforeEach` 只保证「进用例前是干净的」，但**用例体内**装的桩会漏给
 *   **下一个用例的 module 顶层副作用**与本用例之后的断言 ⇒ `afterEach` 才关得严。
 */
const ORIG_FETCH = globalThis.fetch;
const ORIG_WINDOW = globalThis.window;

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  globalThis.window = ORIG_WINDOW;
});

/** 已登录的本地会话态（每个用例自己重置，避免用例之间互相污染）。 */
const F24_USER = { id: 'u_1', name: '甲', phone: '13800000000' };

test('F24 会话中途 401：必须清掉本地会话态 + 跳 #/login + 明说「会话已过期」（修复前 UI 仍显示已登录）', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 401, code: 'UNAUTHENTICATED', message: '未登录' });
  setState({ user: F24_USER, sessionExpired: false });

  await assert.rejects(
    () => api.get('/api/teams'),
    (err) => {
      assert.equal(err.status, 401, '状态码必须原样透出（上层靠它分流）');
      // ⚠️ 不能静默吞掉：服务端的「未登录」用户看不懂，也不知道下一步做什么
      assert.match(err.message, /会话已过期/, `401 的文案必须说清「会话过期了」，实际：${err.message}`);
      assert.match(err.message, /重新登录/, '文案必须带下一步（重新登录）');
      return true;
    },
  );

  assert.equal(getState().user, null, '⛔ 401 必须清掉本地会话态（否则顶栏还显示「已登录」）');
  assert.equal(getState().sessionExpired, true, '「会话已失效」必须变成显式可见的状态');
  assert.equal(globalThis.window.location.hash, '#/login', '⛔ 401 必须回到登录视图（#/login）');
});

test('F24b 403（权限不足）不得清会话态、不得跳登录页（否则把「权限不够」说成「请重新登录」）', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 403, code: 'FORBIDDEN', message: '没有权限' });
  setState({ user: F24_USER, sessionExpired: false });

  await assert.rejects(
    () => api.get('/api/admin/registration'),
    (err) => {
      assert.equal(err.status, 403, '状态码必须原样透出');
      assert.match(err.message, /没有权限/, '403 的文案必须保留服务端原文（业务语义不能被洗掉）');
      assert.doesNotMatch(err.message, /会话已过期/, '⛔ 403 不得被说成「会话已过期」');
      return true;
    },
  );

  assert.equal(getState().user?.id, 'u_1', '⛔ 403 不得清会话态');
  assert.equal(getState().sessionExpired, false, '403 不得把「会话已失效」置起来');
  assert.equal(globalThis.window.location.hash, '', '⛔ 403 不得跳登录页');
});

test('F24c 200 正常路径不得清会话态、不得跳登录页', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 200, body: { items: [] } });
  setState({ user: F24_USER, sessionExpired: false });

  const data = await api.get('/api/teams');
  assert.deepEqual(data, { items: [] }, '正常路径必须原样返回数据');
  assert.equal(getState().user?.id, 'u_1', '⛔ 200 不得清会话态');
  assert.equal(globalThis.window.location.hash, '', '⛔ 200 不得跳登录页');
});

test('F24d 401 但**口令不对**（INVALID_CREDENTIALS）不是会话失效：不得清会话、不得说「会话已过期」', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 401, code: 'INVALID_CREDENTIALS', message: '手机号或密码不正确' });
  setState({ user: null, sessionExpired: false });

  await assert.rejects(
    () => api.post('/api/auth/login', { phone: '13800000000', password: 'wrong' }),
    (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /手机号或密码不正确/, '口令不对必须说口令不对（不能被洗成「会话过期」）');
      assert.doesNotMatch(err.message, /会话已过期/, '⛔ 口令不对不得说成「会话已过期」');
      return true;
    },
  );

  assert.equal(getState().sessionExpired, false, '⛔ 口令不对不得置「会话已失效」');
  assert.equal(globalThis.window.location.hash, '', '⛔ 口令不对不得跳登录页');
});

test('F24e 访客（本来就没会话）拿到 401 不得被弹到登录页（落地页必须保持公开可用）', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 401, code: 'UNAUTHENTICATED', message: '未登录' });
  setState({ user: null, sessionExpired: false });

  await assert.rejects(() => api.get('/api/teams'), (err) => {
    assert.equal(err.status, 401);
    return true;
  });

  assert.equal(getState().sessionExpired, false, '访客的 401 不是「会话已过期」');
  assert.equal(globalThis.window.location.hash, '', '⛔ 访客不得被弹到登录页（否则落地页废了）');
});

test('F24f 登录页必须显示「会话已过期，请重新登录」（会话没过期时不得显示）', async () => {
  const { renderLogin } = await import('../web/views/login.js');
  // 最小 DOM 桩：够登录视图渲染即可（本用例不点按钮）
  const el = {
    className: '', innerHTML: '', textContent: '', value: '',
    querySelector: () => ({ addEventListener: () => {}, textContent: '', value: '' }),
    addEventListener: () => {},
  };
  globalThis.document = { createElement: () => el };

  const expired = renderLogin({
    api: {}, navigate: () => {}, setState: () => {},
    getState: () => ({ user: null, sessionExpired: true }),
  });
  assert.match(expired.innerHTML, /会话已过期/, '⛔ 登录页必须明说会话已过期');
  assert.match(expired.innerHTML, /重新登录/, '必须给出下一步（重新登录）');

  // ⚠️ 对照组：会话没过期 ⇒ 不得显示这条提示（否则会变成一句永远挂着的话）
  const normal = renderLogin({
    api: {}, navigate: () => {}, setState: () => {},
    getState: () => ({ user: null, sessionExpired: false }),
  });
  assert.doesNotMatch(normal.innerHTML, /会话已过期/, '会话没过期时不得显示「会话已过期」');
});

// ══════════════════════════════════════════════════════════════════
// F21 / F22：演示站与真实后端的**形状漂移**
//   缺陷溯源：内部审计报告 §3.4
//     F21（Medium）演示站名册登记显示「NaN 支队伍」
//     F22（Medium）演示站缺 meta ⇒ 恰好掩盖 F16（Critical）
//
// ⚠️ 为什么这两条只能改**演示站**（web/api.demo.js）：
//    演示站是真实后端的**形状镜像**（每个响应形状都必须与真实后端一致）。
//    形状一旦漂移，演示站就会**掩盖**真实缺陷 —— F16 就是这么被藏住的：
//    真实后端评估后把**档位定义**投影进 meta.solvability，演示站没有 meta ⇒
//    签级表单在演示站上走的是**另一条路径**（规则投影）⇒ F16 压根不复现 ⇒
//    唯一被公开演示、被评审反复检验的环境，恰恰看不到这个 bug。
//    ⇒ 口径基准永远是**真实后端**；演示站照抄。
// ══════════════════════════════════════════════════════════════════

/**
 * 起一个演示站适配器（内存版 localStorage + 演示种子 + 真规则）。
 * ⚠️ 与 demo-api-parity.test.js 的 bootDemo 同一路径（同一个 createDemoApi）。
 */
async function bootDemoApi() {
  const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(rulesDir);
  const { createDemoApi } = await import('../web/api.demo.js');
  const m = new Map();
  const api = createDemoApi({
    storage: {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    },
    seed,
    rules,
  });
  await api.post('/api/auth/login', { name: '演示管理员' });
  return api;
}

// ── F21 ───────────────────────────────────────────────────────────
test('F21 演示站登记名册：registered/skipped 必须与真实后端同型（数字，不是数组）', async () => {
  // ── 口径基准：真实后端（真库 + 真服务层）──────────────────────────
  // src/services/stage.js:411-415 registerStageTeamRoster ⇒
  //   { registered: 数字, skipped: 数字, teamIds: string[] }
  // 路由 src/http/routes/stages.js:238-243 逐字透传这三个字段。
  const { db, close } = freshDb();
  let real;
  let realAgain;
  try {
    const now = new Date().toISOString();
    const edition = createEdition(db, {
      name: '首届', city: '上海', startsAt: '2026-01-01', endsAt: '2026-12-31', now,
    });
    const captain = createUser(db, { name: '一队队长', phone: '13800001801', password: 'pw', mbaStatus: 'mba' });
    const stage = insertStage(db, {
      editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
      startsAt: '2026-01-01', endsAt: '2026-02-01', scoringConfigKey: 'initial', now,
    });
    const team = insertTeam(db, { editionId: edition.id, name: '一队', captainId: captain.id, now });
    const { registerStageTeamRoster } = await import('../src/services/stage.js');
    real = registerStageTeamRoster({ db, stageId: stage.id, teamIds: [team.id], actorId: null, now });
    // 对照组：重复登记是**幂等**的（第二次 registered=0 / skipped=1）
    realAgain = registerStageTeamRoster({ db, stageId: stage.id, teamIds: [team.id], actorId: null, now });
  } finally { close(); }

  // ── 演示站（同一条请求）──────────────────────────────────────────
  const demo = await bootDemoApi();
  const { stage: demoStage } = await demo.post('/api/editions/ed_demo/stages', {
    key: 's_demo', name: '演示赛段', kind: 'initial', scoringConfigKey: 'initial',
  });
  const demoRes = await demo.post(`/api/stages/${demoStage.id}/teams`, { teamIds: ['t_alpha'] });

  // ① 类型：必须是**数字**（修复前演示站给的是数组 ⇒ Number(["t_alpha"]) = NaN）
  assert.equal(
    typeof demoRes.registered, 'number',
    `演示站 registered 必须是数字，实际 ${JSON.stringify(demoRes.registered)}（数组 ⇒ 前端渲染成裸 NaN）`,
  );
  assert.equal(
    typeof demoRes.skipped, 'number',
    `演示站 skipped 必须是数字，实际 ${JSON.stringify(demoRes.skipped)}`,
  );
  // ② 与真实后端**同值**（不只是同类型）
  assert.equal(demoRes.registered, real.registered, '演示站与真实后端的 registered 必须同值');
  assert.equal(demoRes.skipped, real.skipped, '演示站与真实后端的 skipped 必须同值');
  // ⚠️ teamIds 只比**形状与条数**（两边是各自的数据集，id 值本就不同：真后端是随机 UUID）
  assert.ok(Array.isArray(demoRes.teamIds) && Array.isArray(real.teamIds), 'teamIds 必须是数组');
  assert.equal(demoRes.teamIds.length, real.teamIds.length, '名册条数必须与真实后端一致');
  assert.deepEqual(
    demoRes.teamIds.map((x) => typeof x), real.teamIds.map((x) => typeof x),
    'teamIds 的元素类型必须与真实后端一致（string[]）',
  );
  assert.ok(demoRes.teamIds.includes('t_alpha'), '演示站必须真的把登记的队伍写进名册');
  // ③ 前端读法复现（web/views/stages.js:1227-1228：Number(res?.registered ?? 0)）
  const shown = Number(demoRes?.registered ?? 0);
  assert.ok(Number.isFinite(shown), `前端会把 registered 渲染成「新登记 ${shown} 支队伍」（裸 NaN）`);
  assert.equal(shown, real.registered);
  // ④ 幂等口径也要一致（重复登记 ⇒ registered=0 / skipped=1）
  const demoAgain = await demo.post(`/api/stages/${demoStage.id}/teams`, { teamIds: ['t_alpha'] });
  assert.equal(demoAgain.registered, realAgain.registered, '重复登记的 registered 必须与真实后端同值');
  assert.equal(demoAgain.skipped, realAgain.skipped, '重复登记的 skipped 必须与真实后端同值');
  // ⑤ 对照组：基准本身（真实后端）确实给的是数字
  assert.equal(typeof real.registered, 'number');
  assert.equal(typeof real.skipped, 'number');
});

// ── F22 ───────────────────────────────────────────────────────────
test('F22 演示站任务卡必须带 meta：字段集合与真实后端逐字一致，且能独立撑起签级', async () => {
  // ── 口径基准：真实后端（真库 + 真服务层）──────────────────────────
  // ⚠️ 这里直接调**服务层**（assessSolvability）：它返回的就是 presentTaskPackage(...)，
  //    而路由 src/http/routes/taskPackage.js:41-43 **原样**返回这个结果 ⇒ 形状完全同源。
  //    ⛔ 不用 HTTP：同一个文件里 F24 的用例把 globalThis.fetch 换成了桩且**不还原**
  //    ⇒ 本文件靠后的用例再走 fetch 会打到桩上（这不是本缺陷，是同文件用例的污染）。
  let real;
  {
    const { db, close } = freshDb();
    try {
      const { rules } = loadRules(rulesDir);
      const now = new Date().toISOString();
      db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','首届','上海','2026-01-01','2026-12-31','${now}')`);
      const ent = createUser(db, { name: '甲企业', phone: '13800001811', password: 'pw', org: '甲公司' });
      db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
               VALUES ('tp_f22','ed1','${ent.id}','甲公司','F22 任务卡','p','e','a',0,'${ent.id}','submitted','{}','${now}')`);
      const { assessSolvability } = await import('../src/services/taskPackage.js');
      real = assessSolvability({
        db, taskPackageId: 'tp_f22', answers: SOLVABILITY_FULL, actorId: ent.id, now, rules,
      });
    } finally { close(); }
  }

  // ── 演示站（同一条请求）──────────────────────────────────────────
  const demo = await bootDemoApi();
  const demoRes = await demo.post('/api/task-packages/tp_demo_assess/solvability', {
    answers: SOLVABILITY_FULL,
  });

  // ① 任务卡**顶层字段集合**必须与真实后端逐字一致（修复前演示站少一个 meta）
  assert.deepEqual(
    Object.keys(demoRes).sort(),
    Object.keys(real).sort(),
    '演示站与真实后端的任务卡字段集合必须逐字一致（含 meta）',
  );
  assert.ok(demoRes.meta && typeof demoRes.meta === 'object', '演示站的任务卡必须带 meta（对象）');
  // ② meta.solvability 的字段集合必须与真实后端逐字一致
  assert.ok(demoRes.meta.solvability, '演示站的 meta 必须带 solvability');
  assert.deepEqual(
    Object.keys(demoRes.meta.solvability).sort(),
    Object.keys(real.meta.solvability).sort(),
    '演示站与真实后端的 meta.solvability 字段集合必须逐字一致',
  );
  // ③ **档位定义**与**否决项定义**必须一并投影出来（F16 的病根就在这两处）
  assert.deepEqual(
    Object.keys(demoRes.meta.solvability.grades?.[0] ?? {}).sort(),
    Object.keys(real.meta.solvability.grades?.[0] ?? {}).sort(),
    '档位定义的字段集合必须与真实后端逐字一致（key/minScore/maxScore/commitment/agreement）',
  );
  assert.deepEqual(
    Object.keys(demoRes.meta.solvability.vetoesSpec?.[0] ?? {}).sort(),
    Object.keys(real.meta.solvability.vetoesSpec?.[0] ?? {}).sort(),
    '否决项定义的字段集合必须与真实后端逐字一致（key/label/auto）',
  );
  assert.equal(
    demoRes.meta.solvability.grades?.length, real.meta.solvability.grades?.length,
    '档位数量必须与真实后端一致',
  );
  assert.equal(
    demoRes.meta.solvability.vetoesSpec?.length, real.meta.solvability.vetoesSpec?.length,
    '否决项数量必须与真实后端一致',
  );
  // ④ F16 在演示站上**同样可复现、同样被覆盖**：
  //    只喂演示站自己的响应（**不给规则**）⇒ 也必须能撑起完整的签级档位。
  const { solvabilitySpecFromPackages, gradeTiers } = await import(join(webDir, 'views', 'admin-task-packages.js'));
  const demoSpec = solvabilitySpecFromPackages([demoRes]);
  assert.ok(demoSpec, '演示站的任务卡必须能投影出评估规格');
  assert.equal(
    gradeTiers(demoSpec).complete, true,
    '演示站评估过一次任务卡后签级档位必须就绪（F16 在演示站同样可复现）',
  );
  // 对照组：真实后端同样成立（证明基准不是「随手编的」）
  assert.equal(
    gradeTiers(solvabilitySpecFromPackages([real])).complete, true,
    '对照组：真实后端评估后签级档位必须就绪',
  );
});

// ══════════════════════════════════════════════════════════════════
// 第 9 批（E175）：数据 / 事务类 3 条 —— F23 / F25 / F26
//   F23 提交签字可写两条（双击 ⇒ 两条不可见但有效的签字）
//   F25 幂等键不绑定操作 ⇒ 静默重放（同 requestId 换内容）
//   F26 review-state.js 全程无事务（状态迁移与申诉行不同生共死）
// ══════════════════════════════════════════════════════════════════

// ═══ F23：同一里程碑的同一企业只允许一条有效签字 ═══
test('F23 同一里程碑重复提交签字必须被拒（不得写出第二条不可见但有效的签字）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'signoff:create', '企业里程碑签字');
    const seat = createUser(db, { name: '企业席', phone: '13800001801', password: 'pw', org: '某公司' });
    grantAssignment(db, {
      userId: seat.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: null,
    });
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed9','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,status,created_at) VALUES ('t9','ed9','九队','${seat.id}','active','${now}')`);
    db.exec(`INSERT INTO team_members (id,team_id,user_id,role,joined_at) VALUES ('tm9','t9','${seat.id}','captain','${now}')`);
    db.exec(`INSERT INTO milestones (id,team_id,key,label,counts_toward_tier,requires_signoff,fixed_at,created_at)
             VALUES ('ms9','t9','problem_confirmed','企业问题确认',1,1,'${now}','${now}')`);

    const { createSignoff } = await import('../src/services/milestone.js');
    const body = { department: '业务部门', content: '确认已落地' };
    const first = createSignoff({ db, milestoneId: 'ms9', actorId: seat.id, body, now, rules });
    assert.ok(first?.id, '第一次签字必须成功');

    // 第二次（模拟双击 / 失败后重试）⇒ 必须被拒
    let err = null;
    try {
      createSignoff({ db, milestoneId: 'ms9', actorId: seat.id, body, now, rules });
    } catch (e) { err = e; }
    assert.ok(err, '重复提交签字必须被拒（修复前会写出第二条不可见但有效的签字）');
    assert.equal(err.status, 409, `期望 409，实际 ${err.status}：${err.message}`);

    const rows = db.prepare('SELECT * FROM milestone_signoffs WHERE milestone_id = ?').all('ms9');
    assert.equal(rows.length, 1, `签字表里必须有且只有一行，实际 ${rows.length}`);

    // 判别性②：**数据库层**也要挡住（绕过服务层直接插 ⇒ 唯一索引必须拒绝）
    assert.throws(
      () => db.prepare(`INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
                        VALUES ('sg_dup','ms9',?,?,'业务部门','内容',?,NULL)`).run(seat.id, seat.id, now),
      /UNIQUE constraint failed/,
      '数据库必须挡住重复的有效签字（服务层的「先查再插」在并发下挡不住）',
    );

    // 判别性③：撤回之后**允许**重新签（签字是只增不改 + 软删除的语义）
    db.prepare('UPDATE milestone_signoffs SET revoked_at = ? WHERE id = ?').run(now, first.id);
    const again = createSignoff({ db, milestoneId: 'ms9', actorId: seat.id, body, now, rules });
    assert.ok(again?.id, '撤回之后必须允许重新签（否则「撤回」这个功能就废了）');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══ F25：幂等键必须绑定操作内容 ═══
test('F25 同一个 requestId 换了内容必须 409（不许静默重放首次的响应）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-idem-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    const { withIdempotency } = await import('../src/services/idempotency.js');
    let called = 0;
    const run = (payload) => withIdempotency({
      db, key: 'req-1', scope: 'appeal:u_1', requestId: 'req-1', payload, now,
    }, () => {
      called += 1;
      return { ok: true, echo: payload };
    });

    const first = run({ reason: '第一次的理由' });
    assert.equal(first.replayed, false);
    assert.equal(called, 1);

    // 判别性①：**同样内容**重放 ⇒ 返回首次响应（幂等的本职，必须仍然成立）
    const same = run({ reason: '第一次的理由' });
    assert.equal(same.replayed, true, '同样内容重放必须仍然返回首次响应（幂等的本职）');
    assert.equal(called, 1, '重放不得再执行业务函数');

    // 判别性②：**换了内容** ⇒ 必须 409（修复前会静默返回首次的响应）
    let err = null;
    try {
      run({ reason: '换了个理由' });
    } catch (e) { err = e; }
    assert.ok(err, '同一个 requestId 换内容必须被拒（修复前静默重放，第二次从未提交）');
    assert.equal(err.status, 409, `期望 409，实际 ${err.status}：${err.message}`);
    assert.equal(err.code, 'REQUEST_ID_REUSED', `错误码必须是 REQUEST_ID_REUSED，实际 ${err.code}`);
    assert.equal(called, 1, '被拒的重放不得执行业务函数');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══ F26：复核状态的写路径必须在事务里 ═══
test('F26 裁决申诉失败时状态迁移必须一起回滚（审计日志就是状态源）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rs-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'appeal:write', '提交申诉');
    insertCapability(db, 'audit:write', '裁决申诉');
    const decider = createUser(db, { name: '裁决人', phone: '13800001811', password: 'pw' });
    setSuperadmin(db, decider.id);

    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed9','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO appeals (id,subject_type,subject_id,filed_by,reason,status,created_at)
             VALUES ('ap9','team_result','st9:t9',?, '我不服','submitted','${now}')`.replace('?', `'${decider.id}'`));

    // ⚠️ 让最后一步（更新申诉行）失败 ⇒ 前面写的**状态迁移**必须一起回滚。
    //    理由：**审计日志就是状态源**（`findLatestTransition` 从 audit_log 读当前状态）
    //    ⇒ 若状态迁移已提交而申诉行没更新 ⇒ 主体实际已是「已复核」（分数被隐藏），
    //    却**没有任何裁决记录** ⇒ 数据自相矛盾。
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON appeals BEGIN SELECT RAISE(ABORT, 'boom'); END;`);

    const { decideAppeal } = await import('../src/services/review-state.js');
    const before = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    let err = null;
    try {
      decideAppeal({ db, appealId: 'ap9', decision: 'rejected', decidedBy: decider.id, note: '不成立', now, rules });
    } catch (e) { err = e; }
    assert.ok(err, '裁决必须失败（触发器让更新申诉行抛错）');
    const after = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    assert.equal(after, before, '裁决失败时状态迁移必须一起回滚（审计日志行数不得增加）');
    const appeal = db.prepare('SELECT status FROM appeals WHERE id = ?').get('ap9');
    assert.equal(appeal.status, 'submitted', '申诉行必须仍是提交态');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// F9：写端点的错误语义必须统一
//   缺陷溯源：内部审计报告 §3.4「F9 · Medium · 写端点错误语义不一致」
//   验收原文：「补一条断言：所有写端点在『资源不存在』时统一回 404/400，
//             **没有一个**把 SQLite 原文漏到响应体。」
//
// ⚠️ 本节把「全写路由 FK 扫描」从一次性的人工动作升级成**常驻机器闸**：
//    ① 扫描表覆盖**每一个已注册的写路由**（漏一个 ⇒ 用例失败，见 F9b）；
//    ② 每个写路由都**真的发一次请求**，引用一个**不存在的 id**（见 F9）；
//    ③ 断言状态码是 4xx，且响应体不含 SQLite 原文。
//
// ⚠️ 为什么必须「合法父资源 + 不存在的子 id」也扫一遍：
//    只测「路径里的 id 不存在」会**漏掉真正的外键漏网点** ——
//    外键目标常常是**请求体里的子 id**（enterpriseId / taskPackageId / teamId …），
//    只有父资源合法时，写库才会真的走到 INSERT ⇒ 才会撞外键 ⇒ 才会 500。
//    （实测命中：`POST /api/stages/:stageId/enterprise-confirmations` 传一个
//      不存在的 enterpriseId ⇒ 直接 INSERT ⇒ `FOREIGN KEY constraint failed` ⇒ 500。）
// ══════════════════════════════════════════════════════════════════

/** 扫描用的「不存在的 id」。 */
const F9_NE = 'no-such-id-zzz';

/**
 * ⚠️ **F9 的探针必须用「模块加载时」捕获的真实 fetch**。
 *
 * 原因：**同一个文件里 F24 的用例把 `globalThis.fetch` 换成了浏览器桩，而且不还原**
 *    （文件里 F22 的用例注释已写明这个污染：「F24 的用例把 globalThis.fetch 换成了桩且不还原
 *    ⇒ 本文件靠后的用例再走 fetch 会打到桩上」）。
 * ⇒ F9 的用例排在 F24 之后 ⇒ 直接用 `globalThis.fetch` 会打到桩上：
 *    桩没有 `headers`、也没有真会话 ⇒ 每个探针都回 401（401 也是 4xx ⇒ 闸门会**假绿**）。
 * ⇒ 在**模块加载时**捕获一次真实 fetch（那时桩还没装）⇒ 与污染隔离，且不改动 F24 的用例。
 */
const F9_REAL_FETCH = globalThis.fetch.bind(globalThis);

/**
 * F9 专用服务器：比通用 withServer 多给一个 router（要用它枚举已注册的写路由）。
 */
async function withF9Server(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f9-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, db, router: app.router });
  } finally {
    await new Promise((r) => server.close(r));
    close();
  }
}

/**
 * F9 夹具：一整套**合法**的资源 + 一个超管会话。
 *
 * ⚠️ 为什么要超管：闸门要的是「请求能走到**写库那一步**」，
 *    权限闸门挡在前面的话，探针只会测到 403，测不到外键。
 */
async function seedF9Fixture(db) {
  // ⚠️ 动态 import：不去动文件顶部的 import 块（同一个文件上还有别的 worker 在改）。
  const { insertTeamMember } = await import('../src/db/repo/teamMembers.js');
  const { registerStageTeams } = await import('../src/db/repo/stage-teams.js');
  const { insertMilestones } = await import('../src/db/repo/tiers.js');
  const { insertWorkflow, insertWorkflowTask } = await import('../src/db/repo/workflows.js');
  const { insertTiebreakRound } = await import('../src/db/repo/tiebreak.js');

  const now = new Date().toISOString();
  const admin = createUser(db, { name: '甲', phone: '13900009901', password: 'pw' });
  setSuperadmin(db, admin.id);
  insertCapability(db, 'task_package:read', '读任务卡');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'admin', 'task_package:read');
  insertUserRole(db, admin.id, 'admin');
  const { token } = createSession(db, admin.id);

  // ⚠️ 登出类端点会**吊销会话** ⇒ 单独给「一次性账号」，
  //    免得它把扫描用的主会话打死（后面的探针就全变成 401，闸门会假绿）。
  //    ⚠️ 每个登出端点要**各自**的一次性账号：logout 先吊销了会话，
  //    同一个账号再打 logout-all 就只剩 401 了（那是夹具的锅，不是生产代码的）。
  const throwawayTokens = [];
  for (const [i, phone] of ['13900009902', '13900009903'].entries()) {
    const throwaway = createUser(db, { name: `乙${i}`, phone, password: 'pw' });
    const { token } = createSession(db, throwaway.id);
    throwawayTokens.push(token);
  }

  const edition = createEdition(db, {
    name: '2026 届', city: '上海', startsAt: '2026-01-01', endsAt: '2026-12-31', now,
  });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: admin.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now,
  });
  const team = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: admin.id, taskPackageId: pkg.id, now,
  });
  insertTeamMember(db, { teamId: team.id, userId: admin.id, role: 'captain', now });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '赛段一', kind: 'judge',
    startsAt: '2026-02-01', endsAt: '2026-03-01', scoringConfigKey: 'initial', now,
  });
  assignStageJudge(db, { stageId: stage.id, userId: admin.id, seat: 'judge', now });
  registerStageTeams(db, { stageId: stage.id, teamIds: [team.id], now });
  insertMilestones(db, {
    teamId: team.id, items: [{ key: 'm1', label: '里程碑', countsTowardTier: true }], now,
  });
  const milestoneId = db.prepare('SELECT id FROM milestones WHERE team_id = ?').get(team.id).id;
  const wf = insertWorkflow(db, {
    editionId: edition.id, taskPackageId: pkg.id, name: '工作流', now,
  });
  const wfTask = insertWorkflowTask(db, {
    workflowId: wf.id, title: '任务', detail: null, ownerTeamId: team.id,
    status: 'todo', dueAt: null, now,
  });
  const round = insertTiebreakRound(db, {
    stageId: stage.id, kind: 'statement', tiedTeamIds: [team.id],
    statementDeadline: '2026-03-02T00:00:00.000Z', createdBy: admin.id, now,
  });
  return {
    admin, token, throwawayTokens, edition, pkg, team, stage, milestoneId, wf, wfTask, round,
  };
}

/**
 * F9 扫描表：**每一个**已注册的写路由都要有一条探针。
 *
 * ⚠️ `pattern` 必须与路由注册时的 pattern **逐字相同**（F9b 会拿它对账）。
 * ⚠️ `expect: 200` 只给「**不引用任何资源 id**」的端点（登出类）——
 *    它们没有「资源不存在」这回事，只能断言「不 5xx、不漏原文」。
 */
function f9ProbeTable(fx) {
  const { edition, team, stage, milestoneId, wf, wfTask, round } = fx;
  return [
    // ── ① 路径里的 id 不存在（外键目标在路径上）────────────────────────
    { pattern: '/api/workflows', method: 'POST', path: '/api/workflows', body: { editionId: F9_NE, taskPackageId: F9_NE, name: 'W' } },
    { pattern: '/api/workflows/:id/tasks', method: 'POST', path: `/api/workflows/${F9_NE}/tasks`, body: { title: 'T' } },
    { pattern: '/api/tasks/:id/claim', method: 'POST', path: `/api/tasks/${F9_NE}/claim`, body: {} },
    { pattern: '/api/tasks/:id/release', method: 'POST', path: `/api/tasks/${F9_NE}/release` },
    { pattern: '/api/tasks/:id/complete', method: 'POST', path: `/api/tasks/${F9_NE}/complete`, body: { evidence: { kind: 'runnable', note: 'x' } } },
    { pattern: '/api/editions/:editionId/stages', method: 'POST', path: `/api/editions/${F9_NE}/stages`, body: { key: 'k', name: 'n', kind: 'judge', startsAt: '2026-01-01', endsAt: '2026-02-01', scoringConfigKey: 'initial' } },
    { pattern: '/api/stages/:stageId', method: 'PATCH', path: `/api/stages/${F9_NE}`, body: { name: 'n' } },
    { pattern: '/api/stages/:stageId/judges', method: 'POST', path: `/api/stages/${F9_NE}/judges`, body: { userId: F9_NE, seat: 'judge' } },
    { pattern: '/api/stages/:stageId/judges/:userId', method: 'DELETE', path: `/api/stages/${F9_NE}/judges/${F9_NE}` },
    { pattern: '/api/stages/:stageId/teams', method: 'POST', path: `/api/stages/${F9_NE}/teams`, body: { teamIds: [F9_NE] } },
    { pattern: '/api/stages/:stageId/teams/:teamId', method: 'DELETE', path: `/api/stages/${F9_NE}/teams/${F9_NE}` },
    { pattern: '/api/stages/:stageId/publish', method: 'POST', path: `/api/stages/${F9_NE}/publish` },
    { pattern: '/api/milestones/:id/signoff', method: 'POST', path: `/api/milestones/${F9_NE}/signoff`, body: { department: '业务部门', content: 'x' } },
    { pattern: '/api/milestones/:id/signoff/withdraw', method: 'POST', path: `/api/milestones/${F9_NE}/signoff/withdraw`, body: { signoffId: F9_NE } },
    { pattern: '/api/audit/computations/:id/diff', method: 'POST', path: `/api/audit/computations/${F9_NE}/diff` },
    { pattern: '/api/audit/flags/:id/resolve', method: 'POST', path: `/api/audit/flags/${F9_NE}/resolve`, body: { status: 'confirmed', reason: '已核实' } },
    { pattern: '/api/appeals', method: 'POST', path: '/api/appeals', body: { subjectId: `${stage.id}:${F9_NE}`, reason: '我不服' } },
    { pattern: '/api/appeals/:id/decide', method: 'POST', path: `/api/appeals/${F9_NE}/decide`, body: { decision: 'accepted', note: '成立' } },
    { pattern: '/api/teams/:id/behavior-events', method: 'POST', path: `/api/teams/${F9_NE}/behavior-events`, body: { type: 'weekly_progress', evidence: { note: 'x' } } },
    { pattern: '/api/pools/sync', method: 'POST', path: '/api/pools/sync', body: { editionId: F9_NE } },
    // 管理端点（2026-10-24 评审轮新增）：登录限频的人工解锁
    // ⚠️ 探测用**普通用户**的会话 ⇒ 期望 403（无 audit:write）
    { pattern: '/api/admin/login-unlock', method: 'POST', path: '/api/admin/login-unlock', body: { phone: F9_NE }, tag: '管理端点：解锁不存在的手机号' },
    { pattern: '/api/registrations', method: 'POST', path: '/api/registrations', body: { editionId: F9_NE, answers: {} } },
    { pattern: '/api/registrations/:id/level', method: 'POST', path: `/api/registrations/${F9_NE}/level`, body: { level: 'A' } },
    { pattern: '/api/stages/:stageId/tiebreak/rounds', method: 'POST', path: `/api/stages/${F9_NE}/tiebreak/rounds`, body: { tiedTeamIds: [F9_NE, 'other'] } },
    { pattern: '/api/tiebreak/rounds/:roundId/votes', method: 'POST', path: `/api/tiebreak/rounds/${F9_NE}/votes`, body: { teamId: F9_NE, score: 80 } },
    { pattern: '/api/tiebreak/rounds/:roundId/close', method: 'POST', path: `/api/tiebreak/rounds/${F9_NE}/close` },
    { pattern: '/api/public/tokens', method: 'POST', path: '/api/public/tokens', body: { editionId: F9_NE, scope: 'all' } },
    { pattern: '/api/public/tokens/:id', method: 'DELETE', path: `/api/public/tokens/${F9_NE}` },
    { pattern: '/api/teams', method: 'POST', path: '/api/teams', body: { editionId: F9_NE, taskPackageId: F9_NE, name: '乙队' } },
    { pattern: '/api/teams/:id/members', method: 'POST', path: `/api/teams/${F9_NE}/members`, body: { action: 'add' } },
    { pattern: '/api/teams/:id', method: 'PATCH', path: `/api/teams/${F9_NE}`, body: { name: '乙队' } },
    { pattern: '/api/stages/:stageId/reviews', method: 'POST', path: `/api/stages/${F9_NE}/reviews`, body: { items: [] } },
    { pattern: '/api/stages/:stageId/calibration', method: 'POST', path: `/api/stages/${F9_NE}/calibration`, body: { items: [] } },
    { pattern: '/api/stages/:stageId/peer-reviews', method: 'POST', path: `/api/stages/${F9_NE}/peer-reviews`, body: { items: [] } },
    { pattern: '/api/stages/:stageId/self-review', method: 'POST', path: `/api/stages/${F9_NE}/self-review`, body: { teamId: F9_NE, items: [] } },
    { pattern: '/api/stages/:stageId/enterprise-confirmations', method: 'POST', path: `/api/stages/${F9_NE}/enterprise-confirmations`, body: { teamId: F9_NE, dimension: 'enterprise', rawScore: 80, content: 'x' } },
    { pattern: '/api/stages/:stageId/enterprise-confirmations/:id/withdraw', method: 'POST', path: `/api/stages/${F9_NE}/enterprise-confirmations/${F9_NE}/withdraw` },
    { pattern: '/api/stages/:stageId/enterprise-confirmations/:id/resign', method: 'POST', path: `/api/stages/${F9_NE}/enterprise-confirmations/${F9_NE}/resign`, body: { rawScore: 90 } },
    { pattern: '/api/stages/:stageId/recusals', method: 'POST', path: `/api/stages/${F9_NE}/recusals`, body: { judgeId: F9_NE, teamId: F9_NE, reason: 'x' } },
    { pattern: '/api/stages/:stageId/compute', method: 'POST', path: `/api/stages/${F9_NE}/compute` },
    { pattern: '/api/task-packages', method: 'POST', path: '/api/task-packages', body: { editionId: F9_NE, title: 'x', mix: {} } },
    { pattern: '/api/task-packages/:id/solvability', method: 'POST', path: `/api/task-packages/${F9_NE}/solvability`, body: { answers: {} } },
    { pattern: '/api/task-packages/:id/approve', method: 'POST', path: `/api/task-packages/${F9_NE}/approve`, body: { grade: 'A' } },

    // ── ② 父资源合法、**请求体里的子 id** 不存在（真正的外键漏网点）──
    { pattern: '/api/stages/:stageId/judges', method: 'POST', path: `/api/stages/${stage.id}/judges`, body: { userId: F9_NE, seat: 'judge' }, tag: '子 id：评委' },
    { pattern: '/api/stages/:stageId/teams', method: 'POST', path: `/api/stages/${stage.id}/teams`, body: { teamIds: [F9_NE] }, tag: '子 id：名册队伍' },
    { pattern: '/api/stages/:stageId/reviews', method: 'POST', path: `/api/stages/${stage.id}/reviews`, body: { items: [{ teamId: F9_NE, dimension: 'track_fit', rawScore: 80 }] }, tag: '子 id：被打分队伍' },
    { pattern: '/api/stages/:stageId/peer-reviews', method: 'POST', path: `/api/stages/${stage.id}/peer-reviews`, body: { items: [{ fromTeamId: team.id, toTeamId: F9_NE, score: 80 }] }, tag: '子 id：被评队' },
    { pattern: '/api/stages/:stageId/enterprise-confirmations', method: 'POST', path: `/api/stages/${stage.id}/enterprise-confirmations`, body: { teamId: team.id, enterpriseId: F9_NE, dimension: 'enterprise', rawScore: 80, content: 'x' }, tag: '子 id：出题企业' },
    { pattern: '/api/stages/:stageId/recusals', method: 'POST', path: `/api/stages/${stage.id}/recusals`, body: { judgeId: fx.admin.id, teamId: F9_NE, reason: 'x' }, tag: '子 id：回避队伍' },
    { pattern: '/api/tiebreak/rounds/:roundId/votes', method: 'POST', path: `/api/tiebreak/rounds/${round.id}/votes`, body: { teamId: F9_NE, score: 80 }, tag: '子 id：被投票队伍' },
    { pattern: '/api/workflows/:id/tasks', method: 'POST', path: `/api/workflows/${wf.id}/tasks`, body: { title: 'T', ownerTeamId: F9_NE }, tag: '子 id：承接队' },
    { pattern: '/api/tasks/:id/claim', method: 'POST', path: `/api/tasks/${wfTask.id}/claim`, body: { teamId: F9_NE }, tag: '子 id：领取队' },
    { pattern: '/api/teams', method: 'POST', path: '/api/teams', body: { editionId: edition.id, taskPackageId: F9_NE, name: '乙队' }, tag: '子 id：任务包' },
    { pattern: '/api/teams/:id', method: 'PATCH', path: `/api/teams/${team.id}`, body: { taskPackageId: F9_NE }, tag: '子 id：任务包' },
    { pattern: '/api/stages/:stageId/tiebreak/rounds', method: 'POST', path: `/api/stages/${stage.id}/tiebreak/rounds`, body: { tiedTeamIds: [team.id, F9_NE] }, tag: '子 id：同分组队伍' },
    { pattern: '/api/milestones/:id/signoff/withdraw', method: 'POST', path: `/api/milestones/${milestoneId}/signoff/withdraw`, body: { signoffId: F9_NE }, tag: '子 id：签字' },

    // ── ③ 不引用资源 id 的写端点（登出 / 改口令）─────────────────────
    //    ⚠️ 这几个没有「资源不存在」这回事 ⇒ 断言口径是「不 5xx、不漏原文」。
    { pattern: '/api/auth/login', method: 'POST', path: '/api/auth/login', body: { phone: F9_NE, password: 'x' }, noCookie: true, allow401: true },
    { pattern: '/api/auth/password', method: 'POST', path: '/api/auth/password', body: { oldPassword: 'wrong', newPassword: 'x' }, allow401: true },
    { pattern: '/api/auth/logout', method: 'POST', path: '/api/auth/logout', expect: 200, throwaway: 0 },
    { pattern: '/api/auth/logout-all', method: 'POST', path: '/api/auth/logout-all', expect: 200, throwaway: 1 },
  ];
}

/** 一次探针 ⇒ 一次真实请求。 */
async function f9Probe(base, cookie, probe) {
  const headers = {};
  if (!probe.noCookie) headers.Cookie = cookie;
  if (probe.body !== undefined) headers['Content-Type'] = 'application/json';
  // ⚠️ 用 F9_REAL_FETCH 而不是 globalThis.fetch（见它的注释：F24 的桩不还原）。
  const res = await F9_REAL_FETCH(base + probe.path, {
    method: probe.method, headers,
    body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
  });
  return { status: res.status, text: await res.text() };
}

/** 探针的断言：状态码 + 「不得漏 SQLite 原文」。 */
function assertF9Probe(probe, r) {
  const label = `${probe.method} ${probe.pattern}${probe.tag ? `（${probe.tag}）` : ''}`;
  if (probe.expect === 200) {
    assert.equal(r.status, 200, `${label} 期望 200，实际 ${r.status}：${r.text}`);
  } else {
    assert.ok(
      r.status >= 400 && r.status < 500,
      `${label} 引用不存在的 id 必须回 4xx（404/400/403/409），实际 ${r.status}：${r.text}`,
    );
  }
  // ⚠️ **防假绿**：401 也是 4xx ⇒ 「会话失效」会让每个探针都回 401，扫描就**假绿**了。
  //    ⇒ 带会话的探针一律**不许**回 401（真会话下，写端点没有理由说「你没登录」）。
  if (!probe.allow401) {
    assert.notEqual(r.status, 401, `${label} 回了 401（会话失效 ⇒ 扫描假绿）：${r.text}`);
  }
  assert.doesNotMatch(
    r.text,
    /SQLITE|constraint failed|FOREIGN KEY|NOT NULL|UNIQUE/i,
    `${label} 把数据库原文漏到了响应体：${r.text}`,
  );
}

test('F9 全写端点扫描：引用不存在的 id 一律 4xx，且没有一个漏 SQLite 原文', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    // ⚠️ **先验会话是活的**（防假绿的第一道闸）：
    //    401 也是 4xx ⇒ 若会话失效（例如本文件 F24 的用例换了 globalThis.fetch 且不还原），
    //    每个探针都会回 401，扫描会**假绿**。⇒ 先断言「我确实是登录态」。
    const me = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'GET', path: '/api/me',
    });
    assert.equal(me.status, 200, `扫描用的会话必须是登录态（否则扫描假绿）：${me.text}`);
    const probes = f9ProbeTable(fx);
    for (const probe of probes) {
      const cookie = probe.throwaway !== undefined
        ? `hk_session=${fx.throwawayTokens[probe.throwaway]}`
        : `hk_session=${fx.token}`;
      const r = await f9Probe(base, cookie, probe);
      assertF9Probe(probe, r);
    }
  });
});

test('F9b 写端点扫描表必须覆盖全部已注册的写路由（新增写端点必须补进扫描表）', async () => {
  await withF9Server(async ({ db, router }) => {
    const fx = await seedF9Fixture(db);
    const covered = new Set(f9ProbeTable(fx).map((p) => `${p.method} ${p.pattern}`));
    const registered = router.list()
      .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))
      .map((r) => `${r.method} ${r.pattern}`);
    const missing = registered.filter((k) => !covered.has(k));
    assert.deepEqual(
      missing, [],
      `新增的写端点必须补进 F9 扫描表（否则它就没人管）：${missing.join('、')}`,
    );
    const stale = [...covered].filter((k) => !registered.includes(k));
    assert.deepEqual(stale, [], `F9 扫描表里有已不存在的路由：${stale.join('、')}`);
  });
});

test('F9c 企业确认引用不存在的出题企业必须 404（修复前是 500：FOREIGN KEY constraint failed）', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    const body = {
      teamId: fx.team.id, enterpriseId: F9_NE,
      dimension: 'enterprise', rawScore: 80, content: '我方已投入产品负责人',
    };
    const r = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST', path: `/api/stages/${fx.stage.id}/enterprise-confirmations`, body,
    });
    // 修复前：enterprise_id 外键 ⇒ `FOREIGN KEY constraint failed` ⇒ 500
    assert.notEqual(r.status, 500, `外键错误漏成 500：${r.text}`);
    assert.equal(r.status, 404, `不存在的出题企业必须是 404，实际 ${r.status}：${r.text}`);
    assert.match(r.text, /USER_NOT_FOUND/, `错误码必须是 USER_NOT_FOUND：${r.text}`);
    assert.doesNotMatch(r.text, /constraint failed|SQLITE/i, `不得漏数据库原文：${r.text}`);
  });
});

test('F9d 三池同步引用不存在的届期必须 404（修复前是 200：假装同步了一个不存在的届期）', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    const r = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST', path: '/api/pools/sync', body: { editionId: F9_NE },
    });
    // 修复前：同步 0 行、回 200 —— 与其它写端点（404 EDITION_NOT_FOUND）口径不一致
    assert.equal(r.status, 404, `不存在的届期必须是 404，实际 ${r.status}：${r.text}`);
    assert.match(r.text, /EDITION_NOT_FOUND/, `错误码必须是 EDITION_NOT_FOUND：${r.text}`);
  });
});

test('F9e 对照组：合法的写请求仍然成功（不得把 F9 修成「一律 404」）', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    // ① 企业确认：合法的出题企业（= 自己）⇒ 必须落库成功
    const ok = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST',
      path: `/api/stages/${fx.stage.id}/enterprise-confirmations`,
      body: {
        teamId: fx.team.id, enterpriseId: fx.admin.id,
        dimension: 'enterprise', rawScore: 80, content: '我方已投入产品负责人',
      },
    });
    assert.equal(ok.status, 200, `合法的企业确认必须成功：${ok.text}`);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations').get().n;
    assert.equal(rows, 1, '合法的企业确认必须真的落库（不得被「存在性校验」误杀）');

    // ② 三池同步：合法的届期 ⇒ 必须同步成功
    const sync = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST', path: '/api/pools/sync', body: { editionId: fx.edition.id },
    });
    assert.equal(sync.status, 200, `合法的三池同步必须成功：${sync.text}`);
  });
});

// ══════════════════════════════════════════════════════════════════
// F48：can() 与 scopeClause() 的「超管形状」不一致（2026-10-23 审计 §3.5）
//
//   现象：can() 信任**传入对象**的超管标志（is_superadmin === 1 || isSuperadmin === true），
//         scopeClause() 只查**库**（EXISTS (SELECT 1 FROM users su WHERE su.id = ? AND su.is_superadmin = 1)）
//         ⇒ 两者可能给出**相反**结论。
//   本批修法（不碰既有契约）：
//     ① 对外形状（toPublicUser）**同时**带 is_superadmin 与 isSuperadmin
//        ⇒ 只认一种形状的服务层（tier / performance-card / workflow / milestone）
//          拿到对外形状时也能认到超管 ⇒ 全仓「形状不一致」的点一次消掉；
//     ② 把「已知取舍」写清楚并钉住（can() 信任传入对象 / scopeClause() 只信库；
//        生产链路上 ctx.user 永远是库里的行 ⇒ 两者必然一致）；
//     ③ 机器闸：**同一个真实用户**（库里分别是超管 / 非超管），
//        can() 与 scopeClause() 的结论必须**永远一致**（三种传入形状都测）。
//
//   ⚠️ 契约溯源：INTERFACES.md:22「判定只有 can(user, capability, ctx, db) 一个入口。
//      SQL 层过滤用 scopeClause(...) —— 两者**必须给出相同结论**」。
// ══════════════════════════════════════════════════════════════════

/** F48 专用能力点：**谁都没有**（无角色、无授权）
 *  ⇒ can() / scopeClause() 的结论只可能由「超管标志」决定 ⇒ 这条断言是判别性的：
 *    恒真实现（永远放行）与恒假实现（永远拒绝）都会红。 */
const F48_CAP = 'audit:read';

test('F48 can() 与 scopeClause() 对同一个真实用户的超管判定必须永远一致（库行 / 对外形状 / 纯驼峰）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f48-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  try {
    insertCapability(db, F48_CAP, 'F48 用：谁都没有的能力点');
    // 假资源表：用来**真跑** scopeClause 生成的 SQL（断言不是恒真）
    db.exec('CREATE TABLE fake_resources (id TEXT PRIMARY KEY, title TEXT)');
    db.exec("INSERT INTO fake_resources (id, title) VALUES ('r1', '资源一')");

    const superadmin = createUser(db, { name: '超管', phone: '13800008001', password: 'pw' });
    setSuperadmin(db, superadmin.id);
    const normal = createUser(db, { name: '普通用户', phone: '13800008002', password: 'pw' });

    /** scopeClause 生成的片段真跑 SQL ⇒ 这个用户能不能看见这一行 */
    const scopeVisible = (userId) => {
      const { sql, params } = scopeClause(userId, F48_CAP, { scopeType: 'team', alias: 't' });
      return db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params).length > 0;
    };

    for (const [label, user] of [['超管', superadmin], ['非超管', normal]]) {
      const row = getUserById(db, user.id);      // 库行形状（snake_case，生产链路 ctx.user 就是它）
      const pub = toPublicUser(row);             // 对外形状（camelCase + 蛇形，产出点已统一）
      // 纯驼峰形状（手搓、**不带** is_superadmin）：can() 必须照样认得出来
      const camel = { id: user.id, isSuperadmin: row.is_superadmin === 1, active: row.active === 1 };
      for (const [shapeName, shape] of [['库行', row], ['对外形状', pub], ['纯驼峰', camel]]) {
        const viaCan = can(shape, F48_CAP, null, db);
        const viaScope = scopeVisible(user.id);
        assert.equal(
          viaCan,
          viaScope,
          `${label}（${shapeName}）：can()=${viaCan} 与 scopeClause()=${viaScope} 必须一致`
          + '｜契约：INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...) —— 两者必须给出相同结论」',
        );
      }
    }

    // 判别性对照：这个能力点谁都没有 ⇒ 非超管必须**两边都判否**
    //（恒真实现会因为这一条变红；恒假实现会因为上面「超管」那几条变红）
    assert.equal(
      can(getUserById(db, normal.id), F48_CAP, null, db), false,
      '没有角色也没有授权 ⇒ can() 必须判否',
    );
    assert.equal(
      scopeVisible(normal.id), false,
      '没有角色也没有授权 ⇒ scopeClause 必须过滤掉这一行',
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F48b 对外形状必须同时带 is_superadmin 与 isSuperadmin（只认一种形状的服务层会让超管静默降级）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f48b-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    const admin = createUser(db, { name: '超管', phone: '13800008011', password: 'pw' });
    setSuperadmin(db, admin.id);
    const normal = createUser(db, { name: '普通用户', phone: '13800008012', password: 'pw' });
    const edition = createEdition(db, {
      name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now,
    });
    // 一支**没有段位记录**的队伍 ⇒ 默认 D 段 ⇒ D 段不公示（rules/visibility.json: rank.publicFromTier='C'）
    // ⇒ 非成员、非超管看不到它（404）⇒ 能看到它的只有「成员」与「超管」。
    const team = insertTeam(db, {
      editionId: edition.id, name: '一队', captainId: admin.id, status: 'active', now,
    });

    const adminPub = toPublicUser(getUserById(db, admin.id));
    const normalPub = toPublicUser(getUserById(db, normal.id));

    // ① 对外形状必须**同时**带两种键（服务层 tier/workflow/performance-card/milestone 只认 is_superadmin === 1）
    assert.equal(adminPub.is_superadmin, 1, '对外形状必须带 is_superadmin（服务层只认这一种）');
    assert.equal(adminPub.isSuperadmin, true, '对外形状必须带 isSuperadmin（can() 认这一种）');
    // 对照组：非超管两个键都必须是「假」——不得一律给 1（否则等于人人超管）
    assert.equal(normalPub.is_superadmin, 0, '非超管的 is_superadmin 必须是 0');
    assert.equal(normalPub.isSuperadmin, false, '非超管的 isSuperadmin 必须是 false');

    // ② 服务层真的能认出「对外形状」的超管（修复前：对外形状没有 is_superadmin ⇒ 404 ⇒ 超管静默降级）
    const { getTeamTier } = await import('../src/services/tier.js');
    const tier = getTeamTier({ db, teamId: team.id, viewer: adminPub, rules });
    assert.equal(tier.teamId, team.id, '超管的对外形状必须能读到 D 段队伍（修复前是 404）');
    // 对照组：非超管的对外形状仍然看不到 D 段队伍（不得把闸门拆了）
    assert.throws(
      () => getTeamTier({ db, teamId: team.id, viewer: normalPub, rules }),
      (err) => err?.status === 404,
      '非超管看不到 D 段队伍（必须仍回 404）',
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// F47：同分互投率检测（R-RNK-08）**永远拿不到数据** ⇒ 规则写在纸上，链路是死的
//
//   现象：R-RNK-08「同分队伍互投率过高 ⇒ 组委会复核」这条规则**永远不可能触发**。
//   根因：detectTiedMutualPeerRate 需要两样东西 —— **最终名次**（同分组）与**互投的队伍对**；
//         而全站唯一的生产调用点（src/services/compute.js）在**计算期**传的是 results: []
//         （名次是发榜时破同分链跑完才有的）⇒ 这条检测永远拿不到数据。
//   修法：发榜时（名次已落库）**再跑一次**检测：
//         ① 名次来自 stage_results.rank（发榜回写，F7）；
//         ② 互评数据来自 peer_reviews（队 → 队）。
//
//   ⚠️ **互评数据在本仓的真实存储位置**（取证结论，不要凭印象）：
//     · 互评**只**存在 `peer_reviews` 表（db/migrations/003_review.sql:132）：
//       stage_id / from_team_id / to_team_id / score / request_id / created_at；
//     · `stage_reviews`（评委打分表）**没有 seat 列** ⇒「stage_reviews 里 seat='peer' 那一路」
//       在本仓**不存在**；本仓的「互评」是**队 → 队**的行为（from_team_id → to_team_id）。
// ══════════════════════════════════════════════════════════════════

/**
 * 造一个 F47 用的赛段：两支队 + 一名评委 + 若干互评。
 * @param {number} scoreA A 队评委分
 * @param {number} scoreB B 队评委分（与 A 相同 ⇒ 两队同分）
 * @param {boolean} withPeerReviews 是否写入互评（A↔B 互投，且**两个方向同分**
 *   ——破同分链的「互评分」这一级也分不开 ⇒ 两队仍然并列）
 */
function seedF47Stage(db, { now, scoreA, scoreB, withPeerReviews = true }) {
  db.exec(`INSERT INTO users (id,name,phone,password_hash,mba_status,org,is_superadmin,active,created_at) VALUES ('u1','U','13800009001','x','mba',NULL,1,1,'${now}')`);
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_a','ed1','A队','u1','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_b','ed1','B队','u1','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s1','st1','tm_a','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s2','st1','tm_b','${now}')`);
  db.exec(`INSERT INTO stage_judges (stage_id,user_id,seat,scope_type,scope_id,assigned_at) VALUES ('st1','u1','judge','global',NULL,'${now}')`);
  for (const [team, score] of [['tm_a', scoreA], ['tm_b', scoreB]]) {
    for (const dim of ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']) {
      db.prepare(`INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,request_id,calibrated,submitted_at) VALUES (?,?,?,?,?,?,?,0,?)`)
        .run(`r_${team}_${dim}`, 'st1', 'u1', team, dim, score, `req_${team}_${dim}`, now);
    }
  }
  if (withPeerReviews) {
    insertPeerReview(db, { stageId: 'st1', fromTeamId: 'tm_a', toTeamId: 'tm_b', score: 90, requestId: 'pr_ab', now });
    insertPeerReview(db, { stageId: 'st1', fromTeamId: 'tm_b', toTeamId: 'tm_a', score: 90, requestId: 'pr_ba', now });
  }
}

/** F47 专用：算完 + 发榜（走**真实服务层**，不是 mock） */
async function computeAndPublishF47(db, rules, now) {
  const { computeStage } = await import('../src/services/compute.js');
  const { publishLeaderboard } = await import('../src/services/leaderboard.js');
  computeStage({ db, stageId: 'st1', actorId: 'u1', now, rules });
  return publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: 'u1', now, rules });
}

test('F47 发榜后「同分互投率过高」必须真的检出并进复核队列（R-RNK-08 不得是死规则）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f47-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    seedF47Stage(db, { now, scoreA: 80, scoreB: 80 });   // 两队同分
    await computeAndPublishF47(db, rules, now);

    // 前提（判别性）：两队确实并列，且名次已落库（发榜回写，F7）
    const results = db.prepare('SELECT team_id, rank FROM stage_results WHERE stage_id = ? ORDER BY team_id').all('st1');
    assert.equal(results.length, 2, '应有 2 行赛段结果');
    assert.equal(results[0].rank, results[1].rank, '两队必须同分（名次相同）——否则这条检测本来就不该触发');

    // 修复前：发榜后仍然**一条 flag 都没有**（检测永远拿不到名次 ⇒ 规则是死的）
    const flags = db.prepare("SELECT kind, team_id, detail_json FROM flagged_reviews WHERE kind = 'tied_mutual_peer_rate'").all();
    assert.equal(flags.length, 1, '同分队伍互投率 100% ≥ 阈值 0.8 ⇒ 必须检出并进人工复核队列');
    const detail = JSON.parse(flags[0].detail_json);
    assert.equal(detail.rank, results[0].rank, '告警明细必须带上名次（说明检测真的拿到了名次）');
    assert.equal(detail.rate, 1, '互投率必须是 1（1 组候选对、1 组互投）');
    assert.deepEqual(detail.tiedPairs, [['tm_a', 'tm_b']], '告警明细必须指出是哪两支队互投');
    assert.equal(detail.action, 'alert_only', '检测 ≠ 处罚：只告警，不改分、不封号');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F47b 对照组：两队**不同分**时，即使互投也不得报「同分互投率」（否则这条检测毫无判别力）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f47b-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    seedF47Stage(db, { now, scoreA: 90, scoreB: 70 });   // 两队不同分 ⇒ 名次不同 ⇒ 不构成「同分队伍」
    await computeAndPublishF47(db, rules, now);
    const n = db.prepare("SELECT COUNT(*) AS n FROM flagged_reviews WHERE kind = 'tied_mutual_peer_rate'").get().n;
    assert.equal(n, 0, '不同分的两队不构成「同分队伍互投」⇒ 不得告警（否则这条检测对谁都报）');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F47c 对照组：两队同分但**没有互投**时不得报「同分互投率」（告警必须来自真实互评数据）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f47c-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    seedF47Stage(db, { now, scoreA: 80, scoreB: 80, withPeerReviews: false });
    await computeAndPublishF47(db, rules, now);
    const n = db.prepare("SELECT COUNT(*) AS n FROM flagged_reviews WHERE kind = 'tied_mutual_peer_rate'").get().n;
    assert.equal(n, 0, '没有互投记录 ⇒ 不得凭空报「互投率过高」');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 第 11 批（2026-10-24 独立评审轮）：评审提出的「登录限频定向 DoS」
//
// ⚠️⚠️ **复核结论与评审说的不一样（这是本批最重要的产出）**：
//   评审原话：「登录限频按手机号 60s/10 次锁定，知道评委手机号的人
//              可以在打分窗口把他锁在门外。」
//   ⇒ **复核后判定：该后果不成立**。原因：限频判定**只在口令校验失败的分支里**
//     执行（src/server.js 的登录路由：`if (!ok) { assertRateLimit(...); throw 401; }`）
//     ⇒ **受害者只要输对口令，登录永远不会被挡**。
//     ⇒ 「正确口令永远能登录」是一条**必须保住的不变量** —— 它正是对
//        「账号被锁死」的根本防护（限频只罚失败，不罚成功）。
//
//   ⇒ **但真正的问题在隔壁**：限频判定发生在 **scrypt 之后**
//     ⇒ **被限流的请求照样跑一遍 scrypt** ⇒ 限频只把 401 换成 429，
//     **挡不住 CPU 打爆**（⇒ 这才是真实的 DoS 面：打的是**服务器**，不是账号）。
//     ⇒ 修法：① **只读预检前置**（来源维度，判定在 scrypt 之前
//              ⇒ 被挡请求**不跑 scrypt**）；② 补「来源」维度的独立配额；
//             ③ 应急出口：管理员可**整体解除**登录限频（限频误伤整个出口时）。
//
//   ⇒ 本批用例必须钉住：**①** 正确口令永远能登录（不变量）
//     **②** 来源被判定为攻击源后连正确口令也挡（预检前置 + fail-closed）
//     **③** 枚举安全（存在与不存在的号在同一处触顶）
//     **④** 管理员应急出口可用且留痕。
// ══════════════════════════════════════════════════════════════════

/** 用指定「来源 IP」打一次登录（X-Real-IP 由同机 nginx **覆盖**写入 ⇒ 可信）。 */
async function loginFrom(base, { phone, password, ip }) {
  return call(base, 'POST', '/api/auth/login', {
    body: { phone, password },
    headers: ip ? { 'X-Real-IP': ip } : {},
  });
}

// ═══ R1：不变量 —— 账号配额被耗光后，正确口令仍必须能登录 ═══
// ⚠️ 这是本批的**核心钉子**：它同时**证伪**评审的「把受害者锁在门外」，
//    并**锁住**「正确口令永远能登录」这条防护。
//    判别性：实现若改成「配额也管成功登录」，本条立刻红。
test('R1 账号配额被耗光后，正确口令仍必须能登录（限频只罚失败、不罚成功）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '评委', phone: '13800009901', password: 'right-pw' });
    // 用**多个来源**打满该手机号的账号配额（10 次/60s）
    for (const ip of ['10.0.3.1', '10.0.3.2', '10.0.3.3']) {
      for (let i = 0; i < 4; i += 1) {
        await loginFrom(base, { phone: '13800009901', password: 'wrong-pw', ip });
      }
    }
    const ok = await loginFrom(base, { phone: '13800009901', password: 'right-pw', ip: '10.0.3.9' });
    assert.equal(
      ok.status, 200,
      `正确口令被挡了（返回 ${ok.status}）—— 这条不变量是防「账号被锁死」的根本防护；`
      + ' 限频必须只罚失败、不罚成功',
    );
  });
});

// ═══ R2：对照组 —— 正常误输不得误伤 ═══
test('R2 正常误输几次后必须仍能登录（来源配额不能误伤正常用户）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '组员', phone: '13800009902', password: 'right-pw' });
    for (let i = 0; i < 3; i += 1) {
      const r = await loginFrom(base, { phone: '13800009902', password: 'wrong-pw', ip: '10.0.1.1' });
      assert.equal(r.status, 401, '口令错就是 401（⛔ 不是 429 —— 3 次误输不该触发任何配额）');
    }
    const ok = await loginFrom(base, { phone: '13800009902', password: 'right-pw', ip: '10.0.1.1' });
    assert.equal(ok.status, 200, '误输 3 次后必须仍能正常登录');
  });
});

// ═══ R3：枚举安全 —— 「账号存在」与「账号不存在」必须在同一处触顶 ═══
// ⚠️ 这是**否决评审第二条建议**（「存在与否分开计数」）的理由的机器钉子：
//    若分开计数，攻击者拿不存在的号试到 429、拿真实号还拿到 401 ⇒ 可枚举已注册手机号。
test('R3 登录限频不得泄露手机号是否已注册（存在与不存在的号必须在同一处触顶）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '真实用户', phone: '13800009903', password: 'right-pw' });

    const first429 = async (phone, ip) => {
      for (let i = 0; i < 40; i += 1) {
        const r = await loginFrom(base, { phone, password: 'wrong-pw', ip });
        if (r.status === 429) return i + 1;
      }
      return -1;
    };
    const missing = await first429('13800000000', '10.0.2.1');   // 不存在的号
    const exists = await first429('13800009903', '10.0.2.2');   // 存在的号
    assert.ok(missing > 0 && exists > 0, '两边都必须在某处触顶 429');
    assert.equal(
      missing, exists,
      `「账号不存在」第 ${missing} 次触顶、「账号存在」第 ${exists} 次触顶 ⇒ 两者时机不同 ⇒ 可被用来枚举已注册手机号`,
    );
  });
});

// ═══ R4：来源维度的预检必须**前置**（判定在 scrypt 之前）═══
// ⚠️ 这条钉的是**真问题**：原实现里限频判定在 scrypt **之后**
//    ⇒ 被限流的请求照样跑一遍 scrypt ⇒ 挡不住 CPU 打爆。
//    ⇒ 修后：来源被判定为攻击源 ⇒ **连正确口令也 429**（预检在前 ⇒ 不跑 scrypt）。
//    ⚠️ 判别性：若把预检挪回 scrypt 之后，本条会红（正确口令会 200）。
test('R4 来源被判定为攻击源后必须直接 429（预检必须前置到 scrypt 之前）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '评委', phone: '13800009904', password: 'right-pw' });
    // 把来源 10.0.4.1 打成攻击源（sliding 20/60s）
    let got429 = false;
    for (let i = 0; i < 30; i += 1) {
      const r = await loginFrom(base, { phone: '13800009904', password: 'wrong-pw', ip: '10.0.4.1' });
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, '来源配额必须能触发（否则来源维度没生效）');
    // ⚠️ 连**正确口令**也必须 429 —— 这证明预检在 scrypt 之前（否则会 200）
    const ok = await loginFrom(base, { phone: '13800009904', password: 'right-pw', ip: '10.0.4.1' });
    assert.equal(
      ok.status, 429,
      `正确口令居然能登录（返回 ${ok.status}）⇒ 预检不在 scrypt 之前 ⇒ `
      + '被限流的请求照样跑 scrypt ⇒ 挡不住 CPU 打爆',
    );
    assert.ok(ok.headers['retry-after'], '429 必须带 Retry-After（⛔ 不静默丢包）');
  });
});

// ═══ R5：管理员应急出口 —— 整体解除登录限频 + 权限 + 留痕 ═══
// ⚠️ 为什么必须有它：来源预检是 fail-closed 的 ⇒ 共享出口 IP（办公室/校园网）
//    一旦被误判 ⇒ **整个出口的人都被挡**（含正确口令）⇒ 必须有人能立刻解除。
test('R5 管理员可整体解除登录限频；非管理员 403、未登录 401、且必须留痕', async () => {
  await withServer(async ({ base, db }) => {
    const admin = createUser(db, { name: '组委会', phone: '13800009905', password: 'admin-pw' });
    insertRole(db, 'admin', '组委会');
    insertCapability(db, 'audit:write', '裁决复核项与申诉');
    insertRoleCapability(db, 'admin', 'audit:write');
    insertUserRole(db, admin.id, 'admin');
    const member = createUser(db, { name: '组员', phone: '13800009906', password: 'member-pw' });
    insertRole(db, 'member', '组员');
    insertUserRole(db, member.id, 'member');
    createUser(db, { name: '评委', phone: '13800009907', password: 'right-pw' });

    // ① 把来源打成攻击源
    for (let i = 0; i < 30; i += 1) {
      const r = await loginFrom(base, { phone: '13800009907', password: 'wrong-pw', ip: '10.0.5.1' });
      if (r.status === 429) break;
    }
    const blocked = await loginFrom(base, { phone: '13800009907', password: 'right-pw', ip: '10.0.5.1' });
    assert.equal(blocked.status, 429, '此刻该来源应当被挡');

    // ② 未登录 ⇒ 401；③ 非组委会 ⇒ 403
    const anon = await call(base, 'POST', '/api/admin/login-unlock', { body: { all: true } });
    assert.equal(anon.status, 401, '未登录解除限频必须 401');
    const memberSession = createSession(db, member.id);
    const asMember = await call(base, 'POST', '/api/admin/login-unlock', {
      body: { all: true }, cookie: `hk_session=${memberSession.token}`,
    });
    assert.equal(asMember.status, 403, '非组委会不得解除限频（⛔ 否则限频等于没有）');

    // ④ 组委会整体解除 ⇒ 该来源立刻恢复
    const adminSession = createSession(db, admin.id);
    const cleared = await call(base, 'POST', '/api/admin/login-unlock', {
      body: { all: true }, cookie: `hk_session=${adminSession.token}`,
    });
    assert.equal(cleared.status, 200, '组委会必须能整体解除登录限频');
    const after = await loginFrom(base, { phone: '13800009907', password: 'right-pw', ip: '10.0.5.1' });
    assert.equal(after.status, 200, '解除后必须立刻能登录（应急出口的意义就在这里）');

    // ⑤ 必须留痕（人工干预安全闸 ⇒ 谁、何时、解除范围）
    const rows = db.prepare('SELECT * FROM audit_log WHERE action = ?').all('auth.login_limit_clear_all');
    assert.equal(rows.length, 1, '解除限频必须写审计日志');
    assert.equal(rows[0].actor_id, admin.id, '审计日志必须记下操作人');
  });
});

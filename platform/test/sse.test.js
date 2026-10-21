// platform/test/sse.test.js — SSE 评审进度推送
// 依据：P0 终态 web/api.js:28-30 承诺「SSE 端点在 P2 才实现（src/http/sse.js）」
//   + 设计文档 §4.3 的目录清单 + INTERFACES.md §3（API（P2））
//
// ⚠️ 本轮（2026-10-21 父代理预审）追加的用例：
//   ① **权限闸门**：规格只要求「登录」→ 任何登录用户都能订阅任意赛段，
//      等于把「谁在什么时候提交了评分」广播给所有人。现在要求
//      组委会 / score:read / 本赛段评委。
//   ② **畸形百分号编码**不得让 parseSsePath 抛 URIError（P0 的教训）。
//   ③ **心跳注释帧**存在（否则中间代理 60s 掐线，前端每分钟重连）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import {
  parseSsePath, sendSseEvent, sendSseComment, createSseHub, reviewEvents,
} from '../src/http/sse.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sse-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const webDir = mkdtempSync(join(tmpdir(), 'hks-sse-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  const app = createApp({ db, rules, webDir });

  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13800000901', password: 'pw123' });
  const outsider = createUser(db, { name: '路人甲', phone: '13800000902', password: 'pw123' });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });

  return {
    db, close, dataDir, webDir, app, stage, judge, outsider,
    tokenJudge: createSession(db, judge.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function cleanup(ctx) {
  reviewEvents.closeAll();
  rmSync(ctx.dataDir, { recursive: true, force: true });
  rmSync(ctx.webDir, { recursive: true, force: true });
  ctx.close();
}

/** 假响应：只记录 writeHead / write / end（测帧格式用，不必起真服务器）。 */
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    chunks,
    writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

/**
 * 开一条 SSE 连接，返回一个小工具对象。
 * ⚠️ 错误必须吞掉：客户端主动 destroy 时 res 会抛 ECONNRESET，
 *    不接 error 处理器会变成 unhandled → 整个测试文件崩掉。
 */
function openSse(port, path, token) {
  const chunks = [];
  let status = null;
  let headers = null;
  let reqRef = null;
  const ready = new Promise((resolve, reject) => {
    reqRef = http.get(
      {
        host: '127.0.0.1', port, path,
        headers: token ? { cookie: `hk_session=${token}` } : {},
      },
      (res) => {
        status = res.statusCode;
        headers = res.headers;
        res.on('data', (c) => chunks.push(c.toString()));
        res.on('error', () => {});
        resolve();
      },
    );
    // ⚠️ 连接出错时**必须 reject**：只吞掉错误的话，`ready` 永远不 settle
    //    → 等待它的用例**永久挂起**（而不是干净地失败）。
    reqRef.on('error', (e) => reject(e));
  });
  return {
    ready,
    get status() { return status; },
    get headers() { return headers; },
    text: () => chunks.join(''),
    waitForEvent(name, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          const t = chunks.join('');
          if (t.includes(`event: ${name}`)) return resolve(t);
          if (Date.now() > deadline) return reject(new Error(`等待事件 ${name} 超时`));
          setTimeout(tick, 20);
        };
        tick();
      });
    },
    close() { try { reqRef?.destroy(); } catch { /* ignore */ } },
  };
}

/** 轮询等待某个条件成立（用于「客户端断开后订阅者被摘掉」这类异步收尾）。 */
async function waitUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

test('parseSsePath 能解析 /api/stages/:stageId/events，非 SSE 路径返回 null', () => {
  assert.deepEqual(parseSsePath('/api/stages/st-1/events'), { stageId: 'st-1' });
  assert.deepEqual(parseSsePath('/api/stages/st-1/events?x=1'), { stageId: 'st-1' });
  assert.equal(parseSsePath('/api/stages/st-1/reviews'), null);
  assert.equal(parseSsePath('/api/health'), null);
  // ⛔ 路径必须在 `events` **之后**就结束（或紧跟一个 `?`）：
  //    `/eventsX` 不是 SSE 路径 —— 否则后缀匹配会误开一条流。
  assert.equal(parseSsePath('/api/stages/st-1/eventsX'), null);
  assert.equal(parseSsePath('/api/stages/st-1/events/'), null);
});

test('⛔ 畸形百分号编码不得让 parseSsePath 抛错（P0 的教训）', () => {
  assert.equal(parseSsePath('/api/stages/%E0%A4%A/events'), null);
  assert.equal(parseSsePath('/api/stages/%/events'), null);
});

test('sendSseEvent 写出的帧符合 SSE 规范：event + 单行 data + 空行结尾', () => {
  const res = fakeRes();
  assert.equal(sendSseEvent(res, 'review.progress', { stageId: 'st-1' }), true);
  assert.equal(res.text(), 'event: review.progress\ndata: {"stageId":"st-1"}\n\n');
});

test('sendSseEvent 对已结束的响应静默返回 false（客户端已断开）', () => {
  const res = fakeRes();
  res.end();
  assert.equal(sendSseEvent(res, 'x', {}), false);
  assert.equal(res.text(), '');
});

test('sendSseEvent 的载荷在数据缺省时必须是 null（不能写出 undefined）', () => {
  const res = fakeRes();
  assert.equal(sendSseEvent(res, 'x'), true);
  assert.equal(res.text(), 'event: x\ndata: null\n\n');
});

test('sendSseComment 写的是注释帧（心跳），EventSource 会忽略它', () => {
  const res = fakeRes();
  assert.equal(sendSseComment(res, 'ping'), true);
  assert.equal(res.text(), ': ping\n\n');
});

test('sendSseComment 对已结束的响应静默返回 false', () => {
  const res = fakeRes();
  res.end();
  assert.equal(sendSseComment(res, 'ping'), false);
  assert.equal(res.text(), '');
});

test('createSseHub 的 publish 只发给同 topic 的订阅者', () => {
  const hub = createSseHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.add(a, 'stage:st-1');
  hub.add(b, 'stage:st-2');
  assert.equal(hub.publish('review.progress', { n: 1 }, 'stage:st-1'), 1);
  assert.ok(a.text().includes('event: review.progress'));
  assert.equal(b.text(), '');
  hub.closeAll();
});

test('createSseHub 的 closeAll 会结束所有订阅连接并清空订阅者', () => {
  const hub = createSseHub();
  const a = fakeRes();
  hub.add(a, 'stage:st-1');
  assert.equal(hub.size, 1);
  hub.closeAll();
  assert.equal(a.writableEnded, true);
  assert.equal(hub.size, 0);
});

test('GET /api/stages/:stageId/events 建立 SSE 连接并先发 connected 首帧', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // ⚠️ 断言必须放在 promise **之外**：断言写在 http 回调里抛错时，
    //    promise 既不 resolve 也不 reject → 用例**永远挂起**（而不是干净地失败）。
    //    这会让变异检出信号从「断言失败」退化成「测试挂住」，很难区分。
    const frame = await new Promise((resolve, reject) => {
      // ⚠️ 用**墙钟定时器**而不是 req.setTimeout：后者是 socket 超时，
      //    响应一旦结束就被清掉 → 承诺永不 settle → 用例挂起而不是失败。
      const guard = setTimeout(() => reject(new Error('SSE 首帧超时')), 3000);
      const done = (v) => { clearTimeout(guard); resolve(v); };
      const fail = (e) => { clearTimeout(guard); reject(e); };
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}` },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString();
            if (buf.includes('\n\n')) done({ buf, status: res.statusCode, headers: res.headers });
          });
          res.on('end', () => done({ buf, status: res.statusCode, headers: res.headers }));
          res.on('error', fail);
        },
      );
      req.on('error', fail);
    });
    assert.equal(frame.status, 200);
    assert.match(String(frame.headers['content-type']), /text\/event-stream/);
    assert.match(frame.buf, /^event: connected\n/);
    assert.match(frame.buf, new RegExp(`"stageId":"${ctx.stage.id}"`));
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 未登录订阅 SSE → 401', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/stages/${ctx.stage.id}/events` },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('超时')));
    });
    assert.equal(status, 401);
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 无权限的人订阅 SSE → 403（登录不等于有权看评审进度）', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenOutsider}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('超时')));
    });
    assert.equal(status, 403);
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 权限闸门的 5 条放行路径都真的放行（score:read 赛段/全局、stage:compute 赛段/全局、本赛段评委）', async () => {
  const ctx = setup();
  insertCapability(ctx.db, 'score:read', '读取评分');
  insertCapability(ctx.db, 'stage:compute', '发榜');
  const users = {};
  const scopes = [
    ['u1', 'score:read', 'stage'],
    ['u2', 'score:read', 'global'],
    ['u3', 'stage:compute', 'stage'],
    ['u4', 'stage:compute', 'global'],
  ];
  let phone = 13800001000;
  for (const [name, capability, scopeType] of scopes) {
    const u = createUser(ctx.db, { name, phone: String(phone++), password: 'pw123' });
    grantAssignment(ctx.db, {
      userId: u.id, capability, scopeType, scopeId: scopeType === 'stage' ? ctx.stage.id : null, grantedBy: null,
    });
    users[name] = { id: u.id, token: createSession(ctx.db, u.id).token, desc: `${capability}@${scopeType}` };
  }

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const [name, u] of Object.entries(users)) {
      const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, u.token);
      await sse.ready;
      assert.equal(sse.status, 200, `${name}（${u.desc}）应被放行`);
      sse.close();
    }
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 端到端：评委提交评分 → 同赛段的 SSE 订阅者收到 review.progress（载荷不含评委身份）', async () => {
  const ctx = setup();
  // 评分需要：score:write 能力点 + 一支在本赛段名册内的队伍
  insertCapability(ctx.db, 'score:write', '写入评分');
  grantAssignment(ctx.db, {
    userId: ctx.judge.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: null,
  });
  const captain = createUser(ctx.db, { name: '队长', phone: '13800000903', password: 'pw123' });
  const team = insertTeam(ctx.db, {
    editionId: ctx.stage.edition_id, name: '一队', captainId: captain.id, status: 'active', now: NOW,
  });

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const post = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/reviews`,
        headers: { cookie: `hk_session=${ctx.tokenJudge}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => reject(new Error('提交超时')));
    req.end(payload);
  });

  try {
    // 先建立 SSE 连接，拿到首帧后再提交评分
    // ⚠️ 提交结果**不能**在 setTimeout 回调里断言：那里抛错 = unhandled rejection，
    //    既不会让用例失败、也不会让 promise settle → 用例挂起。改成把结果交给主流程断言。
    let settlePost;
    const posted = new Promise((resolve) => { settlePost = resolve; });
    const frames = await new Promise((resolve, reject) => {
      const chunks = [];
      // ⚠️ 墙钟定时器 + 「响应结束即失败」双保险：
      //    只靠 req.setTimeout 的话，错误响应一结束 socket 超时就被清掉 → 挂起。
      const guard = setTimeout(() => reject(new Error('SSE 未收到进度事件')), 5000);
      const done = (v) => { clearTimeout(guard); resolve(v); };
      const fail = (e) => { clearTimeout(guard); reject(e); };
      const req = http.get(
        {
          host: '127.0.0.1', port, path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}` },
        },
        (res) => {
          res.on('data', (c) => {
            chunks.push(c.toString());
            const text = chunks.join('');
            if (text.includes('event: review.progress')) done(text);
          });
          // 响应结束却没等到进度事件 → 失败（错误响应就是这种：403 / 404 的 JSON 体）
          res.on('end', () => fail(new Error(`SSE 响应已结束但未收到进度事件（status=${res.statusCode}）`)));
          res.on('error', fail);
        },
      );
      req.on('error', fail);
      // 连接建好后稍等一下再提交，确保订阅已登记
      setTimeout(() => {
        post({ items: [{ teamId: team.id, dimension: 'innovation', rawScore: 80 }] })
          .then(settlePost, (e) => fail(e));
      }, 150);
    });
    const r = await posted;
    assert.equal(r.status, 200, `评分提交失败：${r.body}`);
    assert.match(frames, /event: review\.progress/);
    assert.ok(!frames.includes('judgeId'), '载荷不得带评委身份（可见性由 API 层过滤）');
    // 载荷形状必须钉死：stageId 指向赛段、at 是时间戳字符串、**没有** judgeId
    const lines = frames.split('\n');
    const idx = lines.findIndex((l) => l === 'event: review.progress');
    assert.ok(idx >= 0, '未找到 review.progress 帧');
    const dataLine = lines[idx + 1];
    assert.ok(dataLine.startsWith('data: '), `帧格式不对：${dataLine}`);
    const payload = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(payload.stageId, ctx.stage.id);
    assert.equal(typeof payload.at, 'string');
    assert.ok(!('judgeId' in payload));
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 父代理变异检验追加的用例（2026-10-21）
//   —— 这些行为在实现里是对的，但**没有用例钉住** → 变异体会存活。
//      先补用例再跑变异，是「先跑后派」纪律的体现。
// ═══════════════════════════════════════════════════════════════════════════

test('parseSsePath 必须解码百分号编码的 stageId', () => {
  assert.deepEqual(parseSsePath('/api/stages/a%20b/events'), { stageId: 'a b' });
  assert.deepEqual(parseSsePath('/api/stages/%E5%8F%82%E8%B5%9B/events'), { stageId: '参赛' });
});

test('⛔ SSE 响应头必须带 X-Accel-Buffering: no（否则 nginx 缓冲 → 看起来「不推送」）', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  try {
    await sse.ready;
    assert.equal(sse.status, 200);
    assert.match(String(sse.headers['content-type']), /text\/event-stream/);
    assert.match(String(sse.headers['cache-control']), /no-cache/);
    assert.equal(sse.headers['x-accel-buffering'], 'no');
  } finally {
    sse.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 非 GET 方法不得开 SSE（方法闸门）→ 404', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/events`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}` },
        },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('超时')));
      req.end();
    });
    assert.equal(status, 404);
  } finally {
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 客户端断开后订阅者必须被摘掉（否则连接泄漏，进程内存单调增长）', async () => {
  const ctx = setup();
  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  try {
    await sse.ready;
    await sse.waitForEvent('connected');
    assert.ok(reviewEvents.size >= 1, '订阅后应登记到事件中心');
    sse.close();
    const ok = await waitUntil(() => reviewEvents.size === 0);
    assert.equal(ok, true, `断开后仍有 ${reviewEvents.size} 个订阅者未摘除`);
  } finally {
    sse.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 跨赛段串台：赛段 B 的订阅者不得收到赛段 A 的进度事件', async () => {
  const ctx = setup();
  // 第二个赛段：同一评委也在里面 → 对 B 也有订阅权限
  const stage2 = insertStage(ctx.db, {
    editionId: ctx.stage.edition_id, key: 's2', name: '复赛', kind: 'final',
    startsAt: '2026-10-11', endsAt: '2026-10-20', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(ctx.db, { stageId: stage2.id, userId: ctx.judge.id, seat: 'judge', now: NOW });
  insertCapability(ctx.db, 'score:write', '写入评分');
  grantAssignment(ctx.db, {
    userId: ctx.judge.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: null,
  });
  const captain = createUser(ctx.db, { name: '队长二', phone: '13800000904', password: 'pw123' });
  const team = insertTeam(ctx.db, {
    editionId: ctx.stage.edition_id, name: '二队', captainId: captain.id, status: 'active', now: NOW,
  });

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const a = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  const b = openSse(port, `/api/stages/${stage2.id}/events`, ctx.tokenJudge);
  try {
    await a.ready;
    await b.ready;
    await a.waitForEvent('connected');
    await b.waitForEvent('connected');
    const payload = JSON.stringify({ items: [{ teamId: team.id, dimension: 'innovation', rawScore: 80 }] });
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/reviews`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c.toString(); });
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('提交超时')));
      req.end(payload);
    });
    assert.equal(r.status, 200, `评分提交失败：${r.body}`);
    await a.waitForEvent('review.progress');
    await new Promise((x) => setTimeout(x, 300));
    assert.ok(
      !b.text().includes('event: review.progress'),
      '赛段 B 的订阅者不得收到赛段 A 的进度事件（跨赛段串台）',
    );
  } finally {
    a.close();
    b.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

test('⛔ 提交失败（分数越界）不得推送进度事件', async () => {
  const ctx = setup();
  insertCapability(ctx.db, 'score:write', '写入评分');
  grantAssignment(ctx.db, {
    userId: ctx.judge.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: null,
  });
  const captain = createUser(ctx.db, { name: '队长三', phone: '13800000905', password: 'pw123' });
  const team = insertTeam(ctx.db, {
    editionId: ctx.stage.edition_id, name: '三队', captainId: captain.id, status: 'active', now: NOW,
  });

  const server = http.createServer(ctx.app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sse = openSse(port, `/api/stages/${ctx.stage.id}/events`, ctx.tokenJudge);
  try {
    await sse.ready;
    await sse.waitForEvent('connected');
    const payload = JSON.stringify({ items: [{ teamId: team.id, dimension: 'innovation', rawScore: 150 }] });
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: `/api/stages/${ctx.stage.id}/reviews`,
          headers: { cookie: `hk_session=${ctx.tokenJudge}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c.toString(); });
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => reject(new Error('提交超时')));
      req.end(payload);
    });
    assert.equal(r.status, 400, `越界分数应被拒绝：${r.body}`);
    await new Promise((x) => setTimeout(x, 400));
    assert.ok(
      !sse.text().includes('event: review.progress'),
      '失败提交不得触发进度推送（事件只是「有进展」的信号，不该撒谎）',
    );
  } finally {
    sse.close();
    // ⛔ 必须先强制关掉所有连接再 close：SSE 是**长连接**，
    //    只 server.close() 的话 —— 活跃的 SSE 响应会一直占着 socket，
    //    测试进程**永不退出**（node --test 会一直等），CI 上直接挂死。
    server.closeAllConnections?.();
    server.close();
    cleanup(ctx);
  }
});

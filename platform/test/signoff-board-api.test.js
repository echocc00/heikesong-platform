// platform/test/signoff-board-api.test.js —— 企业签字台**两个真实读口**的 HTTP 闸
//
// ⚠️ **这个文件为什么必须存在（独立评审指出的测试盲区）**：
//   `src/services/signoff-board.js` 导出两个读口业务函数：
//     · `getSignoffWorklist`            → GET /api/signoffs/mine
//     · `getEnterpriseConfirmationBoard` → GET /api/stages/:stageId/enterprise-confirmations
//   全仓引用它们的**只有**两处：
//     ① `src/http/routes/signoff.js`（**真实路由**）
//     ② `web/api.demo.js`（**演示适配器 —— 另一份独立实现**）
//   而 `web/api.demo.js` 的那份实现（demoSignoffWorklist / demoEnterpriseConfirmationBoard）
//   **压根不做企业过滤**：它遍历 `state.teams` 全部队伍、返回 `scope:'committee'`，
//   确认记录也是 `state.enterpriseConfirmations` 全量 ⇒
//   **演示站测绿了也证明不了真实后端没坏**（两条实现的过滤口径根本不是一回事）。
//   ⇒ 真实 HTTP 路径（`createApp` + 真请求）此前**零覆盖** ⇒ 本文件补上。
//
// ⚠️ **断言的判别性纪律**（本文件的硬要求）：
//   · 只断言「非空」= 假绿 ⇒ 每条都断言**精确集合 / 精确条数 / 逐个 id**；
//   · 「实现退化成返回全部」与「实现退化成返回空」**都必须变红**；
//   · 每条用例都带**对照组**（该过的必须过）⇒ 不能靠「一律拒/一律空」骗绿；
//   · ⛔ **不许为了让用例通过而放宽断言** —— 用例红就是发现，改实现是别人的事。
//
// 规则溯源：
//   - 「企业席只看**自己出题**的队」（里程碑签字 = 客观事实确认，别的企业没资格替它确认）
//     → R-ENT-02 / R-PTS-02（见 src/services/signoff-board.js 的口径注释）
//   - 「签字不公开」（R-ENT-04）+ 「非本赛道签字把该队企业项权重归零」（R-JDG-06 R1）
//     ⇒ 企业席不得看到别家企业的确认记录
//   - 「三态状态码」：列表 200 + 空集 ｜ 单条 404（赛段不存在）｜ 禁用 403（没有能力点）
//     → 设计文档 §7.3
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
//    ⚠️ 必须在临时目录第一次被求值之前调用（temp-leak-scan 的 R1 / R2 闸）。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

/** 本文件用到的三个能力点（注册后才有资格被 grant）。 */
const CAPS = [
  ['signoff:create', '企业里程碑签字'],
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
];

/**
 * 真实 HTTP 调用（真服务器 + 真 fetch）。
 * ⚠️ 为什么不用 test-helpers/http-call.js 的进程内 call()：
 *    本文件要证明的是「**HTTP 路径**真的能读口」，进程内调用跳过 socket 与报文编解码；
 *    这里起真服务器，Cookie 走真实请求头 ⇒ 与真机链路一致。
 */
async function call(base, method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

/**
 * 夹具：两家公司、两个任务包、两支队、一个赛段、两条企业确认。
 *
 * ⚠️ **夹具按生产口径造**（F30/F31 修完后的口径）：
 *    `task_packages.enterprise_id` = 出题企业本人 ⇒ 「谁出的题」这件事在库里是**真的**，
 *    否则「只看到自己出题的队」这条根本触发不了（那是个无主卡 ⇒ 假绿）。
 *
 * ⚠️ 每个用例都拿到**全新的库**（每次调用新建 dataDir + 迁移）⇒ 用例之间零共享状态。
 */
async function withTwoEnterprises(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-signboard-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = new Date().toISOString();
  try {
    for (const [k, d] of CAPS) insertCapability(db, k, d);

    const entA = createUser(db, { name: '甲企业席', phone: '13900009001', password: 'pw', org: '甲公司', mbaStatus: 'other' });
    const entB = createUser(db, { name: '乙企业席', phone: '13900009002', password: 'pw', org: '乙公司', mbaStatus: 'other' });
    const capA = createUser(db, { name: '甲队长', phone: '13900009003', password: 'pw', mbaStatus: 'mba' });
    const capB = createUser(db, { name: '乙队长', phone: '13900009004', password: 'pw', mbaStatus: 'mba' });
    const judge = createUser(db, { name: '评委丙', phone: '13900009005', password: 'pw', mbaStatus: 'mba' });
    // 无任何能力点 ⇒ 两个读口都必须回 403
    const outsider = createUser(db, { name: '无关路人', phone: '13900009006', password: 'pw', mbaStatus: 'mba' });
    // 只有 score:write、没有 signoff:create ⇒ 企业双签清单必须回 403（不是放行）
    const scoreOnly = createUser(db, { name: '只有评分权', phone: '13900009007', password: 'pw', mbaStatus: 'mba' });
    // 只有 signoff:create、没有 score:write ⇒ 企业双签清单必须回 403（写端点是无条件校验的）
    const seatOnly = createUser(db, { name: '只有签字权', phone: '13900009008', password: 'pw', org: '丙公司', mbaStatus: 'other' });
    // 组委会：stage:compute ⇒ 全量视角（对照组：可见性过滤不是「谁都看不到」）
    const committee = createUser(db, { name: '组委会', phone: '13900009009', password: 'pw', mbaStatus: 'mba' });

    const grant = (userId, capability) => grantAssignment(db, {
      userId, capability, scopeType: 'global', scopeId: null, grantedBy: null,
    });
    for (const u of [entA, entB]) { grant(u.id, 'signoff:create'); grant(u.id, 'score:write'); }
    grant(judge.id, 'score:write');
    grant(scoreOnly.id, 'score:write');
    grant(seatOnly.id, 'signoff:create');
    grant(committee.id, 'stage:compute');
    grant(committee.id, 'score:write');

    // ── 届期 / 任务包（enterprise_id = 出题企业本人）──
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at)
             VALUES ('ed_1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    for (const [tp, ent, name] of [['tp_a', entA, '甲公司'], ['tp_b', entB, '乙公司']]) {
      db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,
                expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
               VALUES ('${tp}','ed_1','${ent.id}','${name}','${name}任务包','p','e','a',0,'${ent.id}','published','{}','${now}')`);
    }
    // ── 两支队（各属各的任务包）──
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at)
             VALUES ('team_a','ed_1','甲队','${capA.id}','tp_a','active','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at)
             VALUES ('team_b','ed_1','乙队','${capB.id}','tp_b','active','${now}')`);
    // ── 每队 2 个里程碑（条数刻意不等于 1 ⇒ 「返回空 / 返回全部」都判得出来）──
    for (const [ms, team, key, label] of [
      ['ms_a1', 'team_a', 'problem_confirmed', '企业问题确认'],
      ['ms_a2', 'team_a', 'pilot_signed', '试点合同已签'],
      ['ms_b1', 'team_b', 'problem_confirmed', '企业问题确认'],
      ['ms_b2', 'team_b', 'pilot_signed', '试点合同已签'],
    ]) {
      db.exec(`INSERT INTO milestones (id,team_id,key,label,counts_toward_tier,requires_signoff,fixed_at,created_at)
               VALUES ('${ms}','${team}','${key}','${label}',1,1,'${now}','${now}')`);
    }
    // ── 里程碑签字（客观事实）：甲签了自己的一条，乙签了自己的一条 ──
    db.exec(`INSERT INTO milestone_signoffs (id,milestone_id,enterprise_id,signatory_user_id,department,content,signed_at,revoked_at)
             VALUES ('so_a','ms_a1','${entA.id}','${entA.id}','业务部','甲企业确认问题已确认','${now}',NULL)`);
    db.exec(`INSERT INTO milestone_signoffs (id,milestone_id,enterprise_id,signatory_user_id,department,content,signed_at,revoked_at)
             VALUES ('so_b','ms_b1','${entB.id}','${entB.id}','业务部','乙企业确认问题已确认','${now}',NULL)`);
    // ── 赛段 + 评委席 ──
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,starts_at,ends_at,scoring_config_key,status)
             VALUES ('st_1','ed_1','s1','决赛','final','2026-01-01','2026-06-30','final','open')`);
    db.prepare(
      'INSERT INTO stage_judges (stage_id,user_id,seat,scope_type,scope_id,assigned_at) VALUES (?,?,?,?,?,?)',
    ).run('st_1', judge.id, 'judge', 'global', null, now);
    // ── 企业确认（主观评分，双签）：各企业各签各的队 ──
    db.exec(`INSERT INTO enterprise_confirmations (id,stage_id,team_id,enterprise_id,dimension,raw_score,
              cross_judge_id,signatory_user_id,content,created_at)
             VALUES ('ec_a','st_1','team_a','${entA.id}','enterprise',85,'${judge.id}','${entA.id}','甲企业双签确认内容','${now}')`);
    db.exec(`INSERT INTO enterprise_confirmations (id,stage_id,team_id,enterprise_id,dimension,raw_score,
              cross_judge_id,signatory_user_id,content,created_at)
             VALUES ('ec_b','st_1','team_b','${entB.id}','enterprise',60,'${judge.id}','${entB.id}','乙企业双签确认内容','${now}')`);

    await fn({
      base, db,
      entA, entB, capA, capB, judge, outsider, scoreOnly, seatOnly, committee,
      tokenEntA: createSession(db, entA.id).token,
      tokenEntB: createSession(db, entB.id).token,
      tokenOutsider: createSession(db, outsider.id).token,
      tokenScoreOnly: createSession(db, scoreOnly.id).token,
      tokenSeatOnly: createSession(db, seatOnly.id).token,
      tokenCommittee: createSession(db, committee.id).token,
    });
  } finally {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════
// 读口 ①：GET /api/signoffs/mine（企业席签字台）
// ══════════════════════════════════════════════════════════════════

test('签字台读口：企业席只读得到**自己出题**的队的里程碑（别家的读不到）', async () => {
  await withTwoEnterprises(async ({ base, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntA}` });
    assert.equal(r.status, 200, `企业席读自己的签字台必须 200：${r.text}`);
    assert.equal(r.json.scope, 'enterprise', `企业席看到的必须是企业视角，实际 ${r.json.scope}`);

    // 判别性①：**精确条数** —— 甲队 2 条里程碑。
    //   ⇒ 实现退化成「返回全部」（4 条）⇒ 红；退化成「返回空」（0 条）⇒ 红。
    assert.equal(
      r.json.items.length, 2,
      `甲企业只该看到自己出题的甲队的 2 条里程碑，实际 ${r.json.items.length} 条：${r.text}`,
    );
    // 判别性②：**逐个 id 点名** —— 不能靠「条数对了」蒙混（换了内容也算错）
    assert.deepEqual(
      r.json.items.map((i) => i.milestoneId).sort(),
      ['ms_a1', 'ms_a2'],
      `甲企业的清单里必须只有甲队的两个里程碑：${r.text}`,
    );
    assert.ok(
      r.json.items.every((i) => i.teamId === 'team_a'),
      `甲企业的清单里不得出现别家的队：${r.text}`,
    );
    // 判别性③：**按名字点名** —— 乙队的队名 / 乙队的里程碑 id 一个都不许出现
    assert.equal(r.text.includes('乙队'), false, '别家的队名不得出现在我的签字台里');
    assert.equal(r.text.includes('ms_b1'), false, '别家的里程碑不得出现在我的签字台里');
    assert.equal(r.text.includes('team_b'), false, '别家的队 id 不得出现在我的签字台里');

    // ── 对照组：乙企业看到的是**乙队**的（该过的必须过 ⇒ 不能靠「一律空」骗绿）──
    const rb = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntB}` });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(rb.json.scope, 'enterprise');
    assert.equal(
      rb.json.items.length, 2,
      `乙企业只该看到自己出题的乙队的 2 条里程碑，实际 ${rb.json.items.length} 条：${rb.text}`,
    );
    assert.deepEqual(
      rb.json.items.map((i) => i.milestoneId).sort(),
      ['ms_b1', 'ms_b2'],
      `乙企业的清单里必须只有乙队的两个里程碑：${rb.text}`,
    );
    assert.ok(rb.json.items.every((i) => i.teamId === 'team_b'), '乙企业的清单里不得出现甲队');
  });
});

test('签字台读口：已签状态与「是不是我签的」必须如实（签字人不公开）', async () => {
  await withTwoEnterprises(async ({ base, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntA}` });
    assert.equal(r.status, 200, r.text);
    const signed = r.json.items.find((i) => i.milestoneId === 'ms_a1');
    const unsigned = r.json.items.find((i) => i.milestoneId === 'ms_a2');
    assert.ok(signed, '清单里必须有 ms_a1');
    assert.ok(unsigned, '清单里必须有 ms_a2');
    assert.equal(signed.signed, true, '已签字的里程碑 signed 必须为 true');
    assert.equal(signed.signedByMe, true, '自己签的必须 signedByMe=true');
    assert.equal(signed.canWithdraw, true, '自己签的必须可以撤回');
    assert.equal(unsigned.signed, false, '没签的里程碑 signed 必须为 false');
    assert.equal(unsigned.signedByMe, false, '没签的 signedByMe 必须是 false');
    // R-ENT-04「签字不公开」：条目里**不得**出现签字人姓名 / id
    assert.equal(r.text.includes('甲企业席'), false, '签字人姓名不得出现在签字台里');
    assert.ok(
      !r.json.items.some((i) => Object.keys(i).some((k) => /signatory|signer|signerId/i.test(k))),
      '签字台条目里不得有「签字人」字段',
    );

    // 对照组：乙企业**看不到**甲的签字（甲那条不在乙的清单里）
    const rb = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntB}` });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(
      rb.json.items.some((i) => i.milestoneId === 'ms_a1'),
      false,
      '乙企业的清单里不得出现甲企业的里程碑',
    );
    const own = rb.json.items.find((i) => i.milestoneId === 'ms_b1');
    assert.equal(own.signed, true, '乙自己签的那条 signed 必须为 true');
    assert.equal(own.signedByMe, true, '乙自己签的那条 signedByMe 必须为 true');
  });
});

test('签字台读口：组委会是全量视角（对照组 —— 可见性过滤不是「谁都看不到」）', async () => {
  await withTwoEnterprises(async ({ base, tokenCommittee }) => {
    const r = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenCommittee}` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scope, 'committee', `组委会看到的必须是 committee 视角，实际 ${r.json.scope}`);
    assert.equal(
      r.json.items.length, 4,
      `组委会看得到两队共 4 条里程碑，实际 ${r.json.items.length} 条：${r.text}`,
    );
    assert.deepEqual(
      [...new Set(r.json.items.map((i) => i.teamId))].sort(),
      ['team_a', 'team_b'],
      `组委会的清单必须覆盖两支队：${r.text}`,
    );
  });
});

test('签字台读口：未登录 ⇒ 401（不是 500、不是空集）；无能力点 ⇒ 403', async () => {
  await withTwoEnterprises(async ({ base, tokenOutsider }) => {
    const anon = await call(base, 'GET', '/api/signoffs/mine');
    assert.equal(anon.status, 401, `未登录必须是 401，实际 ${anon.status}：${anon.text}`);
    assert.equal(anon.json?.error?.code, 'UNAUTHENTICATED', '未登录的错误码必须是 UNAUTHENTICATED');
    assert.notEqual(anon.status, 500, '未登录不得变成 500');

    const noPerm = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenOutsider}` });
    assert.equal(noPerm.status, 403, `没有能力点必须是 403，实际 ${noPerm.status}：${noPerm.text}`);
    assert.equal(noPerm.json?.error?.code, 'FORBIDDEN', '无能力点的错误码必须是 FORBIDDEN');
  });
});

// ══════════════════════════════════════════════════════════════════
// 读口 ②：GET /api/stages/:stageId/enterprise-confirmations（企业双签清单）
// ══════════════════════════════════════════════════════════════════

test('企业双签清单读口：企业席只读得到**本企业相关**的行（别家的行读不到）', async () => {
  await withTwoEnterprises(async ({ base, entA, entB, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenEntA}`,
    });
    assert.equal(r.status, 200, `企业席读双签清单必须 200：${r.text}`);
    assert.equal(r.json.scope, 'enterprise', `企业席看到的必须是企业视角，实际 ${r.json.scope}`);
    assert.equal(r.json.myEnterpriseId, entA.id, 'myEnterpriseId 必须是当前登录人自己');

    // 判别性①：**精确条数** —— 甲企业只有 1 条确认记录。
    //   ⇒ 退化成「返回全部」（2 条）⇒ 红；退化成「返回空」（0 条）⇒ 红。
    assert.equal(
      r.json.confirmations.length, 1,
      `甲企业只该看到自己那 1 条确认记录，实际 ${r.json.confirmations.length} 条：${r.text}`,
    );
    // 判别性②：逐个字段点名 —— enterpriseId / teamId 都必须是自己家的
    assert.equal(r.json.confirmations[0].enterpriseId, entA.id, '确认记录的 enterpriseId 必须是本企业');
    assert.equal(r.json.confirmations[0].teamId, 'team_a', '确认记录必须挂在自家出题的队上');
    // 判别性③：别家的确认记录一个都不许出现
    assert.equal(
      r.json.confirmations.some((c) => c.enterpriseId !== entA.id),
      false,
      `不得看到别家企业的确认记录：${r.text}`,
    );
    assert.equal(r.text.includes('乙企业双签确认内容'), false, '别家企业的确认内容不得泄露');
    // 判别性④：**名册**也必须过滤 —— 只列自家出题的队
    assert.deepEqual(
      r.json.teams.map((t) => t.teamId),
      ['team_a'],
      `名册里只该有自家出题的队：${r.text}`,
    );
    assert.equal(r.text.includes('乙队'), false, '别家的队名不得出现在双签清单里');

    // ── 对照组：乙企业看到的是**乙队 + 乙的确认**（该过的必须过）──
    const rb = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenEntB}`,
    });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(rb.json.scope, 'enterprise');
    assert.deepEqual(rb.json.teams.map((t) => t.teamId), ['team_b'], `乙企业的名册里只该有乙队：${rb.text}`);
    assert.equal(
      rb.json.confirmations.length, 1,
      `乙企业只该看到自己那 1 条确认记录，实际 ${rb.json.confirmations.length} 条：${rb.text}`,
    );
    assert.equal(rb.json.confirmations[0].teamId, 'team_b', '乙的确认记录必须挂在乙队上');
    assert.equal(rb.json.confirmations[0].enterpriseId, entB.id, '乙看到的确认记录必须属于乙企业');
    assert.equal(rb.json.myEnterpriseId, entB.id, '乙的 myEnterpriseId 必须是乙企业自己');
  });
});

test('企业双签清单读口：组委会是全量视角（对照组 —— 过滤不是「谁都看不到」）', async () => {
  await withTwoEnterprises(async ({ base, tokenCommittee }) => {
    const r = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenCommittee}`,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scope, 'committee', `组委会看到的必须是 committee 视角，实际 ${r.json.scope}`);
    assert.equal(r.json.teams.length, 2, `组委会的名册必须有两支队，实际 ${r.json.teams.length}：${r.text}`);
    assert.equal(
      r.json.confirmations.length, 2,
      `组委会必须看得到两家的确认记录，实际 ${r.json.confirmations.length}：${r.text}`,
    );
  });
});

test('企业双签清单读口：未登录 ⇒ 401；缺能力点 ⇒ 403；赛段不存在 ⇒ 404', async () => {
  await withTwoEnterprises(async ({ base, tokenOutsider, tokenScoreOnly, tokenSeatOnly }) => {
    // ① 未登录 ⇒ 401（不是 500、不是空集）
    const anon = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations');
    assert.equal(anon.status, 401, `未登录必须是 401，实际 ${anon.status}：${anon.text}`);
    assert.equal(anon.json?.error?.code, 'UNAUTHENTICATED', '未登录的错误码必须是 UNAUTHENTICATED');
    assert.notEqual(anon.status, 500, '未登录不得变成 500');

    // ② 一个能力点都没有 ⇒ 403（不是放行、不是空集）
    const noPerm = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenOutsider}`,
    });
    assert.equal(noPerm.status, 403, `没有能力点必须是 403，实际 ${noPerm.status}：${noPerm.text}`);
    assert.equal(noPerm.json?.error?.code, 'FORBIDDEN', '无能力点的错误码必须是 FORBIDDEN');

    // ③ 只有 score:write（没有 signoff:create）⇒ 403
    const scoreOnly = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenScoreOnly}`,
    });
    assert.equal(
      scoreOnly.status, 403,
      `没有 signoff:create 的人不得读企业双签清单，实际 ${scoreOnly.status}：${scoreOnly.text}`,
    );

    // ④ 只有 signoff:create（没有 score:write）⇒ 403
    //    ⚠️ 写端点 `POST /api/stages/:stageId/enterprise-confirmations` 里
    //    `requireStageCapability(ctx,'score:write')` 是**无条件**执行的 ⇒ 读端点必须同口径。
    const seatOnly = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenSeatOnly}`,
    });
    assert.equal(
      seatOnly.status, 403,
      `没有 score:write 的人不得读企业双签清单，实际 ${seatOnly.status}：${seatOnly.text}`,
    );
    assert.equal(seatOnly.json?.error?.code, 'FORBIDDEN', '缺 score:write 的错误码必须是 FORBIDDEN');

    // ⑤ 赛段不存在 ⇒ 404（单条语义）
    const missing = await call(base, 'GET', '/api/stages/st_nope/enterprise-confirmations', {
      cookie: `hk_session=${tokenOutsider}`,
    });
    assert.equal(missing.status, 404, `赛段不存在必须是 404，实际 ${missing.status}：${missing.text}`);
  });
});

test('企业双签清单读口：响应形状必须给前端够用的字段（维度 / 跨领域评委候选）', async () => {
  await withTwoEnterprises(async ({ base, tokenEntA }) => {
    const r = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenEntA}`,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stage.id, 'st_1', '必须回赛段摘要');
    // 企业确认维度从规则表来（不硬编码 'enterprise' 键）⇒ final 权重表里有这一维
    assert.deepEqual(
      r.json.dimensions.map((d) => d.key),
      ['enterprise'],
      `企业确认维度必须来自规则表：${r.text}`,
    );
    assert.equal(r.json.dimensions[0].seat, 'enterprise', '维度的席别必须是 enterprise');
    // 跨领域评委候选：排除「我」⇒ 自己不在候选里，但别的评委在
    assert.ok(Array.isArray(r.json.crossJudgeCandidates), '必须给跨领域评委候选数组');
    assert.ok(
      r.json.crossJudgeCandidates.length > 0,
      `跨领域评委候选不得为空（前端凑不齐 R2 双签就没法提交）：${r.text}`,
    );
    // 判别性：候选里**不得**含自己（后端会拒绝 crossJudgeId === 签字人）
    assert.equal(
      r.json.crossJudgeCandidates.some((c) => c.userId === r.json.myEnterpriseId),
      false,
      '跨领域评委候选里不得包含自己',
    );
  });
});

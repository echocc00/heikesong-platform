// platform/test/warning-wording.test.js —— 降级告警的「人话 / 内部明细」两层
//
// 规则溯源：
//   - S-5 / C-05「降级必须显式展示，不静默」⇒ 告警**一条都不许少**（本文件钉住数量）。
//   - 「可见性在 API 层裁决」（设计文档 §6.6 + src/domain/visibility.js 头注释）⇒
//     公开端点的内部明细由**后端**裁剪，前端不许自己判断权限。
//   - 文案分层（2026-10-23）：`message` 只给人读（禁止英文维度键 / 队伍 id /
//     评委 id / 内部原因码 / 浮点噪声），`detail` 是内部明细（只给 audit:read 的人看），
//     `code` 是**内部规则键**（2026-10-28 E184 起，**公开响应与公开界面都不许出现**）。
//
// ⚠️ **E184（2026-10-28）：本文件有三处断言被改写** —— 不是「改测试迁就实现」，
//    是**旧断言把错的契约钉成了规格**：
//    旧断言①「`html.includes('normalization_fallback')` 必须为 true」
//    旧断言②「`code` 必须保留在公开响应里」
//    旧断言③「`warn__code` 标签照常渲染」
//    ⇒ 三条都在说「内部规则键必须出现在公开页 / 公开响应里」⇒ 那是**缺陷本身**，不是规格。
//    ⇒ 新断言更强：不是「这几个码不许出现」，而是「**领域层产出的每一个码都不许出现**」
//      （清单从源码实时抽 ⇒ 新加的码自动进清单 ⇒ 漏一个就红）。
//
// ⚠️ 全部是**行为断言**：断言真实返回值（领域层输出 / HTTP 响应体 / 渲染出的 HTML），
//    不是「源码里有某个字符串」—— 那种断言会被无关代码顶替。
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyVisibility } from '../src/domain/visibility.js';
import { leaderboardHtml } from '../web/views/leaderboard.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-20T00:00:00.000Z';

// ══════════════════════════════════════════════════════════════════
// 一、领域层夹具（真实 rules/scoring-final.json —— 维度中文名取自 config.dimensions[].name）
// ══════════════════════════════════════════════════════════════════

/**
 * 真实外键口径的领域层夹具：
 *   - 评委 j1 在「技术可行性」上给两支队打分 ⇒ 样本数 2 < 5 ⇒ 触发归一化降级
 *   - t_a 的自评（54.8）比评委分（70）低 15.200000000000003 分 ⇒ 触发「评委须提问」
 *   - 其余维度没有分 ⇒ 触发 dimension_no_scores
 */
function scoreFixture() {
  const { rules } = loadRules(join(here, '..', 'rules'));
  const config = rules.scoring.final;
  const out = scoreStage({
    config,
    judges: [{ judgeId: 'j1', seat: 'judge' }],
    submissions: [
      { judgeId: 'j1', teamId: 't_a', dimension: 'feasibility', rawScore: 70 },
      { judgeId: 'j1', teamId: 't_b', dimension: 'feasibility', rawScore: 62 },
    ],
    enterpriseConfirmations: [],
    peerReviews: [],
    teams: [
      { teamId: 't_a', packageEnterpriseId: 'e_1', isFreeBrief: false },
      { teamId: 't_b', packageEnterpriseId: 'e_1', isFreeBrief: false },
    ],
    selfReviews: [{ teamId: 't_a', dimension: 'feasibility', rawScore: 54.8 }],
  });
  return { config, out };
}

test('★ normalization_fallback：正文只给人话（评委 id / 内部原因码 / 英文维度键都进 detail）', () => {
  const { out } = scoreFixture();
  const w = out.warnings.find((x) => x.code === 'normalization_fallback');
  assert.ok(w, `必须出现 normalization_fallback，实际：${JSON.stringify(out.warnings.map((x) => x.code))}`);
  // ⛔ 正文里不许出现评委 id
  assert.ok(!w.message.includes('j1'), `正文出现评委 id：${w.message}`);
  // ⛔ 正文里不许出现内部原因码
  assert.ok(!w.message.includes('judge_sample_too_small'), `正文出现内部原因码：${w.message}`);
  assert.ok(!w.message.includes(':'), `正文里不该出现「评委 id : 原因码」这种内部拼接：${w.message}`);
  // ⛔ 正文里不许出现原始维度键（作为裸词）
  assert.ok(!w.message.includes('feasibility'), `正文出现英文维度键：${w.message}`);
  // ✅ 正文用中文维度名
  assert.ok(w.message.includes('技术可行性'), `正文必须用中文维度名：${w.message}`);
  // ✅ 内部明细挪进 detail
  assert.ok(w.detail, 'detail 必须带内部明细');
  assert.ok(w.detail.includes('j1') && w.detail.includes('judge_sample_too_small'),
    `detail 必须带评委 id 与原因码：${w.detail}`);
  // ✅ code 保留（机器判据）
  assert.equal(w.code, 'normalization_fallback');
});

test('★ self_eval_judge_question：正文不得带浮点噪声（15.200000000000003 ⇒ 15.2）', () => {
  const { out } = scoreFixture();
  const w = out.warnings.find((x) => x.code === 'self_eval_judge_question');
  assert.ok(w, `必须出现 self_eval_judge_question，实际：${JSON.stringify(out.warnings.map((x) => x.code))}`);
  assert.ok(!w.message.includes('0000003'), `正文带浮点噪声：${w.message}`);
  assert.ok(!w.message.includes('15.200000000000003'), `正文带浮点噪声：${w.message}`);
  assert.ok(w.message.includes('15.2'), `正文必须带四舍五入后的分差：${w.message}`);
  assert.ok(!/15\.2\d{3,}/.test(w.message), `正文带浮点噪声：${w.message}`);
});

test('★ dimension_no_scores：正文不许出现队伍 id 与英文维度键（挪进 detail）', () => {
  const { out } = scoreFixture();
  const list = out.warnings.filter((x) => x.code === 'dimension_no_scores');
  assert.ok(list.length > 0, '必须出现 dimension_no_scores');
  for (const w of list) {
    assert.ok(!w.message.includes(w.teamId), `正文出现队伍 id：${w.message}`);
    assert.ok(!w.message.includes(w.dimension), `正文出现英文维度键：${w.message}`);
    assert.ok(w.detail && w.detail.includes(w.teamId) && w.detail.includes(w.dimension),
      `detail 必须带队伍 id 与维度键：${w.detail}`);
  }
});

test('★ detail 存在时不得出现在 message 里（两层不许互相污染）', () => {
  const { out } = scoreFixture();
  const withDetail = out.warnings.filter((w) => w.detail);
  assert.ok(withDetail.length > 0, '夹具必须产出带 detail 的告警');
  // 说明性单词不是内部标识，不参与判据
  const STOPWORDS = new Set(['id', 'dim']);
  for (const w of withDetail) {
    assert.ok(!w.message.includes(w.detail), `message 里混进了 detail：${w.message}`);
    // detail 里的 ASCII 标识符（队伍 id / 维度键 / 评委 id / 原因码）不得出现在正文
    const ids = String(w.detail).match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
    for (const id of ids) {
      if (STOPWORDS.has(id.toLowerCase())) continue;
      assert.ok(!w.message.includes(id), `message 里混进了 detail 的标识符「${id}」：${w.message}`);
    }
  }
});

test('★ 告警一条都没少：分层只改文案，不许把告警藏了（S-5 / C-05）', () => {
  const { out } = scoreFixture();
  const byCode = {};
  for (const w of out.warnings) byCode[w.code] = (byCode[w.code] ?? 0) + 1;
  assert.equal(out.warnings.length, 11, `告警总数变了：${JSON.stringify(byCode)}`);
  assert.equal(byCode.normalization_fallback, 1, '归一化降级告警必须仍在');
  assert.equal(byCode.self_eval_judge_question, 1, '自评差异告警必须仍在');
  assert.equal(byCode.dimension_no_scores, 7, '缺分维度告警必须仍在');
  assert.equal(byCode.no_enterprise_confirmation, 2, '企业确认告警必须仍在');
});

// ══════════════════════════════════════════════════════════════════
// 二、公开端点：内部明细的可见性在 API 层裁决
// ══════════════════════════════════════════════════════════════════

/** 快照里的告警（形状 = 现在的分层形状：code + message + detail + 原有字段） */
const SNAPSHOT_WARNINGS = [
  {
    code: 'normalization_fallback',
    message: '维度「技术可行性」的评委宽严归一化已降级 —— 本维度未按评委宽严做校正',
    detail: '降级明细（评委 id : 原因码）：j1:judge_sample_too_small',
    dimension: 'feasibility',
  },
  {
    code: 'dimension_no_scores',
    message: '有队伍在「自评测」维度上没有任何评分，该维度权重记 0',
    detail: '队伍 t_a / 维度 self_eval',
    teamId: 't_a',
    dimension: 'self_eval',
  },
  {
    code: 'R2_missing_dual_signature',
    message: '企业确认缺双签（出题企业签字 / 跨领域评委签字），该项按 0 分计',
    detail: '队伍 t_b',
    teamId: 't_b',
  },
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-warn-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_auditor','审计员','13800000010','x','mba',NULL,0,1,'${NOW}'),
           ('u_cap','A队队长','13800000011','x','mba',NULL,0,1,'${NOW}'),
           ('u_cap2','B队队长','13800000013','x','mba',NULL,0,1,'${NOW}'),
           ('u_out','外部访客','13800000012','x','other',NULL,0,1,'${NOW}');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','${NOW}');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at)
    VALUES ('tp_1','ed_1','e_1','某某公司','任务一','痛点一','交付物一','验收一','A','approved',10,'A','试点承诺','承诺书',0,'u_cap','${NOW}');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
    VALUES ('t_a','ed_1','A队','u_cap','tp_1','A','active','${NOW}'),
           ('t_b','ed_1','B队','u_cap2','tp_1','A','active','${NOW}');
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES ('tm_1','t_a','u_cap','captain','${NOW}'), ('tm_2','t_b','u_cap2','captain','${NOW}');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1','st_1','t_a',1,90,88,95,0,10,NULL,'${NOW}'),
           ('sr_2','st_1','t_b',2,80,80,0,0,8,NULL,'${NOW}');
  `);
  // 能力点与授权（SQL 在仓储层；授权走 can() 的唯一入口 grantAssignment）
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  grantAssignment(db, {
    userId: 'u_auditor', capability: 'audit:read', scopeType: 'global', scopeId: null, grantedBy: 'u_auditor',
  });
  // 计算快照：告警的来源（P2 写、P3 读）
  db.prepare(
    `INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version,
      input_json, output_json, trace_json, revision, created_at)
     VALUES ('cs_1','stage_score','ed_1','st_1',NULL,'scoring-final@2026-10-20','{}',?,'{}',1,?)`,
  ).run(JSON.stringify({ warnings: SNAPSHOT_WARNINGS }), NOW);

  const { rules } = loadRules(join(here, '..', 'rules'));
  const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
  return { db, close, dataDir, app };
}

const sessionToken = (db, userId) => createSession(db, userId, { ttlDays: 7, now: new Date(NOW) }).token;

test('★ 公开端点（滚动总榜 / 赛段榜）：匿名与普通用户拿不到 detail，有 audit:read 的人才拿得到', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    const paths = ['/api/leaderboard/rolling?editionId=ed_1', '/api/leaderboard/st_1?scope=rank'];

    for (const path of paths) {
      // ① 匿名访客
      const anon = await callJson(app, 'GET', path);
      assert.equal(anon.status, 200, `${path} 匿名访问应成功`);
      assert.equal(anon.json.warnings.length, SNAPSHOT_WARNINGS.length,
        `${path}：告警一条都不许少（数量不变）`);
      for (const w of anon.json.warnings) {
        assert.equal(w.detail, undefined, `${path}：匿名访客不得拿到 detail（${w.code}）`);
      }
      assert.ok(!anon.text.includes('judge_sample_too_small'),
        `${path}：响应体里不许出现内部原因码`);

      // ② 普通用户（没有 audit:read）
      const plain = await callJson(app, 'GET', path, { token: sessionToken(db, 'u_cap') });
      assert.equal(plain.status, 200, `${path} 普通用户访问应成功`);
      assert.equal(plain.json.warnings.length, SNAPSHOT_WARNINGS.length,
        `${path}：普通用户的告警数量不变`);
      for (const w of plain.json.warnings) {
        assert.equal(w.detail, undefined, `${path}：普通用户不得拿到 detail（${w.code}）`);
      }
      assert.ok(!plain.text.includes('judge_sample_too_small'),
        `${path}：响应体里不许出现内部原因码`);

      // ③ 有 audit:read 的人 ⇒ detail 完整可见
      const auditor = await callJson(app, 'GET', path, { token: sessionToken(db, 'u_auditor') });
      assert.equal(auditor.status, 200, `${path} 审计员访问应成功`);
      assert.equal(auditor.json.warnings.length, SNAPSHOT_WARNINGS.length,
        `${path}：审计员看到的告警数量不变`);
      for (const [i, w] of auditor.json.warnings.entries()) {
        assert.equal(w.detail, SNAPSHOT_WARNINGS[i].detail, `${path}：审计员必须拿到 detail`);
      }
      assert.ok(auditor.text.includes('judge_sample_too_small'),
        `${path}：审计员能看到内部原因码`);
    }
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 公开端点：人话正文一条不少、一条不改；内部规则键（code）一个都不许下发', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    const res = await callJson(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.warnings.map((w) => w.message),
      SNAPSHOT_WARNINGS.map((w) => w.message),
      '人话正文必须原样透出（一条不少、一条不改）',
    );
    // ⛔ **E184（2026-10-28）：公开响应里不许再下发 `code`** ——
    //    `code` 是**内部规则键**（normalization_fallback / R2_missing_dual_signature 这种），
    //    与 `detail` 同一类（内部工作语言）。
    //    ⚠️ E172 当初把 `code`「故意保留」的理由是「机器判据 / 审计靠它定位」，
    //    但那条理由**只对有 audit:read 的人成立** ⇒ 审计定位在审计页与留痕原文里就够。
    //    ⇒ 界面上不渲染的，就不该发到浏览器（「前端隐藏 = 数据已经发到浏览器」）。
    for (const w of res.json.warnings) {
      assert.equal(w.code, undefined, `公开响应里不得下发内部规则键（${w.code}）`);
    }
    assert.ok(!res.text.includes('normalization_fallback'), '响应体里不许出现内部规则键');
    // 内部标识字段对没权限的人也不下发（前端不渲染 ⇒ 不该发出去）
    for (const w of res.json.warnings) {
      assert.equal(w.teamId, undefined, '公开响应里不得下发队伍 id');
      assert.equal(w.dimension, undefined, '公开响应里不得下发英文维度键');
    }
    // 有权限的人拿得到全部内部信息（审计定位不受影响）
    const auditor = await callJson(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1', {
      token: sessionToken(db, 'u_auditor'),
    });
    assert.deepEqual(
      auditor.json.warnings.map((w) => w.code),
      SNAPSHOT_WARNINGS.map((w) => w.code),
      '审计员必须拿得到全部 code（审计定位靠它）',
    );
    assert.equal(auditor.json.warnings[1].teamId, 't_a', '审计员应拿到队伍 id');
    assert.equal(auditor.json.warnings[1].dimension, 'self_eval', '审计员应拿到维度键');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 三、前端渲染：code 降级成小号标签，detail 单独成行
// ══════════════════════════════════════════════════════════════════

test('★ 前端渲染：内部规则键（code）完全不渲染，detail 单独成行', () => {
  const html = leaderboardHtml({
    scope: 'rolling',
    warnings: [{
      code: 'normalization_fallback',
      message: '维度「技术可行性」的评委宽严归一化已降级 —— 本维度未按评委宽严做校正',
      detail: '降级明细（评委 id : 原因码）：j1:judge_sample_too_small',
      stageName: '决赛路演',
    }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  // ⛔ code 不得再当正文前缀
  assert.ok(!html.includes('[normalization_fallback]'), 'code 不得再以 [code] 形式出现在正文');
  // ⛔ **E184：code 一点都不许渲染** —— 上一版把它降级成「小号等宽标签」
  //    （`warn__code`）跟在正文后面，理由是「机器判据不能丢」，
  //    但**标签仍然是可见文本** ⇒ 匿名访客照样看得见 `normalization_fallback`。
  assert.ok(!html.includes('warn__code'), '内部规则键不许渲染成任何标签');
  assert.ok(!html.includes('normalization_fallback'), '内部规则键不许出现在页面上');
  // ✅ detail 单独成行
  assert.ok(html.includes('warn__detail'), 'detail 必须单独成行');
  assert.ok(/<div class="warn__detail">[^<]+<\/div>/.test(html), 'detail 必须是独立的块级行');
  assert.ok(html.includes('judge_sample_too_small'), 'detail 的内容必须真的渲染出来');
  // ⚠️ 位置硬契约：告警仍然置顶（字符索引 < 队名的字符索引）
  assert.ok(html.indexOf('降级明细') < html.indexOf('A队'), '告警必须仍然排在榜单之前（置顶）');
});

test('★ 前端渲染：没有 detail 时不渲染明细行（后端裁剪掉的就是不显示）', () => {
  const html = leaderboardHtml({
    scope: 'rank',
    warnings: [{ code: 'R2_missing_dual_signature', message: '企业确认缺双签，该项按 0 分计' }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  assert.ok(!html.includes('warn__detail'), '没有 detail 时不许留空的明细行');
  assert.ok(!html.includes('R2_missing_dual_signature'), '内部规则键不许渲染');
  assert.ok(html.includes('企业确认缺双签'), '人话正文照常渲染');
});

// ══════════════════════════════════════════════════════════════════
// 四、领域层唯一入口：告警内部明细的裁剪收进 applyVisibility
//    ⇒ 演示站与正式站共用同一份口径（以前两处各写一份 ⇒ 演示站泄给了匿名访客）
// ══════════════════════════════════════════════════════════════════

const VIS_PAYLOAD = {
  scope: 'rank',
  rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  warnings: SNAPSHOT_WARNINGS,
};
const VIS_CFG = { rank: { showEnterpriseName: false } };

test('★ 领域层唯一入口 applyVisibility：没有 audit:read ⇒ 裁掉内部明细，但告警一条不少', () => {
  const out = applyVisibility({
    payload: VIS_PAYLOAD,
    viewer: null,
    visibilityConfig: VIS_CFG,
    context: { scope: 'rank' },
  });
  assert.equal(out.warnings.length, SNAPSHOT_WARNINGS.length, '告警一条都不许少（S-5 / C-05）');
  for (const w of out.warnings) {
    assert.equal(w.detail, undefined, `detail 必须被裁掉（${w.code}）`);
    assert.equal(w.teamId, undefined, `队伍 id 必须被裁掉（${w.code}）`);
    assert.equal(w.teamIds, undefined, `队伍 id 列表必须被裁掉（${w.code}）`);
    assert.equal(w.dimension, undefined, `英文维度键必须被裁掉（${w.code}）`);
    // ⛔ **E184**：内部规则键（code）也必须被裁掉（它是内部工作语言，不是公开信息）
    assert.equal(w.code, undefined, `内部规则键必须被裁掉（${w.code}）`);
    assert.ok(w.message, 'message 必须保留（人话正文）');
  }
  const dumped = JSON.stringify(out.warnings);
  assert.ok(!dumped.includes('judge_sample_too_small'), '告警里不许出现内部原因码');
  assert.ok(!dumped.includes('t_a'), '告警里不许出现队伍 id');
  assert.ok(!dumped.includes('normalization_fallback'), '告警里不许出现内部规则键');
});

test('★ 领域层唯一入口 applyVisibility：canAudit ⇒ 内部明细与内部规则键完整可见', () => {
  const out = applyVisibility({
    payload: VIS_PAYLOAD,
    viewer: { id: 'u_auditor' },
    visibilityConfig: VIS_CFG,
    context: { scope: 'rank', canAudit: true },
  });
  assert.equal(out.warnings.length, SNAPSHOT_WARNINGS.length, '告警数量不变');
  for (const [i, w] of out.warnings.entries()) {
    assert.equal(w.detail, SNAPSHOT_WARNINGS[i].detail, '审计员必须拿到 detail');
    assert.equal(w.code, SNAPSHOT_WARNINGS[i].code, '审计员必须拿到 code（审计定位靠它）');
  }
  assert.equal(out.warnings[1].teamId, 't_a', '审计员必须拿到队伍 id');
  assert.equal(out.warnings[1].dimension, 'self_eval', '审计员必须拿到英文维度键');
});

/** 演示站的内存版 localStorage（与浏览器同形状） */
function makeMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('★ 演示站与正式站同口径：匿名访客拿不到 detail，演示管理员拿得到', async () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeMemoryStorage(), seed, rules });

  // 跑一次真实引擎的计算 ⇒ 产出告警（与构建期预计算同一条路径）
  await api.post('/api/auth/login', { name: '演示管理员' });
  await api.post('/api/stages/stage_final/compute', {});

  const admin = await api.get('/api/leaderboard/rolling');
  assert.ok(Array.isArray(admin.warnings) && admin.warnings.length > 0, '演示站必须有告警（否则这条闸是假绿）');
  assert.ok(admin.warnings.some((w) => w.detail), '演示管理员（audit:read）必须拿到 detail');

  // 退出登录 ⇒ 匿名访客看同一个公开端点
  await api.post('/api/auth/logout', {});
  const anon = await api.get('/api/leaderboard/rolling');
  assert.equal(anon.warnings.length, admin.warnings.length, '匿名访客看到的告警一条都不许少');
  for (const w of anon.warnings) {
    assert.equal(w.detail, undefined, `匿名访客不得拿到 detail（${w.code}）`);
    assert.equal(w.teamId, undefined, `匿名访客不得拿到队伍 id（${w.code}）`);
    assert.equal(w.dimension, undefined, `匿名访客不得拿到英文维度键（${w.code}）`);
    // ⛔ **E184**：内部规则键也不许下发（演示站与正式站**同一把尺**）
    assert.equal(w.code, undefined, `匿名访客不得拿到内部规则键（${w.code}）`);
    assert.ok(w.message, '人话正文必须保留');
  }
  const dumped = JSON.stringify(anon.warnings);
  // ⚠️ `detail`（评委 id + 内部原因码 / 队伍 id / 英文维度键 / 内部破同分键名）
  //    与 `code`（内部规则键）**都不许**出现在匿名访客的响应里（E184）。
  for (const marker of ['judge_sample_too_small', 'partial:', '/ 维度 ', 'tiebreak_extra', 't_alpha',
    'normalization_fallback', 'R2_missing_dual_signature']) {
    assert.ok(!dumped.includes(marker), `匿名访客不得看到内部标识「${marker}」`);
  }
});

// platform/test/review-service.test.js —— 评审提交类用例
//
// 依据：P2 计划 Task 6「评分提交服务 + 幂等 + 增量 score_stats」
// 溯源需求：R-JDG-09（回避留档）｜R-JDG-11（观察员无投票权）｜R-JDG-12（校准不计入评分）
//          ｜R-JDG-13（自评）｜R-JDG-18（利益冲突声明）｜R-RNK-07（互评资格）
//
// ⚠️ **夹具必须建真实数据**（父代理预审修正，Important）：
//    Task 1 补齐了引用型外键（`judge_id → users`、`team_id → teams`、`stage_id → stages`），
//    原规格用的假 id（'j1' / 't1' / 'ed1'）**必然触发外键失败** —— 那只在「没有外键」时成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { claimRequestKey } from '../src/db/repo/request-keys.js';
import {
  submitReviews,
  getReviewState,
  submitCalibration,
  submitPeerReviews,
  submitSelfReviews,
  submitEnterpriseConfirmation,
  declareRecusal,
} from '../src/services/review.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const NOW = '2026-10-20T10:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rev-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  // 真实届期 / 用户 / 战队 / 赛段 —— 外键要指向真实存在的行
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900000011', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000012', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000013', password: 'pw' });
  const captain2 = createUser(db, { name: '队长乙', phone: '13900000015', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000014', password: 'pw' });

  const teamA = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: captain.id, status: 'forming', now: NOW,
  });
  const teamB = insertTeam(db, {
    editionId: edition.id, name: '乙队', captainId: captain2.id, status: 'forming', now: NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  const stage2 = insertStage(db, {
    editionId: edition.id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-10-26', endsAt: '2026-10-28', scoringConfigKey: 'final', status: 'open', now: NOW,
  });

  // 分配评委 = 签署利益冲突声明（R-JDG-18 接线）
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });

  return { db, close, dataDir, edition, judge, observer, captain, captain2, admin, teamA, teamB, stage, stage2 };
}

function cleanup({ db, close, dataDir }) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

test('提交评分：写入 stage_reviews 并增量更新 score_stats', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  const res = submitReviews({
    db,
    stageId: stage.id,
    judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamB.id, dimension: 'innovation', rawScore: 60 },
    ],
    requestId: 'req-1',
    now: NOW,
  });
  assert.equal(res.submitted, 2);

  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 2);
  assert.ok(Math.abs(stat.mean - 70) < 1e-12);
  assert.ok(Math.abs(stat.sum_sq - (6400 + 3600)) < 1e-9);

  cleanup(ctx);
});

test('幂等：同一 requestId 重复提交只生效一次', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  const items = [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }];
  submitReviews({ db, stageId: stage.id, judgeId: judge.id, items, requestId: 'req-1', now: NOW });
  const second = submitReviews({ db, stageId: stage.id, judgeId: judge.id, items, requestId: 'req-1', now: NOW });
  assert.equal(second.submitted, 0, '重复提交不产生新记录');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_reviews').get().n, 1);
  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 1, 'score_stats 不得被重复累加');
  cleanup(ctx);
});

test('观察员无投票权 → 403', () => {
  const ctx = setup();
  const { db, observer, teamA, stage } = ctx;
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: observer.id,
      items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-o', now: NOW,
    }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

test('改分：同一 (评委,队伍,维度) 覆盖写，score_stats 同步修正', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-a', now: NOW,
  });
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 90 }],
    requestId: 'req-b', now: NOW,
  });
  const stat = db.prepare('SELECT * FROM score_stats WHERE judge_id = ? AND dimension = ?').get(judge.id, 'innovation');
  assert.equal(stat.n, 1);
  assert.ok(Math.abs(stat.mean - 90) < 1e-12);
  assert.ok(Math.abs(stat.sum_sq - 8100) < 1e-9);
  cleanup(ctx);
});

test('校准打分写入 calibrations，不进 stage_reviews（不计入评分）', () => {
  const ctx = setup();
  const { db, judge, stage } = ctx;
  submitCalibration({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ dimension: 'innovation', rawScore: 50 }], now: NOW,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calibrations').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_reviews').get().n, 0);
  cleanup(ctx);
});

test('进度查询：返回已交/应交/缺谁/维度进度', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-1', now: NOW,
  });
  const state = getReviewState({ db, stageId: stage.id, viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.submitted, 1);
  assert.ok(state.total >= 1);
  assert.ok(Array.isArray(state.missing));
  assert.ok('innovation' in state.dimensionProgress);
  assert.equal(state.dimensionProgress.innovation.submitted, 1);
  cleanup(ctx);
});

test('互评：一队对另一队只投一次；重复 requestId 幂等', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  // 两队都已有真实交付物（评委已对其打分）→ 才有互评资格（R-RNK-07）
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamB.id, dimension: 'innovation', rawScore: 70 },
    ],
    requestId: 'r-1', now: NOW,
  });
  const items = [{ fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 }];
  const first = submitPeerReviews({ db, stageId: stage.id, items, requestId: 'p-1', now: NOW });
  assert.equal(first.submitted, 1);
  const second = submitPeerReviews({ db, stageId: stage.id, items, requestId: 'p-1', now: NOW });
  assert.equal(second.submitted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_reviews').get().n, 1);
  cleanup(ctx);
});

test('无真实交付物的队伍不能参与互评（R-RNK-07）', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'r-1', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: stage.id, items: [{ fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 }], requestId: 'p-2', now: NOW,
    }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

test('自评测提交并幂等', () => {
  const ctx = setup();
  const { db, teamA, stage } = ctx;
  const items = [{ dimension: 'innovation', rawScore: 85 }];
  submitSelfReviews({ db, stageId: stage.id, teamId: teamA.id, items, requestId: 's-1', now: NOW });
  const again = submitSelfReviews({ db, stageId: stage.id, teamId: teamA.id, items, requestId: 's-1', now: NOW });
  assert.equal(again.submitted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_reviews').get().n, 1);
  cleanup(ctx);
});

test('回避：留档后该评委不能再评该队', () => {
  const ctx = setup();
  const { db, judge, teamA, stage, admin } = ctx;
  declareRecusal({ db, stageId: stage.id, judgeId: judge.id, teamId: teamA.id, reason: '前雇主', actorId: admin.id, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recusal_records').get().n, 1);
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: judge.id,
      items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-r', now: NOW,
    }),
    (err) => err.status === 403,
  );
  cleanup(ctx);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('R-JDG-18 接线：分配评委即签署利益冲突声明', () => {
  // ⚠️ 原规格把 `conflict_declarations` 建好了、两列也留了，
  //    却**没有任何代码写入** → 「评委须签署声明」在产品上静默失效，CI 全绿。
  const ctx = setup();
  const { db, judge, stage } = ctx;
  const decls = db.prepare('SELECT * FROM conflict_declarations WHERE stage_id = ? AND judge_id = ?')
    .all(stage.id, judge.id);
  assert.equal(decls.length, 1, '分配评委后声明表必须多一行');
  assert.equal(decls[0].has_conflict, 0);
  assert.ok(decls[0].statement.length > 0, '声明正文不能为空');
  const seat = db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?')
    .get(stage.id, judge.id);
  assert.equal(seat.conflict_declared_at, NOW, '签署时间必须回填');
  assert.equal(seat.conflict_declaration_id, decls[0].id, '声明 id 必须回填');
  cleanup(ctx);
});

test('写数据失败时幂等键不得残留（否则重试会被静默吞掉）', () => {
  // ⚠️ 原实现：先抢键再写数据。写数据失败（403）时**键已经占住** →
  //    客户端用同一个 requestId 重试会被判成「重复请求」，
  //    返回 submitted: 0 —— **评委以为提交成功了，实际一条都没落库**。
  const ctx = setup();
  const { db, judge, teamA, teamB, stage, admin } = ctx;
  declareRecusal({ db, stageId: stage.id, judgeId: judge.id, teamId: teamA.id, reason: '前雇主', actorId: admin.id, now: NOW });
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: judge.id,
      items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-x', now: NOW,
    }),
    (err) => err.status === 403,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM review_request_keys').get().n,
    0,
    '失败的事务不得留下幂等键',
  );
  // 换个没被回避的队，用**同一个** requestId 重试 → 必须真写进去
  const retry = submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamB.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-x', now: NOW,
  });
  assert.equal(retry.submitted, 1, '重试必须真的写入，不能被幂等短路吞掉');
  cleanup(ctx);
});

test('同一个 requestId 用于不同内容 → 409（响亮报错，不静默继续写）', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-dup', now: NOW,
  });
  assert.throws(
    () => submitReviews({
      db, stageId: stage.id, judgeId: judge.id,
      items: [{ teamId: teamB.id, dimension: 'innovation', rawScore: 80 }],
      requestId: 'req-dup', now: NOW,
    }),
    (err) => err.status === 409,
  );
  cleanup(ctx);
});

test('互评：同一个 requestId 用于不同内容 → 409（幂等键主体不能从 items 推导）', () => {
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamB.id, dimension: 'innovation', rawScore: 70 },
    ],
    requestId: 'r-1', now: NOW,
  });
  submitPeerReviews({
    db, stageId: stage.id,
    items: [{ fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 }],
    requestId: 'p-dup', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: stage.id,
      items: [
        { fromTeamId: teamA.id, toTeamId: teamB.id, score: 70 },
        { fromTeamId: teamB.id, toTeamId: teamA.id, score: 60 },
      ],
      requestId: 'p-dup', now: NOW,
    }),
    (err) => err.status === 409,
  );
  cleanup(ctx);
});

test('分数越界 → 400（绝不让 1000 分污染 score_stats 与归一化）', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  for (const bad of [1000, -1, NaN, Infinity]) {
    assert.throws(
      () => submitReviews({
        db, stageId: stage.id, judgeId: judge.id,
        items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: bad }],
        requestId: `req-bad-${String(bad)}`, now: NOW,
      }),
      (err) => err.status === 400,
      `rawScore=${String(bad)} 必须被拒`,
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM score_stats').get().n, 0);
  cleanup(ctx);
});

test('评分进度按赛段真实名册算（完全没人打分的队也必须计入）', () => {
  // ⚠️ 原实现把「已有打分记录里出现过的队伍」当成「应交队伍」——
  //    某个队完全没人打分时它根本不在名单里 → 进度显示 100% 而实际有队没被评。
  const ctx = setup();
  const { db, judge, teamA, teamB, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-1', now: NOW,
  });
  const state = getReviewState({ db, stageId: stage.id, viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.total, 2, '两个队都应交 —— 乙队完全没人打分也算');
  assert.equal(state.submitted, 1);
  assert.equal(state.missing.length, 1);
  assert.equal(state.missing[0].teamId, teamB.id);
  cleanup(ctx);
});

test('赛段不存在 → 404（不把外键原文漏给调用方）', () => {
  const ctx = setup();
  const { db, judge } = ctx;
  assert.throws(
    () => submitReviews({
      db, stageId: 'no-such-stage', judgeId: judge.id,
      items: [], requestId: 'req-none', now: NOW,
    }),
    (err) => err.status === 404,
  );
  cleanup(ctx);
});

test('企业确认：空白签字内容 → 400（R-JDG-14）', () => {
  const ctx = setup();
  const { db, teamA, stage } = ctx;
  assert.throws(
    () => submitEnterpriseConfirmation({
      db, stageId: stage.id, teamId: teamA.id, enterpriseId: 'E1',
      dimension: 'enterprise', rawScore: 80, content: '   ', now: NOW,
    }),
    (err) => err.status === 400,
  );
  cleanup(ctx);
});

test('每次提交都留下审计日志', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'req-audit', now: NOW,
  });
  const rows = db.prepare('SELECT * FROM audit_log WHERE action = ?').all('review.submit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, 'stage');
  assert.equal(rows[0].entity_id, stage.id);
  cleanup(ctx);
});

test('幂等键的 UNIQUE 兜底只认「唯一约束」，其它约束错必须继续往上抛', () => {
  // ⚠️ 兜底正则若放宽成 /UNIQUE|constraint/i，「外键失败」会被**误判成重复请求**
  //    → 静默吞掉（返回 submitted: 0），评委以为提交成功了。
  //    P1 的 T-7 已经踩过一次同样的坑（registrations 的兜底正则被收紧）。
  const ctx = setup();
  const { db } = ctx;
  assert.throws(
    () => claimRequestKey(db, {
      scope: 'review', stageId: 'no-such-stage', subjectId: 'x', requestId: 'r', now: NOW,
    }),
    /FOREIGN KEY/i,
    '外键失败不得被当成「重复请求」',
  );
  cleanup(ctx);
});

test('进度：应交总数 = 队伍数 × 维度数（不能漏乘维度）', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [
      { teamId: teamA.id, dimension: 'innovation', rawScore: 80 },
      { teamId: teamA.id, dimension: 'feasibility', rawScore: 70 },
    ],
    requestId: 'req-2d', now: NOW,
  });
  const state = getReviewState({ db, stageId: stage.id, viewer: { userId: judge.id, seat: 'judge' } });
  assert.equal(state.total, 4, '2 队 × 2 维度 = 4');
  assert.equal(state.submitted, 2);
  cleanup(ctx);
});

test('不能给自己互评 → 400', () => {
  const ctx = setup();
  const { db, judge, teamA, stage } = ctx;
  submitReviews({
    db, stageId: stage.id, judgeId: judge.id,
    items: [{ teamId: teamA.id, dimension: 'innovation', rawScore: 80 }],
    requestId: 'r-1', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db, stageId: stage.id,
      items: [{ fromTeamId: teamA.id, toTeamId: teamA.id, score: 70 }],
      requestId: 'p-self', now: NOW,
    }),
    (err) => err.status === 400,
  );
  cleanup(ctx);
});

// ── 写入口的队伍边界（父代理预审 I1 / I5 / D-33）─────────────────────────

test('服务层：给名册外的队伍打分 → 404（不是外键报错 500）', () => {
  const ctx = setup();
  const otherEdition = createEdition(ctx.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(ctx.db, {
    editionId: otherEdition.id, name: '外队', captainId: ctx.admin.id, status: 'active', now: NOW,
  });
  assert.throws(
    () => submitReviews({
      db: ctx.db, stageId: ctx.stage.id, judgeId: ctx.judge.id,
      items: [{ teamId: outsider.id, dimension: 'innovation', rawScore: 99 }], now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_IN_STAGE',
  );
  cleanup(ctx);
});

test('服务层：企业确认名册外的队伍 → 404', () => {
  const ctx = setup();
  const otherEdition = createEdition(ctx.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(ctx.db, {
    editionId: otherEdition.id, name: '外队', captainId: ctx.admin.id, status: 'active', now: NOW,
  });
  assert.throws(
    () => submitEnterpriseConfirmation({
      db: ctx.db, stageId: ctx.stage.id, teamId: outsider.id, enterpriseId: ctx.admin.id,
      dimension: 'enterprise', rawScore: 90, crossJudgeId: ctx.judge.id,
      signatoryUserId: ctx.admin.id, content: '外队确认', now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_IN_STAGE',
  );
  cleanup(ctx);
});

test('服务层：互评的被评队不在名册内 → 404', () => {
  const ctx = setup();
  const otherEdition = createEdition(ctx.db, {
    name: '第二届', city: '杭州', startsAt: '2027-01-01', endsAt: '2027-02-28', now: NOW,
  });
  const outsider = insertTeam(ctx.db, {
    editionId: otherEdition.id, name: '外队', captainId: ctx.admin.id, status: 'active', now: NOW,
  });
  assert.throws(
    () => submitPeerReviews({
      db: ctx.db, stageId: ctx.stage.id,
      items: [{ fromTeamId: ctx.teamA.id, toTeamId: outsider.id, score: 80 }], now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_IN_STAGE',
  );
  cleanup(ctx);
});

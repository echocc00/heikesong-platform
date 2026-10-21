import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { stagePointsFor, computeStagePoints, computeMvp, computePersonalPoints, computePrizeShares } from '../src/domain/points.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const P = rules.points;

test('★ 回归测试：名次积分必须写死 10/8/5', () => {
  // ⚠️ 上游 HackSC/hibiscus `calculatePoints.ts`（MIT）的 switch 没有 break，
  //    穿透后实际发的是 18/8/3/1（上游自己写的目标值是 10/5/2/1）。
  //    相对顺序不变，但数值全错——不写死这个断言，bug 会被一起搬进来。
  //    我们的口径来自 任务书 §七 + R-STG-02：第一/二/三名 = 10/8/5。
  assert.equal(stagePointsFor(1, P), 10);
  assert.equal(stagePointsFor(2, P), 8);
  assert.equal(stagePointsFor(3, P), 5);
  assert.equal(stagePointsFor(4, P), 0);
  assert.equal(stagePointsFor(0, P), 0);
  assert.equal(stagePointsFor(-1, P), 0);
  assert.equal(stagePointsFor(99, P), 0);
  assert.notEqual(stagePointsFor(1, P), 18);   // 上游 bug 的具体形态
  assert.notEqual(stagePointsFor(2, P), 5);
  assert.notEqual(stagePointsFor(3, P), 2);
  // 配置缺 stagePoints 段 → 0 分，**不静默套用默认表**
  // （启动期 config 校验会 fail-fast，这里只是不让「默认值」悄悄兜底）
  assert.equal(stagePointsFor(1, {}), 0);
  assert.equal(stagePointsFor(1, undefined), 0);
});

test('只给前 3 名计分（stagePointsOnlyTopN = 3）', () => {
  const pts = computeStagePoints({
    ordered: [{ teamId: 't1', rank: 1 }, { teamId: 't2', rank: 2 }, { teamId: 't3', rank: 3 }, { teamId: 't4', rank: 4 }],
    pointsConfig: P,
  });
  assert.deepEqual(pts.map((p) => p.points), [10, 8, 5, 0]);
  assert.deepEqual(pts.map((p) => p.position), [1, 2, 3, 4]);
});

test('★ 并列时按位置分配积分（1224 名次下的确定性口径）', () => {
  // 名次是 1,1,3（并列第一占了两席），但积分按位置发放，总额恒为 10+8+5=23。
  const pts = computeStagePoints({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 1 }, { teamId: 't_c', rank: 3 }],
    pointsConfig: P,
  });
  assert.deepEqual(pts.map((p) => p.points), [10, 8, 5]);
  assert.equal(pts.reduce((s, p) => s + p.points, 0), 23);
});

test('computeMvp：4 赛段总积分 + S4 路演评审综合，每任务包 1 个', () => {
  const stagePoints = [
    { teamId: 't_a', stageId: 'S1', points: 10 }, { teamId: 't_a', stageId: 'S2', points: 8 },
    { teamId: 't_a', stageId: 'S3', points: 5 }, { teamId: 't_a', stageId: 'S4', points: 8 },
    { teamId: 't_b', stageId: 'S1', points: 5 }, { teamId: 't_b', stageId: 'S2', points: 10 },
    { teamId: 't_b', stageId: 'S3', points: 0 }, { teamId: 't_b', stageId: 'S4', points: 10 },
  ];
  const out = computeMvp({
    stagePoints, roadshowScores: [{ teamId: 't_a', score: 70 }, { teamId: 't_b', score: 90 }],
    packageId: 'tp_1', pointsConfig: P,
  });
  assert.equal(out.packageId, 'tp_1');
  assert.equal(out.mvpList.length, 1, '每个任务包 1 个 MVP');
  // t_a 赛段积分 31 + 路演第 2 名积分 8（roadshowWeight=1）= 39；t_b 25 + 10 = 35
  assert.equal(out.mvp.teamId, 't_a');
  assert.equal(out.mvp.stageTotal, 31);
  assert.equal(out.mvp.roadshowContribution, 8);
  assert.equal(out.mvp.score, 39);
  assert.equal(out.ranked[1].teamId, 't_b');
  assert.equal(out.ranked[1].score, 35);
});

test('computeMvp：同分时结果确定且可复算（队伍编号兜底）；只取前 4 个赛段', () => {
  const stagePoints = [{ teamId: 't_z', stageId: 'S1', points: 10 }, { teamId: 't_a', stageId: 'S1', points: 10 }];
  const roadshowScores = [{ teamId: 't_z', score: 50 }, { teamId: 't_a', score: 50 }];
  const a = computeMvp({ stagePoints, roadshowScores, packageId: 'tp_1', pointsConfig: P });
  const b = computeMvp({ stagePoints, roadshowScores, packageId: 'tp_1', pointsConfig: P });
  assert.equal(a.mvp.teamId, 't_a');
  assert.equal(a.mvp.teamId, b.mvp.teamId);

  const five = ['S1', 'S2', 'S3', 'S4', 'S5'].map((s) => ({ teamId: 't_a', stageId: s, points: 10 }));
  const out = computeMvp({ stagePoints: five, roadshowScores: [], packageId: 'tp_1', pointsConfig: P });
  assert.equal(out.stagesCounted, 4);
  assert.equal(out.mvp.stageTotal, 40, 'S5 不计入（只取前 4 个赛段）');
});

test('computeMvp：stagePoints 不带 stageId 时走退化路径（不按赛段数截断）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', points: 10 }, { teamId: 't_a', points: 5 }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.stagesCounted, 4, '配置口径仍是 4');
  assert.equal(out.mvp.stageTotal, 15, '不带 stageId 时全部计入，不做赛段截断');
  assert.equal(out.mvp.score, 15);
});

test('★ computePersonalPoints：终生上榜 + MVP 投决积分可开关 + 1224 并列', () => {
  const ledger = [
    { id: 'l1', userId: 'u_1', kind: 'stage_rank', points: 10 },
    { id: 'l2', userId: 'u_1', kind: 'mvp', points: 31 },
    { id: 'l3', userId: 'u_2', kind: 'stage_rank', points: 10 },
    { id: 'l4', userId: 'u_3', kind: 'personal_rollup', points: 99 },   // 派生快照，不重复累加
    { id: 'l5', userId: 'u_4', kind: 'stage_rank', points: 10 },
    { id: 'l6', userId: 'u_5', kind: 'stage_rank', points: 5 },
  ];
  const on = computePersonalPoints({ ledger, pointsConfig: P });
  assert.equal(on.lifetime, true);
  assert.equal(on.includeMvpVote, true);
  assert.equal(on.rows[0].userId, 'u_1');
  assert.equal(on.rows[0].total, 41, '赛段积分 + MVP 投决积分');
  assert.equal(on.rows[0].byKind.stage_rank, 10);
  assert.equal(on.rows[0].byKind.mvp, 31);
  assert.ok(!on.rows.some((r) => r.userId === 'u_3'), 'personal_rollup 不参与累加');
  assert.equal(on.excludedEntries, 1, 'personal_rollup 计入排除条数');
  // 1224 式并列：u_2 与 u_4 都是 10 分 → 并列第 2；下一个（u_5，5 分）名次跳到 4
  assert.deepEqual(on.rows.map((r) => r.rank), [1, 2, 2, 4], '同分并列 → 1224（并列后名次跳号）');

  const off = computePersonalPoints({
    ledger, pointsConfig: { ...P, personal: { lifetime: true, includeMvpVote: false } },
  });
  assert.equal(off.rows[0].total, 10, '关闭 MVP 投决积分后只剩赛段积分');
  assert.equal(off.excludedEntries, 2, '关掉 MVP 投决后，personal_rollup 与 mvp 两类都计入排除');
  assert.equal(off.includeMvpVote, false);
  // 关掉 MVP 投决后 u_1 / u_2 / u_4 都是 10 分 → 三方并列第 1，u_5（5 分）名次跳到 4
  assert.deepEqual(off.rows.map((r) => r.rank), [1, 1, 1, 4], '三方并列 → 同名次，下一名跳号');
});

test('★ R-JDG-20：并列共享奖金，总额不变', () => {
  const prizeTable = { 1: 10000, 2: 5000, 3: 2000 };
  const tied = computePrizeShares({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 1 }, { teamId: 't_c', rank: 3 }],
    prizeTable,
  });
  const solo = computePrizeShares({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 2 }, { teamId: 't_c', rank: 3 }],
    prizeTable,
  });
  assert.equal(tied.totalPool, solo.totalPool, '总额不变');
  assert.equal(tied.totalPool, 17000);
  assert.equal(tied.shares.find((s) => s.teamId === 't_a').share, 7500);
  assert.equal(tied.shares.find((s) => s.teamId === 't_b').share, 7500);
  assert.equal(tied.shares.find((s) => s.teamId === 't_c').share, 2000);
});

test('stagePointsFor：只有数组形态的 stagePoints 才认；onlyTopN 与表长相互独立', () => {
  // 非数组 → 不认（不当成表用）
  assert.equal(stagePointsFor(1, { stagePoints: { 0: 10, length: 1 }, stagePointsOnlyTopN: 1 }), 0);
  // onlyTopN 小于表长 → 第 4 名拿不到分（onlyTopN 独立于表长）
  assert.equal(stagePointsFor(4, { stagePoints: [10, 8, 5, 2], stagePointsOnlyTopN: 3 }), 0);
  assert.equal(stagePointsFor(3, { stagePoints: [10, 8, 5, 2], stagePointsOnlyTopN: 3 }), 5);
  // 表项不是数字 → 不认
  assert.equal(stagePointsFor(1, { stagePoints: ['10'], stagePointsOnlyTopN: 1 }), 0);
});

test('computeStagePoints：ordered 里没有 rank 的行，rank 记 null（不是 undefined）', () => {
  const pts = computeStagePoints({ ordered: [{ teamId: 't1' }], pointsConfig: P });
  assert.equal(pts[0].rank, null);
  assert.equal(pts[0].position, 1);
  assert.equal(pts[0].points, 10);
});

test('computeMvp：赛段键按字典序取前 N 个（乱序输入也取对）', () => {
  const out = computeMvp({
    stagePoints: [
      { teamId: 't_a', stageId: 'S3', points: 3 },
      { teamId: 't_a', stageId: 'S1', points: 1 },
      { teamId: 't_a', stageId: 'S5', points: 100 },
      { teamId: 't_a', stageId: 'S2', points: 2 },
      { teamId: 't_a', stageId: 'S4', points: 4 },
    ],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.mvp.stageTotal, 10, '按字典序取 S1..S4 = 1+2+3+4 = 10（S5 的 100 不计）');
});

test('computeMvp：stageId 为 null 的条目不算「带赛段」', () => {
  const out = computeMvp({
    stagePoints: [
      { teamId: 't_a', stageId: null, points: 5 },
      { teamId: 't_a', stageId: 'S1', points: 10 },
    ],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.mvp.stageTotal, 10, 'stageId=null 的条目不参与赛段口径');
});

test('computeMvp：roadshowWeight 配成 2 时路演积分按倍数计入', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }],
    roadshowScores: [{ teamId: 't_a', score: 70 }],
    packageId: 'tp_1',
    pointsConfig: { ...P, mvp: { ...P.mvp, roadshowWeight: 2 } },
  });
  assert.equal(out.mvp.roadshowPoints, 10);
  assert.equal(out.mvp.roadshowContribution, 20);
  assert.equal(out.mvp.score, 25);
});

test('computeMvp：综合分相同时按 teamId 码位序（结果与入参顺序无关）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_b', stageId: 'S1', points: 10 }, { teamId: 't_a', stageId: 'S1', points: 10 }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked.length, 2);
  assert.equal(out.ranked[0].teamId, 't_a');
  assert.equal(out.ranked[0].score, out.ranked[1].score);
});

test('computeMvp：只有路演分、没有赛段积分的队伍也要参与排名', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }],
    roadshowScores: [{ teamId: 't_b', score: 60 }],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked.length, 2);
  assert.equal(out.ranked[0].teamId, 't_b', '只有路演分也拿 10 分路演积分 → 排第一');
  assert.equal(out.ranked[0].stageTotal, 0);
  assert.equal(out.ranked[0].roadshowPoints, 10);
  assert.equal(out.ranked[1].teamId, 't_a');
  assert.equal(out.ranked[1].stageTotal, 5);
});

test('computeMvp：perPackage 配成 0 也至少产出 1 个 MVP（不产出空榜）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 10 }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: { ...P, mvp: { ...P.mvp, perPackage: 0 } },
  });
  assert.equal(out.mvpList.length, 1);
  assert.equal(out.mvp.teamId, 't_a');
});

test('computeMvp：配置缺 mvp 段时按兜底口径（4 赛段 / 权重 1 / 每包 1 个）', () => {
  const out = computeMvp({
    // ⚠️ 至少两支队：perPackage 兜底被改成 2 时，只有 1 支队是测不出来的
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }, { teamId: 't_b', stageId: 'S1', points: 3 }],
    roadshowScores: [{ teamId: 't_a', score: 70 }],
    packageId: 'tp_1',
    pointsConfig: { ...P, mvp: {} },
  });
  assert.equal(out.stagesCounted, 4, '缺配置 → 兜底 4 个赛段');
  assert.equal(out.roadshowWeight, 1, '缺配置 → 兜底权重 1');
  assert.equal(out.mvpList.length, 1, '缺配置 → 兜底每包 1 个 MVP');
  assert.equal(out.mvp.teamId, 't_a');
  assert.equal(out.mvp.score, 15, '5 赛段积分 + 10 路演积分');
});

test('computeMvp：路演分里没有 teamId 的条目不参与排名（不产出无名队伍）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 5 }],
    roadshowScores: [{ teamId: 't_a', score: 70 }, { score: 50 }],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.ranked.length, 1);
  assert.equal(out.ranked[0].teamId, 't_a');
  assert.equal(out.ranked[0].roadshowPoints, 10, 't_a 是唯一有效路演条目 → 第 1 位');
});

test('computeMvp：积分字段缺值 / 非数字按 0 计（不产生 NaN）', () => {
  const out = computeMvp({
    stagePoints: [{ teamId: 't_a', stageId: 'S1', points: 7 }, { teamId: 't_a', stageId: 'S2' }],
    roadshowScores: [],
    packageId: 'tp_1',
    pointsConfig: P,
  });
  assert.equal(out.mvp.stageTotal, 7, '缺 points 的条目按 0 计');
  assert.ok(Number.isFinite(out.mvp.score));
});

test('computePersonalPoints：lifetime=false 原样透出（不擅自改口径）', () => {
  const out = computePersonalPoints({
    ledger: [{ id: 'l1', userId: 'u_1', kind: 'stage_rank', points: 10 }],
    pointsConfig: { ...P, personal: { lifetime: false, includeMvpVote: true } },
  });
  assert.equal(out.lifetime, false);
});

test('computePersonalPoints：同 kind 的多条记录按 kind 累加（不是后一条覆盖前一条）', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', userId: 'u_x', kind: 'stage_rank', points: 10 },
      { id: 'l2', userId: 'u_x', kind: 'stage_rank', points: 5 },
    ],
    pointsConfig: P,
  });
  assert.equal(out.rows[0].total, 15);
  assert.equal(out.rows[0].byKind.stage_rank, 15);
});

test('computePersonalPoints：同分时按 userId 码位序稳定排序（不靠入参顺序）', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', userId: 'u_b', kind: 'stage_rank', points: 10 },
      { id: 'l2', userId: 'u_a', kind: 'stage_rank', points: 10 },
    ],
    pointsConfig: P,
  });
  assert.deepEqual(out.rows.map((r) => r.userId), ['u_a', 'u_b']);
});

test('computePersonalPoints：无 userId 的条目不参与累加；无 kind 记为 unknown', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', kind: 'stage_rank', points: 5 },          // 没有 userId → 跳过
      { id: 'l2', userId: 'u_1', points: 7 },              // 没有 kind → unknown
      { id: 'l3', userId: 'u_2' },                         // 缺 points → 按 0 计
    ],
    pointsConfig: P,
  });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].userId, 'u_1');
  assert.equal(out.rows[0].total, 7);
  assert.equal(out.rows[0].byKind.unknown, 7);
  assert.equal(out.rows[1].userId, 'u_2');
  assert.equal(out.rows[1].total, 0, '缺 points 按 0 计（不产生 NaN）');
});

test('★ computePrizeShares：奖金表缺该名次时按 0 计（总额不产生 NaN）', () => {
  const out = computePrizeShares({
    ordered: [{ teamId: 't_a', rank: 1 }, { teamId: 't_b', rank: 1 }],
    prizeTable: { 1: 10000 },
  });
  assert.equal(out.totalPool, 10000, '第 2 名奖金表里没有 → 按 0 计');
  assert.equal(out.shares[0].share, 5000);
  assert.ok(Number.isFinite(out.totalPool));
});

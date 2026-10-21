// platform/test/judge-pool.test.js —— 评委池规模与席构成校验
//
// 依据：P2 计划 Task 5「评委池校验」
// 溯源需求：R-JDG-10（初赛每维度 ≥7 人 / 决赛 ≥9 人）｜R-JDG-11（席构成；观察员无投票权）
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkJudgePool } from '../src/domain/judge-pool.js';

const CFG_INITIAL = {
  minJudgesPerDimension: 7,
  minEnterpriseSeatShare: 0.30,
  maxExpertSeatShare: 0.50,
  votingSeats: ['judge', 'enterprise'],
  nonVotingSeats: ['observer'],
};

function pool(expert, enterprise, observer) {
  const list = [];
  for (let i = 1; i <= expert; i += 1) list.push({ judgeId: `e${i}`, seat: 'judge' });
  for (let i = 1; i <= enterprise; i += 1) list.push({ judgeId: `c${i}`, seat: 'enterprise' });
  for (let i = 1; i <= observer; i += 1) list.push({ judgeId: `o${i}`, seat: 'observer' });
  return list;
}

test('评委池满足下限与席构成 → ok', () => {
  // 4 专家 + 5 企业 = 9 名有投票权评委：≥7 下限；专家 44.4% ≤ 50%；企业 55.6% ≥ 30%
  const r = checkJudgePool({ judges: pool(4, 5, 2), config: CFG_INITIAL });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stats.voting, 9);
  assert.equal(r.stats.observer, 2);
});

test('每维度评委数不足 → 报错（初赛 ≥7）', () => {
  const r = checkJudgePool({ judges: pool(2, 1, 0), config: CFG_INITIAL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'judge_pool_too_small'));
});

test('企业席占比不足 30% → 报错', () => {
  const r = checkJudgePool({ judges: pool(7, 1, 0), config: CFG_INITIAL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'enterprise_share_too_low'));
});

test('专家席占比超过 50% → 报错', () => {
  const r = checkJudgePool({ judges: pool(8, 1, 0), config: CFG_INITIAL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'expert_share_too_high'));
});

test('观察员无投票权，不计入人数与占比', () => {
  const withObs = checkJudgePool({ judges: pool(4, 5, 20), config: CFG_INITIAL });
  const without = checkJudgePool({ judges: pool(4, 5, 0), config: CFG_INITIAL });
  assert.equal(withObs.ok, without.ok);
  assert.equal(withObs.stats.voting, without.stats.voting);
  assert.equal(withObs.stats.observer, 20);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('配置项非法 → 响亮报错（绝不静默跳过对应校验）', () => {
  // ⚠️ 原实现：`Number('x')` = NaN → `minJudges > 0` 恒 false →
  //    **「人数不足」这条校验整条失效**，组委会会以为评委池合规。
  for (const key of ['minJudgesPerDimension', 'minEnterpriseSeatShare', 'maxExpertSeatShare']) {
    for (const bad of ['x', NaN, Infinity]) {
      assert.throws(
        () => checkJudgePool({ judges: pool(2, 1, 0), config: { ...CFG_INITIAL, [key]: bad } }),
        new RegExp(key),
        `${key}=${String(bad)} 必须报错`,
      );
    }
  }
});

test('席类型写错的评委 → 报错（绝不静默消失）', () => {
  // ⚠️ 原实现：既不计入 voting 也不计入 observer，
  //    `stats.total` 与 `voting + observer` **对不上**，却没有任何告警 ——
  //    而且这些评委本该属于哪个席会影响占比判断。
  const r = checkJudgePool({
    judges: [...pool(4, 5, 0), { judgeId: 'x1', seat: 'guest' }, { judgeId: 'x2', seat: 'guest' }],
    config: CFG_INITIAL,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'unknown_seat'));
  assert.equal(r.stats.unknownSeat, 2);
  // 账要能对上：total = voting + observer + unknown
  assert.equal(
    r.stats.total,
    r.stats.voting + r.stats.observer + r.stats.unknownSeat,
  );
});

test('重复 judgeId → 报错，且统计按去重后的人数算', () => {
  // ⚠️ 原实现：重复的 judgeId 被当成两个人 → 专家席占比算错。
  const r = checkJudgePool({
    judges: [...pool(4, 5, 0), { judgeId: 'e1', seat: 'judge' }],
    config: CFG_INITIAL,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'duplicate_judge'));
  assert.equal(r.stats.voting, 9, '统计必须按去重后的评委算');
  assert.equal(r.stats.expert, 4);
});

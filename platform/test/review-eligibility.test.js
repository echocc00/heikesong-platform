// platform/test/review-eligibility.test.js —— 互评资格 + 回避判定
//
// 依据：P2 计划 Task 5「回避制度 + 互评资格」
// 溯源需求：R-RNK-07（互评资格门槛）｜R-JDG-09（回避制度，回避记录留档）
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPeerEligibility, checkRecusal } from '../src/domain/review-eligibility.js';

test('只有该赛段有真实交付物的队伍才可参与互评（R-RNK-07）', () => {
  const r = checkPeerEligibility({
    teams: [{ teamId: 't1' }, { teamId: 't2' }, { teamId: 't3' }],
    deliverables: [
      { teamId: 't1', hasRealDeliverable: true },
      { teamId: 't2', hasRealDeliverable: false },
    ],
  });
  assert.deepEqual(r.eligible, ['t1']);
  assert.deepEqual(r.ineligible, ['t2', 't3']);
});

test('回避记录命中该队 → recused=true 并回传记录', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主' },
    ],
  });
  assert.equal(r.recused, true);
  assert.equal(r.record.reason, '前雇主');
});

test('赛段级回避（team_id = null）对该赛段所有队生效', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't9' },
    recusalRecords: [{ judge_id: 'u1', team_id: null, action: 'recused', reason: '供方' }],
  });
  assert.equal(r.recused, true);
});

test('无匹配回避记录 → recused=false', () => {
  const r = checkRecusal({
    judge: { userId: 'u2' },
    team: { teamId: 't1' },
    recusalRecords: [{ judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主' }],
  });
  assert.equal(r.recused, false);
  assert.equal(r.record, undefined);
});

test('撤回回避（action=reinstated）后不再视为回避', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [{ judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核' }],
  });
  assert.equal(r.recused, false);
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────

test('回避被撤销时，撤销必须生效（记录是 append-only 的，要取最后一条）', () => {
  // ⚠️ 原实现：`for` 循环遇到**第一条**匹配记录就 return。
  //    而 `recusal_records` 是 append-only 的 ——「回避 → 组委会复核 → 撤销」
  //    会留下**两条**记录，于是取到的是第一条 `recused`，
  //    `action='reinstated'` 的那条**从未被读到** → 撤销功能整个是死的。
  //    规格自带的用例只给了**单条** reinstated 记录，正好掩盖了这一点。
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主' },
      { judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核' },
    ],
  });
  assert.equal(r.recused, false, '后一条 reinstated 必须覆盖前面的 recused');
  assert.equal(r.record, undefined);
});

test('撤销之后又重新回避 → 以最后一条 recused 为准', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核' },
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '又查出了利益关系' },
    ],
  });
  assert.equal(r.recused, true);
  assert.equal(r.record.reason, '又查出了利益关系');
});

test('多条记录按 declared_at 取最新（不看数组顺序）', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't1' },
    recusalRecords: [
      { judge_id: 'u1', team_id: 't1', action: 'reinstated', reason: '已复核', declared_at: '2026-10-21T00:00:00.000Z' },
      { judge_id: 'u1', team_id: 't1', action: 'recused', reason: '前雇主', declared_at: '2026-10-20T00:00:00.000Z' },
    ],
  });
  assert.equal(r.recused, false, 'declared_at 更新的那条作数');
});

test('赛段级回避：team_id 为 undefined 也算（数据来源变化不漏判）', () => {
  const r = checkRecusal({
    judge: { userId: 'u1' },
    team: { teamId: 't9' },
    recusalRecords: [{ judge_id: 'u1', team_id: undefined, action: 'recused', reason: '赛段级' }],
  });
  assert.equal(r.recused, true);
});

test('teams 有重复 → 同一队只判一次（eligible 里不出现重复队号）', () => {
  const r = checkPeerEligibility({
    teams: [{ teamId: 't1' }, { teamId: 't1' }],
    deliverables: [{ teamId: 't1', hasRealDeliverable: true }],
  });
  assert.deepEqual(r.eligible, ['t1']);
  assert.deepEqual(r.ineligible, []);
});

test('eligible / ineligible 按队号字典序输出（与输入顺序无关）', () => {
  // ⚠️ 规格自带那条用例的 teams 恰好已是字典序 → 排序**从来没被验证过**。
  //    这里刻意把输入顺序打乱（tb,td,ta,tc）—— 否则「排序」与「不排序」结果一样。
  const r = checkPeerEligibility({
    teams: [{ teamId: 'tb' }, { teamId: 'td' }, { teamId: 'ta' }, { teamId: 'tc' }],
    deliverables: [
      { teamId: 'ta', hasRealDeliverable: true },
      { teamId: 'tb', hasRealDeliverable: true },
    ],
  });
  assert.deepEqual(r.eligible, ['ta', 'tb']);
  assert.deepEqual(r.ineligible, ['tc', 'td']);
});

test('deliverables 有重复 → 响亮报错（不静默取最后一条）', () => {
  assert.throws(
    () => checkPeerEligibility({
      teams: [{ teamId: 't1' }],
      deliverables: [
        { teamId: 't1', hasRealDeliverable: true },
        { teamId: 't1', hasRealDeliverable: false },
      ],
    }),
    /交付物/,
  );
});

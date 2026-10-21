import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { behaviorScore } from '../src/domain/behavior.js';
import { rankTeams } from '../src/domain/ranking.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const B = rules.behavior;
const CHAIN = rules.tiebreak.chain;
const OK = JSON.stringify({ repo: 'git@x', version: 'v1.2.3', artifact: 'demo.zip' });
const ev = (type, extra = {}) => ({
  id: `e_${type}_${extra.created_at || '1'}`, type,
  created_at: extra.created_at || '2026-10-10T00:00:00.000Z',
  evidence: extra.evidence === undefined ? OK : extra.evidence,
});

test('行为分明细：每周进度 2 / workshop 3 / 按时交付里程碑 5 / 企业对接会 5 / 首次 Demo 10', () => {
  const out = behaviorScore({
    events: [
      ev('weekly_progress'),
      ev('workshop_output', { evidence: JSON.stringify({ output: '课后产出.pdf' }) }),
      ev('milestone_on_time'),
      ev('enterprise_meeting', { evidence: JSON.stringify({ enterpriseConfirmationId: 'ec_1' }) }),
      ev('first_demo'),
    ],
    behaviorConfig: B,
  });
  assert.equal(out.total, 2 + 3 + 5 + 5 + 10);
  assert.equal(out.items.length, 5);
  assert.ok(out.items.every((i) => i.counted));
  assert.equal(out.completionThreshold, 60, '达标线 60 = 完赛（R-PTS-09）');
  assert.equal(out.maxWeightShare, 0.10);
  assert.equal(out.sortUse, 'tiebreak_only', '行为分只做破同分（R-PTS-08）');
});

test('★ 反作弊 5 条：签到 0 分 / 纯文字进度不给分 / 提交须带版本记录+代码仓', () => {
  const checkin = behaviorScore({ events: [ev('checkin')], behaviorConfig: B });
  assert.equal(checkin.total, 0);
  assert.equal(checkin.items[0].counted, false);
  assert.equal(checkin.items[0].reason, 'unknown_event_type');

  const plain = behaviorScore({ events: [ev('weekly_progress', { evidence: '今天我们把进度更新了一下' })], behaviorConfig: B });
  assert.equal(plain.total, 0);
  assert.equal(plain.items[0].reason, 'evidence_not_json');

  const noRepo = behaviorScore({ events: [ev('weekly_progress', { evidence: JSON.stringify({ version: 'v1', artifact: 'a' }) })], behaviorConfig: B });
  assert.equal(noRepo.total, 0);
  assert.equal(noRepo.items[0].reason, 'evidence_missing_repo');

  const noVersion = behaviorScore({ events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', artifact: 'a' }) })], behaviorConfig: B });
  assert.equal(noVersion.total, 0);
  assert.equal(noVersion.items[0].reason, 'evidence_missing_version');

  const blocked = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', version: 'v1', blocker: '缺 API key' }) })],
    behaviorConfig: B,
  });
  assert.equal(blocked.total, 2, '明确阻塞点也算有效提交（R-STG-04）');
});

test('workshop 必须有课后产出；企业对接会必须有企业确认记录；once 事件只计第一次', () => {
  const noOutput = behaviorScore({ events: [ev('workshop_output', { evidence: JSON.stringify({}) })], behaviorConfig: B });
  assert.equal(noOutput.total, 0);
  assert.equal(noOutput.items[0].reason, 'evidence_missing_output');

  const noConfirm = behaviorScore({ events: [ev('enterprise_meeting', { evidence: JSON.stringify({ note: '聊了' }) })], behaviorConfig: B });
  assert.equal(noConfirm.total, 0);
  assert.equal(noConfirm.items[0].reason, 'evidence_missing_enterpriseConfirmationId');

  const twice = behaviorScore({
    events: [ev('first_demo', { created_at: '2026-10-10T00:00:00.000Z' }), ev('first_demo', { created_at: '2026-10-11T00:00:00.000Z' })],
    behaviorConfig: B,
  });
  assert.equal(twice.total, 10);
  assert.equal(twice.items[1].counted, false);
  assert.equal(twice.items[1].reason, 'once_limit');
});

test('★ 隔离断言：行为分变化【不影响总分】与【不影响非完全同分队伍的 A 榜名次】', () => {
  const base = [
    { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5 },
    { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5 },
    { teamId: 't_c', total: 70, peerScore: 5, enterpriseRaw: 5 },
  ];
  const run = (behaviorScoreValue) => rankTeams({
    teams: base.map((t) => ({ ...t, behaviorScore: behaviorScoreValue })),
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  const low = run(0);
  const high = run(100);
  assert.deepEqual(low.ordered.map((o) => o.total), high.ordered.map((o) => o.total), '总分不变');
  assert.deepEqual(low.ordered.map((o) => o.rank), high.ordered.map((o) => o.rank), '名次数组不变');
  assert.equal(low.ordered.find((o) => o.teamId === 't_c').rank, 3);
  assert.equal(high.ordered.find((o) => o.teamId === 't_c').rank, 3);
  assert.deepEqual(high.ordered.map((o) => o.rank), [1, 1, 3]);
});

test('★ 隔离断言：完全同分时行为分只当破同分用 —— 可比较时拆开、不可比较时保持并列', () => {
  const r = rankTeams({
    teams: [
      { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: 1 },
      { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: 99 },
    ],
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_b', 't_a'], '行为分高者在前');
  // ⚠️ 行为分是链上的**实质依据**（scope=tied_only、非 deterministic）→ 可比较时【拆开并列】，
  //    名次变成 1、2。只有链末的 team_id（deterministic:true）才是「只排序不拆组」。
  //    规格原写法期望 [1,1]（以为行为分不拆组）—— 与 R-PTS-08「同分时的最后排序依据」矛盾。
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 2], '行为分可用时把并列拆开 → 名次 1、2');

  // 行为分不可比较（缺值）→ 该键在本组不可用 → 保持并列，名次仍是 1、1
  const tie = rankTeams({
    teams: [
      { teamId: 't_a', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: null },
      { teamId: 't_b', total: 80, peerScore: 5, enterpriseRaw: 5, behaviorScore: null },
    ],
    tiebreakChain: CHAIN, tiebreakData: { isFinal: false }, pointsConfig: rules.points,
  });
  assert.deepEqual(tie.ordered.map((o) => o.rank), [1, 1], '行为分不可用 → 保持并列');
  assert.ok(tie.warnings.some((w) => w.code === 'tiebreak_key_unusable'), '键不可用必须显式告警，不静默');
});

test('★ 证据边界：缺证据 / 非 JSON / 非对象 / oneOf 全不满足', () => {
  const missing = behaviorScore({ events: [ev('weekly_progress', { evidence: null })], behaviorConfig: B });
  assert.equal(missing.total, 0);
  assert.equal(missing.items[0].reason, 'missing_evidence');

  const empty = behaviorScore({ events: [ev('weekly_progress', { evidence: '' })], behaviorConfig: B });
  assert.equal(empty.items[0].reason, 'missing_evidence');

  const notObject = behaviorScore({ events: [ev('weekly_progress', { evidence: '123' })], behaviorConfig: B });
  assert.equal(notObject.total, 0);
  assert.equal(notObject.items[0].reason, 'evidence_not_object', 'JSON 但不是对象 → 不认');

  const array = behaviorScore({ events: [ev('weekly_progress', { evidence: '[1,2]' })], behaviorConfig: B });
  assert.equal(array.items[0].reason, 'evidence_not_object', '数组也不是对象 → 不认');

  const none = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', version: 'v1' }) })],
    behaviorConfig: B,
  });
  assert.equal(none.total, 0, '既没有 artifact 也没有 blocker → 不给分');
  assert.equal(none.items[0].reason, 'evidence_missing_any_of_artifact_or_blocker');
});

test('once 事件：证据不合格的提交【不占用】once 名额', () => {
  const cfg = {
    ...B,
    events: B.events.map((e) => (e.key === 'first_demo' ? { ...e, requiresEvidence: true } : e)),
    evidenceRequirements: { first_demo: { required: ['artifact'], oneOf: [] } },
  };
  const out = behaviorScore({
    events: [
      ev('first_demo', { created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({}) }),
      ev('first_demo', { created_at: '2026-10-11T00:00:00.000Z', evidence: JSON.stringify({ artifact: 'demo.zip' }) }),
    ],
    behaviorConfig: cfg,
  });
  assert.equal(out.items[0].counted, false, '证据不合格 → 0 分');
  assert.equal(out.items[1].counted, true, '不合格的那次不占用 once 名额，后面合格的可计分');
  assert.equal(out.total, 10);
});

test('行为分配置的兜底：缺阈值/缺占比/缺 sortUse 时如实返回 null', () => {
  const out = behaviorScore({ events: [], behaviorConfig: {} });
  assert.equal(out.total, 0);
  assert.equal(out.completionThreshold, 60, '缺阈值 → 兜底 60');
  assert.equal(out.maxWeightShare, null);
  assert.equal(out.sortUse, null, '配置没写就是 null（不硬编一个值出来）');
  assert.equal(out.completed, false);

  const noArgs = behaviorScore({ behaviorConfig: B });
  assert.equal(noArgs.total, 0, '连 events 都不传 → 空集，不崩');
  assert.equal(noArgs.items.length, 0);
});

test('★ 证据对象形态：evidence 已经是对象时不必再是 JSON 字符串', () => {
  const out = behaviorScore({
    events: [ev('weekly_progress', { evidence: { repo: 'r', version: 'v1', artifact: 'a.zip' } })],
    behaviorConfig: B,
  });
  assert.equal(out.total, 2, '对象形态的证据同样认');
  assert.equal(out.items[0].counted, true);
});

test('证据要求：没写 required / oneOf 的规则不得崩', () => {
  const cfg = { ...B, evidenceRequirements: { weekly_progress: {} } };
  const out = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ anything: 1 }) })],
    behaviorConfig: cfg,
  });
  assert.equal(out.total, 2, '没有必填字段 → 不拦');
});

test('★ 空白值不算有效证据（trim 后为空）', () => {
  const blank = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: '   ', version: 'v1', artifact: 'a' }) })],
    behaviorConfig: B,
  });
  assert.equal(blank.total, 0);
  assert.equal(blank.items[0].reason, 'evidence_missing_repo', '全是空白的 repo 视为没填');

  const blankBlocker = behaviorScore({
    events: [ev('weekly_progress', { evidence: JSON.stringify({ repo: 'r', version: 'v1', blocker: '   ' }) })],
    behaviorConfig: B,
  });
  assert.equal(blankBlocker.total, 0);
  assert.equal(blankBlocker.items[0].reason, 'evidence_missing_any_of_artifact_or_blocker');
});

test('事件配置缺 points 时按 0 计（不产生 NaN）', () => {
  const cfg = { ...B, events: [{ key: 'weekly_progress', label: '每周进度' }] };
  const out = behaviorScore({ events: [ev('weekly_progress')], behaviorConfig: cfg });
  assert.equal(out.total, 0);
  assert.ok(Number.isFinite(out.total));
});

test('★ 达标线是「≥」不是「>」：刚好到线算完赛', () => {
  const cfg = { ...B, completionThreshold: 25 };
  const out = behaviorScore({
    events: [
      ev('weekly_progress'), ev('workshop_output', { evidence: JSON.stringify({ output: 'o' }) }),
      ev('milestone_on_time'), ev('enterprise_meeting', { evidence: JSON.stringify({ enterpriseConfirmationId: 'e' }) }),
      ev('first_demo'),
    ],
    behaviorConfig: cfg,
  });
  assert.equal(out.total, 25);
  assert.equal(out.completed, true, '刚好 25 = 达标（>=）');
});

test('★ 事件按创建时间升序处理；同一时刻按 id 兜底（顺序可复现）', () => {
  const out = behaviorScore({
    events: [
      ev('first_demo', { created_at: '2026-10-11T00:00:00.000Z', evidence: JSON.stringify({ artifact: 'ok.zip' }) }),
      ev('first_demo', { created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({}) }),
    ],
    behaviorConfig: { ...B, evidenceRequirements: { ...{}, first_demo: { required: ['artifact'], oneOf: [] } } },
  });
  assert.deepEqual(out.items.map((i) => i.counted), [false, true], '早的那条先判 → 早的不合格不算占用 once');
  assert.equal(out.total, 10);

  const same = behaviorScore({
    events: [
      { id: 'e_b', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({ repo: 'r', version: 'v', artifact: 'a' }) },
      { id: 'e_a', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: JSON.stringify({ repo: 'r', version: 'v', artifact: 'a' }) },
    ],
    behaviorConfig: B,
  });
  assert.deepEqual(same.items.map((i) => i.type), ['weekly_progress', 'weekly_progress']);
  assert.equal(same.total, 4);
});

test('★ 排序口径：先按创建时间，同一时刻再按 id 码位序（两条都要钉住）', () => {
  const byTime = behaviorScore({
    events: [
      { id: 'e_1', type: 'milestone_on_time', created_at: '2026-10-11T00:00:00.000Z', evidence: OK },
      { id: 'e_2', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: OK },
    ],
    behaviorConfig: B,
  });
  assert.deepEqual(byTime.items.map((i) => i.type), ['weekly_progress', 'milestone_on_time'],
    '按创建时间升序（不是按 id）');

  const byId = behaviorScore({
    events: [
      { id: 'e_2', type: 'milestone_on_time', created_at: '2026-10-10T00:00:00.000Z', evidence: OK },
      { id: 'e_1', type: 'weekly_progress', created_at: '2026-10-10T00:00:00.000Z', evidence: OK },
    ],
    behaviorConfig: B,
  });
  assert.deepEqual(byId.items.map((i) => i.type), ['weekly_progress', 'milestone_on_time'],
    '同一时刻按 id 码位序兜底（e_1 < e_2）');
});

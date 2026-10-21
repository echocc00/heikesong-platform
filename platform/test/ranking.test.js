import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { rankTeams, applyTiebreakChain, assertChainInvariants } from '../src/domain/ranking.js';
import { toNumber, cmpStr, omit } from '../src/domain/util.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const CHAIN = rules.tiebreak.chain;
const teamsOf = (rows) => rows.map((r) => ({ teamId: r.teamId, total: r.total, ...r.extra }));
const rank = (teams, isFinal = false) => rankTeams({
  teams, tiebreakChain: CHAIN, tiebreakData: { isFinal }, pointsConfig: rules.points,
});

test('rules/tiebreak.json 的破同分链仍是裁决后的 6 级有序链（不得被 P3 改动）', () => {
  assert.deepEqual(CHAIN.map((c) => c.key),
    ['total', 'tiebreak_extra', 'peer', 'enterprise_raw', 'behavior', 'team_id']);
  assert.deepEqual(CHAIN.map((c) => c.scope),
    ['always', 'final_only', 'tied_only', 'tied_only', 'tied_only', 'always']);
  assert.equal(CHAIN.at(-1).deterministic, true, '最后一级必须是确定性兜底');
});

test('不同总分 → 按总分降序，名次 1/2/3', () => {
  const r = rank(teamsOf([{ teamId: 't_c', total: 70 }, { teamId: 't_a', total: 90 }, { teamId: 't_b', total: 80 }]));
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_a', 't_b', 't_c']);
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 2, 3]);
  assert.equal(r.rankStyle, '1224');
});

test('★ 1224 式并列名次：1,1,3（不是 1,1,2）', () => {
  // ⚠️ 真正的并列要求两队在【所有实质破同分键】上都相等（总分、互评、企业原始分、行为分）。
  //    只让总分相等是不够的——互评分不等就会在链的第 3 级被分开，名次变成 1,2（那是正确的）。
  const r = rank(teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_b', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_c', total: 80, extra: { peerScore: 9 } },
  ]));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1, 3]);
  assert.deepEqual(r.ordered[0].tiedWith, ['t_b']);
  assert.deepEqual(r.ordered[2].tiedWith, []);
  assert.deepEqual(r.tieGroups, [['t_a', 't_b'], ['t_c']]);
});

test('总分相等但互评分不等 → 在链的第 3 级被分开，名次是 1,2（不是并列）', () => {
  const r = rank(teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_b', total: 90, extra: { peerScore: 3 } },
    { teamId: 't_c', total: 80, extra: { peerScore: 9 } },
  ]));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 2, 3]);
  assert.deepEqual(r.ordered[0].tiedWith, []);
});

test('★ 全同分时落到队伍编号兜底，结果稳定可复算', () => {
  const teams = teamsOf([{ teamId: 't_z', total: 100 }, { teamId: 't_a', total: 100 }, { teamId: 't_m', total: 100 }]);
  const a = rank(teams);
  const b = rank(teams);
  assert.deepEqual(a.ordered.map((o) => o.teamId), ['t_a', 't_m', 't_z']);
  assert.deepEqual(a.ordered.map((o) => o.teamId), b.ordered.map((o) => o.teamId));
  assert.deepEqual(a.ordered.map((o) => o.rank), [1, 1, 1], '兜底只决定组内顺序，不拆名次');
});

test('破同分链优先级：加时陈述 > 互评 > 企业原始分 > 行为分', () => {
  const r = rank(teamsOf([
    { teamId: 't_peer', total: 80, extra: { peerScore: 9, enterpriseRaw: 1, behaviorScore: 0, tiebreakExtra: 0 } },
    { teamId: 't_ent', total: 80, extra: { peerScore: 1, enterpriseRaw: 9, behaviorScore: 0, tiebreakExtra: 0 } },
    { teamId: 't_beh', total: 80, extra: { peerScore: 1, enterpriseRaw: 1, behaviorScore: 9, tiebreakExtra: 0 } },
    { teamId: 't_final', total: 80, extra: { peerScore: 1, enterpriseRaw: 1, behaviorScore: 1, tiebreakExtra: 9 } },
  ]), true);
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_final', 't_peer', 't_ent', 't_beh']);
});

test('final_only：非决赛时加时陈述复议分不参与', () => {
  const teams = teamsOf([
    { teamId: 't_a', total: 80, extra: { peerScore: 1, enterpriseRaw: 1, behaviorScore: 1, tiebreakExtra: 99 } },
    { teamId: 't_b', total: 80, extra: { peerScore: 9, enterpriseRaw: 1, behaviorScore: 1, tiebreakExtra: 0 } },
  ]);
  assert.deepEqual(rank(teams, false).ordered.map((o) => o.teamId), ['t_b', 't_a']);
  assert.deepEqual(rank(teams, true).ordered.map((o) => o.teamId), ['t_a', 't_b']);
});

test('组内缺可比较的值时该键不可用（不静默当 0），并给出 warning', () => {
  const r = rank(teamsOf([
    { teamId: 't_a', total: 80, extra: { peerScore: 9 } },
    { teamId: 't_b', total: 80, extra: {} },
  ]));
  assert.ok(r.warnings.some((w) => w.code === 'tiebreak_key_unusable'));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1], '互评分不可用 → 仍并列');
});

test('★ 破同分链不变量：行为分不得排链首 / 必须 tied_only / 必须是最后一项实质依据', () => {
  assert.deepEqual(assertChainInvariants(CHAIN), []);
  const headFirst = [CHAIN[4], ...CHAIN.filter((_, i) => i !== 4)];
  assert.ok(assertChainInvariants(headFirst).some((e) => e.includes('链首')));
  const wrongScope = CHAIN.map((c) => (c.key === 'behavior' ? { ...c, scope: 'always' } : c));
  assert.ok(assertChainInvariants(wrongScope).some((e) => e.includes('tied_only')));
  const notLast = CHAIN.filter((c) => c.key !== 'team_id');
  assert.ok(assertChainInvariants(notLast).some((e) => e.includes('确定性兜底')));
});

test('applyTiebreakChain 返回 applied 轨迹（哪一档被用到）', () => {
  const { applied } = applyTiebreakChain({
    candidates: teamsOf([
      { teamId: 't_a', total: 80, extra: { peerScore: 9 } },
      { teamId: 't_b', total: 80, extra: { peerScore: 1 } },
    ]),
    chain: CHAIN, data: { isFinal: false },
  });
  const peer = applied.find((a) => a.key === 'peer');
  assert.ok(peer, '互评分应被用到');
  assert.equal(peer.separated, true);
  assert.deepEqual(peer.usedBy.sort(), ['t_a', 't_b']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 父代理变异检验追加的用例（2026-10-21）—— 三条都是**规格自带的缺陷**
// ═══════════════════════════════════════════════════════════════════════════

test('★ 数值键必须按数值比较（字符串形态的 "100" 不能排在 "90" 后面）', () => {
  // ⚠️ 字典序下 '100' < '90' → 100 分的队被排到 90 分的队**后面**，且没有任何报错。
  const r = rank(teamsOf([{ teamId: 't_a', total: '100' }, { teamId: 't_b', total: '90' }]));
  assert.deepEqual(r.ordered.map((o) => o.teamId), ['t_a', 't_b']);
});

test('★ 数值键的「相等」按数值判定：90 与 "90" 是同一个分（并列，不是 1,2）', () => {
  const r = rank(teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 5 } },
    { teamId: 't_b', total: '90', extra: { peerScore: 5 } },
  ]));
  assert.deepEqual(r.ordered.map((o) => o.rank), [1, 1]);
  assert.deepEqual(r.tieGroups, [['t_a', 't_b']]);
});

test('★ 缺值绝不被当成 0（toNumber(null) 必须是 null 而不是 0）', () => {
  // ⚠️ `Number(null)` 是 0 —— 直接 Number() 会把「缺值」静默变成「0 分」。
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(0), 0, '真正的 0 就是 0，不能与缺值混为一谈');
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber('88.5'), 88.5);
});

test('★ 破同分链缺少总分项必须被拦下（没有总分就不是破同分链）', () => {
  const noTotal = CHAIN.filter((c) => c.key !== 'total');
  assert.ok(assertChainInvariants(noTotal).some((e) => e.includes('总分')));
});

test('★ tiebreakData.byTeam 传值路径与候选内联字段等价', () => {
  // ⚠️ 服务层是按 byTeam 传破同分数据的；候选对象内联只是等价写法。
  //    两条路径必须给出一致的名次 —— 否则「接口换个传法榜单就变了」。
  const teams = teamsOf([
    { teamId: 't_a', total: 90, extra: { peerScore: 9 } },
    { teamId: 't_b', total: 90, extra: { peerScore: 1 } },
  ]);
  const inline = rank(teams);
  const byTeam = rankTeams({
    teams: teams.map((t) => ({ teamId: t.teamId, total: t.total })),
    tiebreakChain: CHAIN,
    tiebreakData: { isFinal: false, byTeam: { t_a: { peerScore: 9 }, t_b: { peerScore: 1 } } },
    pointsConfig: rules.points,
  });
  assert.deepEqual(byTeam.ordered.map((o) => o.teamId), inline.ordered.map((o) => o.teamId));
  assert.deepEqual(byTeam.ordered.map((o) => o.rank), [1, 2]);
});

test('★ cmpStr 走的是码位序（不是 localeCompare）—— 跨机器可复算', () => {
  // ⚠️ localeCompare 依赖 ICU / locale，同一份数据在不同机器上可能不同序 →
  //    榜单不可复算（R-AUD-01）。码位序是确定性的。
  assert.ok(cmpStr('a', 'B') > 0, "码位序下 'B'(0x42) < 'a'(0x61)");
  assert.ok(cmpStr('a', 'B') !== 'a'.localeCompare('B'), '不得使用 localeCompare');
  assert.equal(cmpStr('t_a', 't_a'), 0);
  assert.equal(cmpStr(null, 'x'), -1);
});

test('★ omit 是「剔除」语义（名字与行为一致）', () => {
  const src = { teamId: 't_a', peerScore: 90, enterpriseRaw: 80, password_hash: 'x' };
  const out = omit(src, ['peerScore', 'enterpriseRaw', 'password_hash']);
  assert.deepEqual(out, { teamId: 't_a' });
  assert.deepEqual(src, { teamId: 't_a', peerScore: 90, enterpriseRaw: 80, password_hash: 'x' }, '原对象不得被改');
  assert.equal(omit({}, ['a']).a, undefined);
});

test('★ toNumber 对 NaN / Infinity 一律当缺值', () => {
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(-Infinity), null);
});

test('★ 不变量隔离：behavior 不在「最后一项实质依据」位置（其余检查都不触发）', () => {
  // ⚠️ 必须**只**触发这一条检查：链尾是确定性兜底、含总分、behavior 不在链首、scope 正确。
  //    否则「行为分位置」与「确定性兜底」两条检查会互相掩盖，谁被摘掉都测不出来。
  const chain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always' },
    { key: 'behavior', label: '行为分', direction: 'desc', scope: 'tied_only' },
    { key: 'peer', label: '互评分', direction: 'desc', scope: 'tied_only' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always', deterministic: true },
  ];
  const errs = assertChainInvariants(chain);
  assert.ok(errs.some((e) => e.includes('最后一项实质依据')), `应报「最后一项实质依据」：${errs.join(' | ')}`);
});

test('★ 不变量隔离：链尾不是确定性兜底（且链里没有 behavior）', () => {
  const chain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always' },
  ];
  const errs = assertChainInvariants(chain);
  assert.ok(errs.some((e) => e.includes('确定性兜底')), `应报「确定性兜底」：${errs.join(' | ')}`);
});

test('★ 链非法时 applyTiebreakChain 必须抛错（不得照算出一份榜单）', () => {
  const badChain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always' },
  ];
  assert.throws(
    () => applyTiebreakChain({ candidates: teamsOf([{ teamId: 't_a', total: 90 }]), chain: badChain, data: {} }),
    /破同分链配置非法/,
  );
});

test('★ ordered 里必须带 total（榜单行要显示总分）', () => {
  const r = rank(teamsOf([{ teamId: 't_a', total: 90 }, { teamId: 't_b', total: 80 }]));
  assert.deepEqual(r.ordered.map((o) => o.total), [90, 80]);
});

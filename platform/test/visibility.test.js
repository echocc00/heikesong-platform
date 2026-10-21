import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';
import { applyVisibility } from '../src/domain/visibility.js';

const { rules } = loadRules(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules'));
const V = rules.visibility;
const ORDER = rules.ranks.tiers.map((t) => t.key);
const tierPayload = () => ({
  scope: 'tier',
  rows: [
    { teamId: 't_s', teamName: 'S队', tier: 'S', tierRank: 1, enterpriseName: '某某公司' },
    { teamId: 't_a', teamName: 'A队', tier: 'A', tierRank: 2, enterpriseName: '乙公司' },
    // ⚠️ D 队行刻意带一个通用的 `rank` 字段：段位榜的排名字段是 `tierRank`，
    //    但 payload 未必不会带通用 `rank` → 本人进度卡必须把它一起剔掉。
    { teamId: 't_d', teamName: 'D队', tier: 'D', tierRank: 9, rank: 9, enterpriseName: '丙公司', progress: { done: 0, total: 7 } },
  ],
});
const apply = (payload, context, viewer = null, cfg = V) => applyVisibility({
  payload, viewer, visibilityConfig: cfg, context: { tierOrder: ORDER, ...context },
});

test('★ C-02 裁决：段位榜里 D 段不出现在榜单，只给本人进度卡（且不含名次）', () => {
  const out = apply(tierPayload(), { scope: 'tier' });
  assert.deepEqual(out.rows.map((r) => r.teamId), ['t_s', 't_a']);
  assert.ok(!out.rows.some((r) => r.tier === 'D'));

  const self = apply(tierPayload(), { scope: 'tier', viewerTeamId: 't_d' }, { id: 'u_1' });
  assert.deepEqual(self.rows.map((r) => r.teamId), ['t_s', 't_a']);
  assert.ok(self.selfProgress, '本人应拿到进度卡');
  assert.equal(self.selfProgress.teamId, 't_d');
  assert.equal(self.selfProgress.rank, undefined, '本人进度卡不含名次');
  assert.deepEqual(self.selfProgress.progress, { done: 0, total: 7 });
});

test('★ 段位榜与 A 榜都不公示企业名', () => {
  const out = apply(tierPayload(), { scope: 'tier' });
  for (const r of out.rows) assert.equal(r.enterpriseName, undefined, '企业名不公示（S10 §8）');
  const rank = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, enterpriseName: '某某公司' }],
  }, { scope: 'rank' });
  assert.equal(rank.rows[0].enterpriseName, undefined);
});

test('★ B 榜：里程碑公开，但评分与签字人不公开；互评来源不公示', () => {
  const out = apply({
    scope: 'business',
    rows: [{
      teamId: 't_a', teamName: 'A队',
      milestones: [{ key: 'data_connected', label: '真实数据接入', achieved: true }],
      score: 88, rawScore: 90, seatE: 91,
      signatory: '张三', signatoryUserId: 'u_9', signatoryName: '张三',
      enterpriseName: '某某公司', enterpriseId: 'e_1',
    }],
  }, { scope: 'business' });
  const row = out.rows[0];
  assert.equal(row.milestones[0].achieved, true, '里程碑进度公开');
  for (const k of ['score', 'rawScore', 'seatE', 'signatory', 'signatoryUserId', 'signatoryName', 'enterpriseName', 'enterpriseId']) {
    assert.equal(row[k], undefined, `${k} 不应出现在 B 榜`);
  }

  const rank = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, peerSource: 't_x', fromTeamId: 't_x', fromUserId: 'u_7', peerScore: 5 }],
  }, { scope: 'rank' });
  for (const k of ['peerSource', 'fromTeamId', 'fromUserId', 'peerScore']) {
    assert.equal(rank.rows[0][k], undefined, `${k} 互评来源不公示`);
  }
});

test('A 榜与滚动总榜全员公开（任务书 §七 明文）；个人榜标出本人且不泄露手机号', () => {
  const rank = apply({
    scope: 'rank',
    rows: [{ teamId: 't_d', teamName: 'D队', rank: 9, total: 60, tier: 'D' },
      { teamId: 't_s', teamName: 'S队', rank: 1, total: 90, tier: 'S' }],
  }, { scope: 'rank' });
  assert.equal(rank.rows.length, 2, 'A 榜不因段位低而隐藏');

  const personal = apply({
    scope: 'personal',
    rows: [{ userId: 'u_1', name: '张三', total: 41, rank: 1, phone: '13800000000', org: '某公司' }],
  }, { scope: 'personal' }, { id: 'u_1' });
  assert.equal(personal.rows[0].isSelf, true);
  assert.equal(personal.rows[0].phone, undefined);
  assert.equal(personal.rows[0].org, undefined);
});

test('配置关闭时字段才会回来（可见性是配置驱动的，不是硬编码）；过滤不改原对象', () => {
  const payload = { scope: 'business', rows: [{ teamId: 't_a', signatory: '张三', enterpriseName: '某某公司', score: 88 }] };
  const out = apply(payload, { scope: 'business' }, null, {
    ...V,
    business: { ...V.business, scoresPublic: true, signatoryPublic: true },
    rank: { ...V.rank, showEnterpriseName: true },
  });
  assert.equal(out.rows[0].signatory, '张三');
  assert.equal(out.rows[0].score, 88);
  assert.equal(out.rows[0].enterpriseName, '某某公司');
  assert.equal(payload.rows[0].signatory, '张三', '原对象必须保持不变（不能污染快照）');
});

test('★ 默认口径必须是【关】：配置漏写时也不公示（fail-closed）', () => {
  // 互评来源：配置里没有 peerReview 段 → 仍然不公示
  const peer = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', peerSource: 't_x', fromTeamId: 't_x', fromUserId: 'u_7', peerScore: 5 }],
  }, { scope: 'rank' }, null, { ...V, peerReview: undefined });
  for (const k of ['peerSource', 'fromTeamId', 'fromUserId', 'peerScore']) {
    assert.equal(peer.rows[0][k], undefined, `配置漏写 peerReview 时 ${k} 仍不公示`);
  }

  // 企业名：配置里没有 rank 段 → 仍然不公示
  const ent = apply({
    scope: 'rank',
    rows: [{ teamId: 't_a', enterpriseName: '某某公司', enterpriseId: 'e_1' }],
  }, { scope: 'rank' }, null, { ...V, rank: undefined });
  assert.equal(ent.rows[0].enterpriseName, undefined, '配置漏写 rank 时企业名仍不公示');
  assert.equal(ent.rows[0].enterpriseId, undefined);

  // B 榜评分：配置里没有 business 段 → 仍然不公示
  const biz = apply({
    scope: 'business',
    rows: [{ teamId: 't_a', score: 88, signatory: '张三', signatoryUserId: 'u_9' }],
  }, { scope: 'business' }, null, { ...V, business: undefined });
  assert.equal(biz.rows[0].score, undefined, '配置漏写 business 时评分仍不公示');
  assert.equal(biz.rows[0].signatory, undefined, '配置漏写 business 时签字人仍不公示');

  // 段位公示起点：配置里没有 publicFromTier → 仍按 C 段起公示（D 段不公示）
  const tier = apply(tierPayload(), { scope: 'tier' }, null, { ...V, rank: { ...V.rank, publicFromTier: undefined } });
  assert.deepEqual(tier.rows.map((r) => r.teamId), ['t_s', 't_a'], '漏写 publicFromTier 时仍按 C 段起公示');
});

test('过滤的输入输出边界：scope 兜底、空 rows、payload 其他字段保留', () => {
  // scope 优先取 context；context 没有就取 payload.scope
  const fromPayload = applyVisibility({
    payload: { scope: 'business', rows: [{ teamId: 't_a', signatory: '张三' }] },
    viewer: null, visibilityConfig: V, context: {},
  });
  assert.equal(fromPayload.rows[0].signatory, undefined, 'scope 从 payload 取时也要按 B 榜口径过滤');

  // payload 没有 rows → 空集，不崩
  const empty = applyVisibility({ payload: { scope: 'rank' }, viewer: null, visibilityConfig: V, context: { scope: 'rank' } });
  assert.deepEqual(empty.rows, []);

  // payload 的其他字段（scope / warnings 等）必须原样带出
  const kept = apply({
    scope: 'rank', warnings: [{ code: 'x' }], editionId: 'e_1',
    rows: [{ teamId: 't_a', rank: 1 }],
  }, { scope: 'rank' });
  assert.equal(kept.scope, 'rank');
  assert.equal(kept.editionId, 'e_1');
  assert.deepEqual(kept.warnings, [{ code: 'x' }]);
});

test('段位榜：段位顺序取自上下文、旁观者拿不到任何进度卡、本人卡片不含名次', () => {
  const byOrder = apply(tierPayload(), { scope: 'tier', tierOrder: ['D', 'C', 'B', 'A', 'S'] });
  assert.deepEqual(byOrder.rows.map((r) => r.teamId), ['t_s', 't_a']);

  // 段位顺序真的取自上下文（换个顺序 → 公示边界跟着变）
  const custom = apply(tierPayload(), { scope: 'tier', tierOrder: ['C', 'B', 'A', 'S', 'D'] });
  assert.deepEqual(custom.rows.map((r) => r.teamId), ['t_s', 't_a', 't_d'],
    'C 排在首位时公示起点变成最低档 → D 也公示');

  // viewerTeamIds（本人可能在多支队里）也要认
  const multi = apply(tierPayload(), { scope: 'tier', viewerTeamIds: ['t_d'] }, { id: 'u_1' });
  assert.equal(multi.selfProgress?.teamId, 't_d', 'context.viewerTeamIds 也要认');

  const stranger = apply(tierPayload(), { scope: 'tier' });
  assert.equal(stranger.selfProgress, undefined, '旁观者拿不到任何人的进度卡');

  // viewer 自带 teamId 时也认（不只认 context.viewerTeamId）
  const byViewer = apply(tierPayload(), { scope: 'tier' }, { id: 'u_1', teamId: 't_d' });
  assert.equal(byViewer.selfProgress?.teamId, 't_d', 'viewer.teamId 也要认');

  const self = apply(tierPayload(), { scope: 'tier', viewerTeamId: 't_d' }, { id: 'u_1' });
  assert.equal(self.selfProgress.tierRank, undefined, '本人进度卡不含段位名次');
  assert.equal(self.selfProgress.teamName, undefined, '本人进度卡不含队名');

  const noProgress = apply({
    scope: 'tier',
    rows: [{ teamId: 't_d', teamName: 'D队', tier: 'D', tierRank: 9 }],
  }, { scope: 'tier', viewerTeamId: 't_d' }, { id: 'u_1' });
  assert.equal(noProgress.selfProgress.progress, null, '没有进度时给 null（不是 undefined）');
});

test('B 榜也清互评来源；个人榜清密码哈希；未知 scope 也清互评来源', () => {
  const biz = apply({
    scope: 'business',
    rows: [{ teamId: 't_a', score: 88, peerSource: 't_x', fromTeamId: 't_x', peerScore: 5 }],
  }, { scope: 'business' });
  for (const k of ['peerSource', 'fromTeamId', 'peerScore']) {
    assert.equal(biz.rows[0][k], undefined, `B 榜的 ${k} 也要清`);
  }

  const personal = apply({
    scope: 'personal',
    rows: [{ userId: 'u_1', name: '张三', total: 41, phone: '13800000000', org: '某公司', idCard: '310', password_hash: 'x' }],
  }, { scope: 'personal' }, { id: 'u_1' });
  for (const k of ['phone', 'org', 'idCard', 'password_hash']) {
    assert.equal(personal.rows[0][k], undefined, `个人榜的 ${k} 要清`);
  }

  const unknown = apply({
    scope: 'whatever',
    rows: [{ teamId: 't_a', peerSource: 't_x', peerScore: 5 }],
  }, { scope: 'whatever' });
  assert.equal(unknown.rows[0].peerSource, undefined, '未知 scope 也要清互评来源');
  assert.equal(unknown.rows[0].peerScore, undefined);
});

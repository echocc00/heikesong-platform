// platform/test/leaderboard-web.test.js —— P3 前端三页的渲染行为
//
// 规则溯源：
//   - 「前端只渲染，不做过滤」→ 可见性在 API 层完成（设计文档 §6.6 / 冲突裁决 C-02）
//   - 「降级告警置顶」→ S-5 / C-05：降级状态必须显式展示，不静默
//   - 「队名必须转义」→ 设计文档 §14.2 + P0 终审 I-2（innerHTML 插值 = 存储型 XSS）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaderboardHtml } from '../web/views/leaderboard.js';
import { tierHtml } from '../web/views/tier.js';
import { cardHtml } from '../web/views/card.js';

const here = dirname(fileURLToPath(import.meta.url));

test('★ 降级告警置顶：warnings 出现在榜单之前', () => {
  const html = leaderboardHtml({
    scope: 'rank',
    warnings: [{ code: 'judge_sample_too_small', message: '本轮该维度未做评委宽严归一化（样本不足 5）' }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  assert.ok(html.includes('judge_sample_too_small'), '告警必须渲染');
  assert.ok(html.indexOf('judge_sample_too_small') < html.indexOf('A队'), '告警必须排在榜单之前（置顶）');
});

test('榜单渲染并列名次与积分；队名必须转义', () => {
  const html = leaderboardHtml({
    scope: 'rank', warnings: [],
    rows: [
      { teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A', tiedWith: ['t_b'] },
      { teamId: 't_b', teamName: 'B队', rank: 1, total: 90, points: 8, tier: 'A', tiedWith: ['t_a'] },
      { teamId: 't_x', teamName: '<img src=x onerror=alert(1)>', rank: 2, total: 80, points: 0, tier: 'D' },
    ],
  });
  assert.ok(html.includes('A队'));
  assert.ok(html.includes('B队'));
  assert.ok(html.includes('10'));
  assert.ok(html.includes('8'));
  assert.ok(!html.includes('<img src=x'), '队名必须转义');
  assert.ok(html.includes('&lt;img'));
});

test('★ 段位榜：D 段不出现在榜单里；本人进度卡单独展示', () => {
  const html = tierHtml({
    rows: [
      { teamId: 't_s', teamName: 'S队', tier: 'S', tierRank: 1 },
      { teamId: 't_a', teamName: 'A队', tier: 'A', tierRank: 2 },
      // ⚠️ 队名同样可能带 HTML → 段位榜也必须转义
      { teamId: 't_x', teamName: '<img src=x onerror=alert(1)>', tier: 'B', tierRank: 3 },
    ],
    selfProgress: { teamId: 't_d', tier: 'D', progress: { milestones: [{ key: 'k', label: '企业问题确认' }] } },
  });
  assert.ok(html.includes('S队'));
  assert.ok(html.includes('A队'));
  assert.ok(!html.includes('D队'), 'D 段队名不得出现在段位榜');
  assert.ok(html.includes('本人进度'), 'D 段只给本人进度卡');
  assert.ok(!html.includes('<img src=x'), '段位榜队名必须转义');
  assert.ok(html.includes('&lt;img'));
});

test('★ 战绩卡：里程碑勾选式 + 企业签字标识，不出现签字人字段', () => {
  const html = cardHtml({
    teamName: 'A队', tier: 'A',
    items: [
      { key: 'problem_confirmed', label: '企业问题确认', achieved: true, signed: true },
      { key: 'data_connected', label: '真实数据接入', achieved: false, signed: false },
      // ⚠️ 里程碑标签也可能来自企业自定义 → 同样必须转义
      { key: 'x', label: '<img src=x onerror=alert(1)>', achieved: false, signed: false },
    ],
    benefits: ['辅导期名额候选'], neverUnlocks: ['奖金', '决赛名次'],
  });
  assert.ok(html.includes('企业问题确认'));
  assert.ok(html.includes('真实数据接入'));
  assert.ok(html.includes('已签'), '企业签字标识要显示');
  assert.ok(!html.includes('signatory'), '不得渲染签字人字段');
  assert.ok(!html.includes('签字人'));
  assert.ok(html.includes('辅导期名额候选'));
  assert.ok(!html.includes('<img src=x'), '里程碑标签必须转义');
  assert.ok(html.includes('&lt;img'));
});

test('前端不做过滤：渲染函数只输出 API 给的数据', () => {
  assert.ok(leaderboardHtml({ scope: 'rank', warnings: [], rows: [] }).includes('暂无数据'));
});

test('app.js 注册了榜单 / 段位 / 战绩卡路由', () => {
  const src = readFileSync(join(here, '..', 'web', 'app.js'), 'utf8');
  assert.ok(src.includes("route('/leaderboard"), '缺榜单路由');
  assert.ok(src.includes("route('/tier"), '缺段位路由');
  assert.ok(src.includes("route('/card/:teamId'"), '缺战绩卡路由');
});

test('★ app.js 必须把路由参数与 query 透传给视图', () => {
  const src = readFileSync(join(here, '..', 'web', 'app.js'), 'utf8');
  assert.ok(src.includes('params: found.params'), '视图拿不到路由参数（stageId / teamId）');
  assert.ok(src.includes('query: currentQuery()'), '视图拿不到 query（scope / editionId）');
  assert.ok(src.includes('function currentQuery()'), '必须自己解析 hash 上的 query');
});

test('★ 演示版适配器：段位榜分支必须排在赛段榜分支之前', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  const { api } = await import('../web/api.demo.js');
  const tier = await api.get('/api/leaderboard/tier');
  assert.equal(tier.scope, 'tier', '段位榜不能被赛段榜分支吃掉');
  const rolling = await api.get('/api/leaderboard/rolling');
  assert.equal(rolling.scope, 'rolling');
  const stage = await api.get('/api/leaderboard/st_1?scope=business');
  assert.equal(stage.scope, 'business');
  const card = await api.get('/api/teams/t_a/performance-card');
  assert.ok(Array.isArray(card.items), '战绩卡要有 items');
});

test('★ 转义必须复用 web/escape.js（全站唯一入口），视图不得各写一份', () => {
  for (const f of ['leaderboard.js', 'tier.js', 'card.js']) {
    const src = readFileSync(join(here, '..', 'web', 'views', f), 'utf8');
    assert.ok(src.includes("from '../escape.js'"), `${f} 必须复用 web/escape.js`);
    assert.ok(!/export function escapeHtml/.test(src), `${f} 不得重复定义 escapeHtml（会与 P0 的实现漂移）`);
  }
});

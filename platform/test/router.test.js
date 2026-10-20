import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/http/router.js';

test('精确路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/me', () => 'me');
  assert.equal(r.match('GET', '/api/me').handler(), 'me');
});

test(':param 捕获路径段', () => {
  const r = createRouter();
  r.add('GET', '/api/teams/:teamId/members', (ctx) => ctx.params.teamId);
  const m = r.match('GET', '/api/teams/t_42/members');
  assert.equal(m.params.teamId, 't_42');
});

test('方法不匹配返回 null', () => {
  const r = createRouter();
  r.add('POST', '/api/teams', () => 1);
  assert.equal(r.match('GET', '/api/teams'), null);
});

test('路径不匹配返回 null', () => {
  const r = createRouter();
  r.add('GET', '/api/teams', () => 1);
  assert.equal(r.match('GET', '/api/team'), null);
});

test('注册顺序不影响匹配（静态段优先于参数段）：正序与反序注册结果一致', () => {
  // ⛔ 预审修正（C4-1）：原用例只测了一种注册顺序，而用例名承诺的是"注册顺序不影响"。
  //    现在两种注册顺序都断言同样的结果。
  const forward = createRouter();
  forward.add('GET', '/api/teams/me', () => 'static');
  forward.add('GET', '/api/teams/:id', () => 'param');
  const backward = createRouter();
  backward.add('GET', '/api/teams/:id', () => 'param');
  backward.add('GET', '/api/teams/me', () => 'static');
  for (const r of [forward, backward]) {
    assert.equal(r.match('GET', '/api/teams/me').handler(), 'static');
    assert.equal(r.match('GET', '/api/teams/other').handler(), 'param');
  }
});

test('URL 里的 query 不影响路径匹配', () => {
  const r = createRouter();
  r.add('GET', '/api/leaderboard', () => 'lb');
  assert.ok(r.match('GET', '/api/leaderboard?scope=rank'));
});

test('静态路由 /api/leaderboard/rolling 不会被参数路由 /api/leaderboard/:stageId 劫持', () => {
  // ⛔ 预审修正（C4-1）：原比较器把参数段多的排前面 → rolling 会被 :stageId 劫持 → 发榜取错数据。
  for (const build of [
    (r) => {
      r.add('GET', '/api/leaderboard/rolling', () => 'rolling');
      r.add('GET', '/api/leaderboard/:stageId', () => 'stage');
    },
    (r) => {
      r.add('GET', '/api/leaderboard/:stageId', () => 'stage');
      r.add('GET', '/api/leaderboard/rolling', () => 'rolling');
    },
  ]) {
    const r = createRouter();
    build(r);
    assert.equal(r.match('GET', '/api/leaderboard/rolling').handler(), 'rolling');
    assert.equal(r.match('GET', '/api/leaderboard/st1').handler(), 'stage');
  }
});

test('畸形百分号编码不抛异常，且不匹配该路由', () => {
  // ⛔ 预审修正（C4-2）：decodeURIComponent('%E0%A4%A') 抛 URIError，
  //    抛出到路由匹配之外会打死整个服务器进程（server.js 里 router.match 在 try 之外）。
  const r = createRouter();
  r.add('GET', '/api/teams/:teamId', () => 'team');
  assert.equal(r.match('GET', '/api/teams/%E0%A4%A'), null);
});

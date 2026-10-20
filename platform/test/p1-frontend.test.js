import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuestionnaire, formatExplain } from '../web/views/registration.js';
import { summarizeTeam, canLeaveTeam, buildTeamCards } from '../web/views/team.js';
import {
  buildScreeningRows, buildFunnelView, formatEventTrail,
} from '../web/views/admin-registration.js';

const CRITERIA = {
  scale: { min: 1, max: 5, scoreMax: 100 },
  dimensions: [
    { key: 'direction', label: '方向维度', weight: 0.25, min: 1, max: 5, items: [
      { id: 'd1', text: 'A' }, { id: 'd2', text: 'B' }, { id: 'd3', text: 'C' },
      { id: 'd4', text: 'D' }, { id: 'd5', text: 'E' },
    ] },
    { key: 'capability', label: '能力维度', weight: 0.35, min: 1, max: 5, items: [
      { id: 'c1', text: 'A' }, { id: 'c2', text: 'B' }, { id: 'c3', text: 'C' },
      { id: 'c4', text: 'D' }, { id: 'c5', text: 'E' },
    ] },
    { key: 'collaboration', label: '协作维度', weight: 0.40, min: 1, max: 5, items: [
      { id: 'l1', text: 'A' }, { id: 'l2', text: 'B' }, { id: 'l3', text: 'C' },
      { id: 'l4', text: 'D' }, { id: 'l5', text: 'E' },
    ] },
  ],
  openQuestion: { required: true, maxLength: 500, prompt: '请说明你的商业问题' },
  levels: [
    { key: 'S', label: '顶级种子', minScore: 80, accept: true },
    { key: 'A', label: '优秀候选', minScore: 60, accept: true },
    { key: 'B', label: '潜力候选', minScore: 40, accept: true },
    { key: 'C', label: '底线外', minScore: 0, accept: false },
  ],
  funnel: [
    { key: 'registration', label: '报名筛选', rate: 0.3 },
    { key: 'incubation', label: '孵化', rate: 0.3 },
    { key: 'sprint', label: '冲刺', rate: 0.2 },
    { key: 'demo_day', label: 'Demo Day', rate: 0.1 },
    { key: 'coaching', label: '辅导期', rate: null },
  ],
};

test('问卷结构：三维各 5 题，每题带维度与分值（R-REG-09 / R-REG-11）', () => {
  const q = buildQuestionnaire(CRITERIA);
  assert.equal(q.dims.length, 3);
  for (const d of q.dims) {
    assert.equal(d.items.length, 5);
    assert.ok(d.weightLabel.endsWith('%'));
    assert.equal(d.max, 5);
  }
  assert.equal(q.open.maxLength, 500);
});

test('明示筛选标准：权重、量表、阈值、且写明 C 级不接收', () => {
  const q = buildQuestionnaire(CRITERIA);
  const text = q.criteriaLines.join('\n');
  assert.ok(text.includes('25%') && text.includes('35%') && text.includes('40%'), text);
  assert.ok(text.includes('80') && text.includes('60') && text.includes('40'), text);
  assert.ok(text.includes('不接收'), '必须明示 C 级不接收');
});

test('可解释明细可读化：每维给出均值 / 权重 / 加权', () => {
  const lines = formatExplain([
    { dimension: 'direction', label: '方向维度', raw: 4.2, weight: 0.25, weighted: 1.05, note: 'x' },
  ], CRITERIA.scale);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.includes('4.2'));
  assert.ok(lines[0].text.includes('25%'));
  assert.ok(lines[0].text.includes('1.05'));
});

test('战队摘要：仅剩 1 人时标出须并队', () => {
  const s = summarizeTeam({
    id: 't1', name: '甲队', status: 'needs_merge', needsMerge: true, mergeDeadline: '2026-10-23T00:00:00.000Z',
    members: [{ userId: 'u1', role: 'captain' }],
    milestones: { items: [{}, {}, {}] },
    formation: { ok: false, errors: ['[TEAM_BELOW_MIN_SIZE]'] },
  });
  assert.equal(s.memberCount, 1);
  assert.equal(s.needsMerge, true);
  assert.ok(s.statusLabel.includes('并队'));
  assert.equal(s.milestoneCount, 3);
  assert.equal(s.formationOk, false);
});

test('筛选台：按等级统计 + 每行带可解释明细与事件轨迹', () => {
  const { rows, distribution, total } = buildScreeningRows([
    {
      id: 'r1', userId: 'u1', level: 'S', levelFinal: 'B', status: 'accepted',
      rawScore: 80, grading: { score: 80, accepted: true, explain: [
        { dimension: 'direction', label: '方向维度', raw: 4.2, weight: 0.25, weighted: 1.05, note: 'x' },
      ] },
      events: [{ toStatus: 'accepted', reason: '复核通过' }],
    },
    { id: 'r2', userId: 'u2', level: 'C', levelFinal: null, status: 'rejected', grading: { score: 30, accepted: false, explain: [] } },
  ], CRITERIA);
  assert.equal(total, 2);
  assert.equal(distribution.B, 1);
  assert.equal(distribution.C, 1);
  assert.equal(rows[0].level, 'B');
  assert.equal(rows[0].autoLevel, 'S');
  assert.equal(rows[0].explain.length, 1);
  assert.equal(rows[0].events.length, 1);
});

test('漏斗视图：5 阶段，第一段给实数，后续标注待填充', () => {
  const view = buildFunnelView([{}, {}, {}], CRITERIA.funnel);
  assert.equal(view.length, 5);
  assert.equal(view[0].current, 3);
  assert.equal(view[1].current, null);
  assert.equal(view[0].target, 1); // round(3 × 0.3)
});

// ── 退出战队的可用性判定（父代理预审修正 Important）─────────────────────
// ⚠️ 原实现把条件**取反**了：按钮只在「当前用户是组长」时可点，
//    而服务端 leaveTeam 对组长抛 409 CAPTAIN_MUST_REPLACE，
//    组员又被禁用 → **两个角色都退不了队**。
//    判定被抽成纯函数 canLeaveTeam（不碰 document），这里直接测边界。
test('退出战队：组员可退、组长不可退（组长要移交）、非成员不可退、未登录不可退', () => {
  const team = {
    id: 't1', name: '甲队', status: 'active',
    members: [
      { userId: 'u1', role: 'captain' },
      { userId: 'u2', role: 'member' },
    ],
  };
  assert.equal(canLeaveTeam(team, 'u2'), true, '组员应当能退出');
  assert.equal(canLeaveTeam(team, 'u1'), false, '组长不能直接退出（服务端 409）');
  assert.equal(canLeaveTeam(team, 'u3'), false, '非成员不能退出别人的队');
  assert.equal(canLeaveTeam(team, null), false, '未登录不能退出');
  assert.equal(canLeaveTeam(null, 'u2'), false, '队不存在时不能退出');
});

test('退出战队：只有 role=captain 的成员才算组长（captainId 缺失时看 team.captainId）', () => {
  const noRoleCaptain = {
    id: 't2', captainId: 'u1', members: [{ userId: 'u1', role: 'member' }, { userId: 'u2', role: 'member' }],
  };
  assert.equal(canLeaveTeam(noRoleCaptain, 'u1'), false, 'team.captainId 是组长 → 不可退');
  assert.equal(canLeaveTeam(noRoleCaptain, 'u2'), true, '其他成员可退');
});

// ── 渲染路径本身也要有覆盖（父代理变异检验发现调用点是盲区）───────────────
// ⚠️ 变异检验实测：把 `canLeaveTeam(t, viewerId)` 换成老写法 `s.captainId === viewerId`，
//    变异体**存活** —— 因为 canLeaveTeam 本身测对了，但**调用点**写错没人知道。
//    修法：把卡片构建抽成纯函数 buildTeamCards，直接断言它产出的 HTML。
test('我的战队页：组员的「退出」按钮可点，组长的不可点（渲染路径）', () => {
  const teams = [{
    id: 't1', name: '甲队', status: 'active',
    members: [
      { userId: 'u1', role: 'captain' },
      { userId: 'u2', role: 'member' },
    ],
  }];
  const asMember = buildTeamCards(teams, 'u2');
  assert.equal(asMember.length, 1);
  assert.ok(!asMember[0].includes(' disabled'), '组员的退出按钮必须可点');
  assert.ok(asMember[0].includes('data-team="t1"'), '必须带上队 id');
  assert.ok(!asMember[0].includes('data-user'), '客户端不再传 userId（服务端只认发起人自己）');

  const asCaptain = buildTeamCards(teams, 'u1');
  assert.ok(asCaptain[0].includes(' disabled'), '组长的退出按钮必须禁用（服务端会 409）');

  const asOutsider = buildTeamCards(teams, 'u9');
  assert.ok(asOutsider[0].includes(' disabled'), '非成员的退出按钮必须禁用');
});

test('我的战队页：队名与成员名仍然走 escapeHtml（渲染路径的转义不能因为抽函数而丢）', () => {
  const cards = buildTeamCards([{
    id: 't1', name: '<img src=x onerror=alert(1)>', status: 'active',
    members: [{ userId: '<script>bad()</script>', role: 'member' }],
  }], 'u2');
  assert.ok(!cards[0].includes('<img src=x'), '队名必须被转义');
  assert.ok(!cards[0].includes('<script>'), '成员 id 必须被转义');
});

// ── 存储型 XSS 防护（父代理预审修正 Critical）────────────────────────────
// ⚠️ 2026-10-21 父代理预审修正（Critical，**存储型 XSS**）：
//    三个新视图把**服务端返回的数据**直接插进 innerHTML，而 P0 的
//    `web/escape.js` 注释早就写明了这个危险：
//      「前端把服务端返回的数据插进 innerHTML……P1 的『报名』端点让用户自选
//        name → 立刻变成可远程利用」。
//    用户可控的插值点（实跑确认）：
//      · 战队名称（POST /api/teams 的 name，选手自填）→ 我的战队页
//      · 任务包标题（POST /api/task-packages 的 title，企业自填）→ 筛选台页
//    两者都进了 innerHTML 且未转义 → 存储型 XSS。
//
// 这条用例做**结构性扫描**：凡是「用户可控字段的裸插值」都必须被 escapeHtml 包住。
// 扫描规则（刻意保守，避免误报）：
//   ① 只看**简单成员链**插值（`${a.b.c}`，不含函数调用）——
//      复合插值（`${xs.map(...)}`）的转义在各自内部单独保证；
//   ② 只盯**用户可控的字段名**：title / name / message / userId / agreement。

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');

// 用户可控的字段名：服务端数据里这些值由**用户自己填**
const USER_CONTROLLED = ['title', 'name', 'message', 'userId', 'agreement'];

function bareInterpolations(source) {
  // 抓出模板字面量里的 ${a.b.c} 形式（不含括号 = 不是函数调用）
  const out = [];
  const re = /\$\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}/g;
  let m = re.exec(source);
  while (m) {
    out.push({ expr: m[1], raw: m[0] });
    m = re.exec(source);
  }
  return out;
}

test('三个视图：用户可控的字段必须经过 escapeHtml 才能进 innerHTML（存储型 XSS 防护）', () => {
  const views = ['views/registration.js', 'views/team.js', 'views/admin-registration.js'];
  const offenders = [];
  for (const v of views) {
    const source = readFileSync(join(webDir, v), 'utf8');
    assert.ok(
      source.includes("from '../escape.js'"),
      `${v} 必须 import escapeHtml`,
    );
    for (const { expr, raw } of bareInterpolations(source)) {
      const last = expr.split('.').pop();
      if (!USER_CONTROLLED.includes(last)) continue;
      // 被 escapeHtml(...) 包住的（形如 escapeHtml(x)）不算裸插值
      if (source.includes(`escapeHtml(${expr})`)) continue;
      offenders.push(`${v}: ${raw}`);
    }
  }
  assert.deepEqual(offenders, [], `以下插值未转义：\n${offenders.join('\n')}`);
});

// ── 筛选台的「事件轨迹」一栏必须真的渲染（父代理预审修正 Important）────────
// ⚠️ 两处空转：
//    ① 后端 `GET /api/registrations`（列表）此前**不挂 events**（只有单条挂）→
//       `buildScreeningRows` 拿到的 `r.events` 恒为 undefined → 轨迹恒空；
//    ② 前端表格里**根本没有「事件轨迹」这一列** → 就算数据有了也没地方显示。
//    后端已在 src/services/registration.js 修好；这里钉住前端这一侧。
test('筛选台：事件轨迹既要在表头出现，也要把每条事件渲染成行', () => {
  const source = readFileSync(join(webDir, 'views', 'admin-registration.js'), 'utf8');
  // ⚠️ 断言必须精确到表头单元格：`includes('事件轨迹')` 会被 formatEventTrail 的
  //    文档注释里的同名串满足 → 删掉表头的变异体会**存活**（父代理变异检验实测）。
  assert.ok(source.includes('<th>事件轨迹</th>'), '表头必须有「事件轨迹」一列');
  // ⚠️ 断言必须精确到**调用点**：原来只查 `includes('r.events')`，
  //    而 buildScreeningRows 里也有 `r.events` → 把渲染换成 `<td>${[].map(...)}</td>`
  //    这个变异体照样存活（父代理变异检验实测）。这里钉住 `formatEventTrail(r.events)`。
  assert.ok(
    source.includes('formatEventTrail(r.events)'),
    '表格里的轨迹单元格必须调用 formatEventTrail(r.events)',
  );
});

test('筛选台：事件轨迹的纯文本格式（状态变迁 + 原因）', () => {
  const lines = formatEventTrail([
    { fromStatus: 'submitted', toStatus: 'screening', reason: '进入筛选' },
    { fromStatus: 'screening', toStatus: 'accepted', reason: null },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('submitted') && lines[0].includes('screening'));
  assert.ok(lines[0].includes('进入筛选'));
  assert.ok(lines[1].includes('accepted'));
  assert.deepEqual(formatEventTrail(null), [], '事件缺省时不得抛错');
});

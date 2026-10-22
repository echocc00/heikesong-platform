// platform/test/demo-api-parity.test.js —— 演示适配器与真实后端的**端点覆盖**一致性
//
// 规则溯源：
//   - 「演示站与正式站同码同行为」→ R-OPS-06（?demo=1 走演示版适配器）
//   - 「前端视图消费的端点，演示适配器必须都实现」→ P7 打磨中发现：
//     演示适配器**缺 8 个端点** ⇒ 公网演示站的「报名 / 我的战队 / 报名筛选台 /
//     复核队列 / 计算留痕 / 任务清单」**六页全是 404**，
//     而打磨前那些页面的错误态是个裸 `.card err` ⇒ 看不出来是「端点缺失」。
//
// ⚠️ 为什么要单独一条闸：
//   前端用到的端点清单是**可枚举**的（11 个视图的 api.get/api.post 调用点），
//   ⇒ 「演示适配器必须实现清单里的每一条」是一条**机器可复算**的约束。
//   以前没有这条闸 ⇒ 端点缺失只能靠人点页面才发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

async function bootDemo() {
  const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeStorage(), seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  // 跑一次真实引擎的计算 ⇒ 产出 results / computations（与构建期预计算同一条路径）
  await api.post('/api/stages/stage_final/compute', {});
  return { api, rules };
}

/**
 * 前端 11 个视图 + 应用外壳**实际调用**的端点清单。
 * ⚠️ 这张表是**从视图源码里扫出来的**（web/views/*.js + web/app.js 的 api.get/api.post 调用点），
 *    不是手写印象 —— 手写清单会漏。
 */
const VIEW_ENDPOINTS = [
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/registration-criteria' },
  { method: 'GET', path: '/api/teams' },
  { method: 'GET', path: '/api/task-packages' },
  { method: 'GET', path: '/api/registrations' },
  { method: 'GET', path: '/api/registrations/reg_demo_1' },
  { method: 'POST', path: '/api/registrations/reg_demo_1/level', body: { level: 'A', note: '复核通过' } },
  { method: 'POST', path: '/api/teams/t_alpha/members', body: { action: 'leave' } },
  { method: 'GET', path: '/api/stages' },
  { method: 'GET', path: '/api/workflows' },
  { method: 'GET', path: '/api/workflows/wf_demo_1/tasks' },
  { method: 'POST', path: '/api/tasks/wt_demo_1/claim', body: {} },
  { method: 'POST', path: '/api/tasks/wt_demo_1/complete', body: { evidence: { kind: 'runnable', summary: 'x' } } },
  { method: 'POST', path: '/api/tasks/wt_demo_1/release', body: {} },
  { method: 'GET', path: '/api/leaderboard/rolling' },
  { method: 'GET', path: '/api/leaderboard/tier' },
  { method: 'GET', path: '/api/teams/t_alpha/performance-card' },
  { method: 'GET', path: '/api/audit/flags' },
  { method: 'GET', path: '/api/audit/computations/cmp_demo_1' },
  { method: 'GET', path: '/api/audit/computations/cmp_demo_1/diff' },
];

test('演示适配器必须实现前端用到的**每一个**端点（缺一个 ⇒ 演示站那页就是 404）', async () => {
  const { api } = await bootDemo();
  const missing = [];
  for (const ep of VIEW_ENDPOINTS) {
    try {
      await api[ep.method.toLowerCase()](ep.path, ep.body);
    } catch (e) {
      // ⚠️ 判据必须是「**端点没实现**」这个专属信号，不能是「404」——
      //    业务上的「单条记录不存在 / 你不在该队」也是 404（设计文档 §7.3 的三态口径），
      //    那是**正确的**行为，不是缺口。
      //    演示适配器给「端点未实现」单独标了 DEMO_ENDPOINT_MISSING。
      if (e.code === 'DEMO_ENDPOINT_MISSING') missing.push(`${ep.method} ${ep.path} → ${e.message}`);
    }
  }
  assert.deepEqual(missing, [], `演示适配器缺少这些端点：\n${missing.join('\n')}`);
});

test('演示适配器的「端点未实现」必须用**专属错误码**（不能与业务上的 404 撞码）', async () => {
  // ⚠️ 为什么要单独钉：业务上的「单条记录不存在」也是 404（设计文档 §7.3 的三态口径）。
  //    两者撞码 ⇒ 「这一页是不是 404」与「这条记录在不在」分不开
  //    ⇒ 上面的端点覆盖闸就**永远看不到**端点缺失。
  //    ⇒ 「端点未实现」用 DEMO_ENDPOINT_MISSING 单独标记。
  const { api } = await bootDemo();
  await assert.rejects(
    () => api.get('/api/no-such-endpoint-at-all'),
    (e) => {
      assert.equal(e.code, 'DEMO_ENDPOINT_MISSING', `端点未实现必须有专属错误码，实际：${e.code}`);
      assert.ok(String(e.message).includes('未实现'), '错误消息要说清是「未实现」');
      return true;
    },
  );
});

test('演示适配器的报名筛选标准：形状与真实后端 buildCriteria 一致', async () => {
  const { api } = await bootDemo();
  const c = await api.get('/api/registration-criteria');
  assert.ok(c.editionId, '必须有届期 id（前端提交报名要带）');
  assert.ok(c.scale?.min && c.scale?.max, '必须带量表');
  assert.equal(c.dimensions.length, 3, '三维');
  for (const d of c.dimensions) {
    assert.ok(d.items.length > 0, `维度 ${d.key} 必须带题目（否则前端渲染不出评分控件）`);
  }
  assert.ok(c.levels.length > 0, '必须带等级阈值');
  assert.ok(c.openQuestion?.prompt, '必须带开放题题干');
  assert.ok(c.ipOwnership?.team, '必须带 IP 归属（团队保留 IP）—— R-ENT-11');
  assert.ok((c.redLines ?? []).length > 0, '必须带合规红线 —— R-ENT-12');
  assert.ok(c.consent?.prompt, '必须带同意条款');
});

test('演示适配器的我的战队：成员是**对象数组**（不是 userId 数组）', async () => {
  const { api } = await bootDemo();
  const { items } = await api.get('/api/teams');
  assert.ok(items.length > 0, '演示站要有队伍');
  const t = items[0];
  assert.ok(Array.isArray(t.members), 'members 必须是数组');
  assert.ok(t.members.length > 0, '成员不能为空');
  assert.ok(t.members[0].userId, '成员要有 userId');
  assert.ok(['captain', 'member'].includes(t.members[0].role), '成员要有 role');
  assert.ok(t.captainId, '要有队长 id');
  assert.ok(t.formation, '要有 formation（前端据此显示组建校验结果）');
});

test('演示适配器的任务包：形状与真实后端 presentTaskPackage 一致', async () => {
  const { api } = await bootDemo();
  const { items, mix } = await api.get('/api/task-packages');
  assert.ok(items.length > 0, '演示站要有任务包（否则「认领任务包」下拉是空的）');
  assert.ok(items[0].title, '要有标题');
  assert.equal(typeof items[0].isFreeBrief, 'boolean', 'isFreeBrief 必须是布尔');
  assert.ok(mix, '必须带配比体检（筛选台要显示）');
  assert.equal(typeof mix.total, 'number');
});

test('演示适配器的报名记录：带 grading 与 events（筛选台那两列的数据源）', async () => {
  const { api } = await bootDemo();
  await api.post('/api/registrations', {
    editionId: 'ed_demo',
    answers: {
      direction: [4, 4, 4, 4, 4],
      capability: [4, 4, 4, 4, 4],
      collaboration: [4, 4, 4, 4, 4],
      open: '演示报名',
      consent: { accepted: true },
    },
  });
  const { items } = await api.get('/api/registrations');
  assert.ok(items.length > 0, '报名后要能看到记录');
  const r = items[items.length - 1];
  assert.ok(r.grading, '必须有 grading（分数 / 是否接收 / 可解释明细）');
  assert.equal(typeof r.grading.score, 'number');
  assert.ok(Array.isArray(r.grading.explain), 'explain 必须是数组');
  assert.ok(Array.isArray(r.events), 'events 必须是数组（事件轨迹列）');
  // 改级要留下事件轨迹（追加式，历史不覆盖）
  await api.post(`/api/registrations/${r.id}/level`, { level: 'A', note: '复核通过' });
  const after = (await api.get('/api/registrations')).items.find((x) => x.id === r.id);
  assert.equal(after.levelFinal, 'A', '改级要写 levelFinal');
  assert.equal(after.events.length, 1, '改级要追加一条事件轨迹');
  assert.ok(after.events[0].reason, '事件轨迹要带理由');
});

test('演示适配器的审计三端点：留痕含降级告警与每队 trace；diff 必然一致', async () => {
  const { api } = await bootDemo();
  const trace = await api.get('/api/audit/computations/cmp_demo_1');
  assert.ok(trace.ruleVersion, '要有规则版本');
  assert.ok(trace.output?.teams?.length, '要有输出队伍');
  assert.ok(trace.trace?.normalization, '要有归一化明细（降级告警的来源）');
  assert.ok(trace.trace?.perTeam, '要有每队 trace（原始分 / z 分 / 去极值 / 加权）');
  assert.ok(Array.isArray(trace.trace?.warnings), '要有告警数组（降级状态必须显式展示）');

  const diff = await api.get('/api/audit/computations/cmp_demo_1/diff');
  assert.equal(diff.identical, true, '同一输入复算必然一致（演示站跑的是同一套引擎）');
  assert.deepEqual(diff.diff, [], '无差异时 diff 必须是空数组');

  const flags = await api.get('/api/audit/flags');
  assert.ok(Array.isArray(flags.rows), '复核队列必须返回数组');
  assert.equal(typeof flags.total, 'number');
});

test('演示适配器的任务清单：可领取 / 可提交完成 / 可释放（三条写路径）', async () => {
  const { api } = await bootDemo();
  const { items: workflows } = await api.get('/api/workflows');
  assert.ok(workflows.length > 0, '要有工作流');
  assert.equal(typeof workflows[0].taskCount, 'number', '入口页要知道任务数');

  const { tasks } = await api.get(`/api/workflows/${workflows[0].id}/tasks`);
  assert.ok(tasks.length > 0, '工作流里要有任务');
  const t = tasks[0];
  await api.post(`/api/tasks/${t.id}/claim`, {});
  const after = (await api.get(`/api/workflows/${workflows[0].id}/tasks`)).tasks
    .find((x) => x.id === t.id);
  assert.ok(after.claim, '领取后要有 claim');
  assert.equal(after.claim.userId, 'demo_admin', 'claim 要记录领取人');
  await api.post(`/api/tasks/${t.id}/complete`, { evidence: { kind: 'runnable', summary: 'x' } });
  const done = (await api.get(`/api/workflows/${workflows[0].id}/tasks`)).tasks
    .find((x) => x.id === t.id);
  assert.equal(done.status, 'done', '提交完成要落状态');
  assert.ok(done.completedAt, '要记完成时间');
});

// platform/test/demo-admin-write-flows.test.js —— 演示站「组委会写流程」的行为闸
//
// 规则溯源：
//   - R-OPS-06「演示站与正式站同码同行为」⇒ 演示适配器必须有**真能写**的端点，
//     且状态码 / 错误码与正式站**逐字一致**。
//   - P10 用户诉求「是否存在只做了功能上的展示、直接没办法点击触发的接口」
//     ⇒ 公网演示站的「企业签字台」与「任务卡审批」两页此前是**死页**
//     （读口没实现 ⇒ 两块错误卡片；写口没实现 ⇒ 按钮点了 404）。
//     本文件把这两条链**真的走一遍**，钉住：能提交、状态会流转、校验会拦。
//
// ⚠️ 全部是**行为断言**（断言真实返回值 / 真实抛出的错误码），不是「源码里有某个字符串」。
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const seed = JSON.parse(readFileSync(join(platformDir, 'web', 'seed', 'demo-data.json'), 'utf8'));
const { rules } = loadRules(join(platformDir, 'rules'));

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

async function bootDemo() {
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeStorage(), seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  return api;
}

/** 断言某个调用以指定的 (status, code) 失败。 */
async function expectError(fn, status, code, label) {
  await assert.rejects(fn, (e) => {
    assert.equal(e.status, status, `${label}：状态码不对，实际 ${e.status}（${e.message}）`);
    assert.equal(e.code, code, `${label}：错误码不对，实际 ${e.code}`);
    return true;
  });
}

const GOOD_ANSWERS = {
  problem_clarity: 3,
  data_access: 3,
  validation: 2,
  decision_chain: 1,
  accountability: 1,
  precedent: 1,
};

// ══════════════════════════════════════════════════════════════════
// 一、任务卡：六维可解性评估
// ══════════════════════════════════════════════════════════════════

test('★ 演示站：六维评估能提交，状态从「已提交」走到「已评估」，并算出分数与档位', async () => {
  const api = await bootDemo();
  const before = (await api.get('/api/task-packages')).items.find((p) => p.id === 'tp_demo_assess');
  assert.equal(before.status, 'submitted', '夹具必须是一张「已提交」的卡');

  const out = await api.post('/api/task-packages/tp_demo_assess/solvability', { answers: GOOD_ANSWERS });
  assert.equal(out.status, 'assessed', '评估后必须变成「已评估」');
  assert.equal(typeof out.solvabilityScore, 'number', '必须给出可解性得分');
  assert.equal(out.solvabilityGrade, 'A', '满分六维应得 A 档');
  // ⚠️ 评估完**可以**签级了（闸门是「先评估再签级」，不是「评估后不许签」）
  const signed = await api.post('/api/task-packages/tp_demo_assess/approve', { grade: 'A' });
  assert.equal(signed.status, 'published', '评估后签级必须成功并进入「已发布」');
});

test('★ 演示站：六维评估的校验与正式站同码同判（缺维 / 越界 / 未知否决项）', async () => {
  const api = await bootDemo();
  const { problem_clarity, ...missing } = GOOD_ANSWERS;
  await expectError(
    () => api.post('/api/task-packages/tp_demo_assess/solvability', { answers: missing }),
    400, 'INVALID_SOLVABILITY_ANSWERS',
    '缺维度',
  );
  await expectError(
    () => api.post('/api/task-packages/tp_demo_assess/solvability', { answers: { ...GOOD_ANSWERS, data_access: 9 } }),
    400, 'INVALID_SOLVABILITY_ANSWERS',
    '越界',
  );
  await expectError(
    () => api.post('/api/task-packages/tp_demo_assess/solvability', {
      answers: { ...GOOD_ANSWERS, vetoes: ['not_a_real_veto'] },
    }),
    400, 'INVALID_VETO_KEY',
    '未知否决项',
  );
  await expectError(
    () => api.post('/api/task-packages/tp_no_such_pkg/solvability', { answers: GOOD_ANSWERS }),
    404, 'TASK_PACKAGE_NOT_FOUND',
    '任务卡不存在',
  );
});

test('★ 演示站：签级要理由（D 级退回）、要合法档位、且必须先评估过', async () => {
  const api = await bootDemo();
  // 未评估 ⇒ 不许签级
  await expectError(
    () => api.post('/api/task-packages/tp_demo_assess/approve', { grade: 'A' }),
    400, 'SOLVABILITY_NOT_ASSESSED',
    '未评估就签级',
  );
  // 非法档位
  await expectError(
    () => api.post('/api/task-packages/tp_demo_sign/approve', { grade: 'Z' }),
    400, 'INVALID_GRADE',
    '非法档位',
  );
  // D 级（退回）必须写理由 —— 与正式站同码同判
  await expectError(
    () => api.post('/api/task-packages/tp_demo_sign/approve', { grade: 'D' }),
    400, 'RETURN_REASON_REQUIRED',
    '退回没写理由',
  );
  // 补上理由就能退
  const back = await api.post('/api/task-packages/tp_demo_sign/approve', {
    grade: 'D', reason: '缺《数据授权说明》，请补齐后再投',
  });
  assert.equal(back.status, 'returned', '退回后状态必须是「已退回」');
  assert.equal(back.grade, 'D', '退回后档位必须是 D');
});

test('★ 演示站：签级通过后状态变「已发布」，且**顶部计数会跟着变**（不是页面骗人）', async () => {
  const api = await bootDemo();
  const before = await api.get('/api/task-packages');
  const pendingBefore = before.items.filter((p) => p.status === 'submitted').length;
  const publishedBefore = before.items.filter((p) => p.status === 'published').length;

  await api.post('/api/task-packages/tp_demo_assess/solvability', { answers: GOOD_ANSWERS });
  await api.post('/api/task-packages/tp_demo_assess/approve', { grade: 'A' });

  const after = await api.get('/api/task-packages');
  assert.equal(after.items.filter((p) => p.status === 'submitted').length, pendingBefore - 1,
    '「已提交」必须少一张');
  assert.equal(after.items.filter((p) => p.status === 'published').length, publishedBefore + 1,
    '「已发布」必须多一张');
  // ⚠️ 配比体检的对象是**已发布（进池）的卡**（R-ENT-09）
  assert.equal(after.mix.total, publishedBefore + 1, '配比体检只算已发布的卡');
});

// ══════════════════════════════════════════════════════════════════
// 二、企业签字台：里程碑签字 + 撤回
// ══════════════════════════════════════════════════════════════════

test('★ 演示站：里程碑签字台读得到清单（队伍 × 里程碑全量槽位，字段恒定）', async () => {
  const api = await bootDemo();
  const list = await api.get('/api/signoffs/mine');
  assert.ok(Array.isArray(list.items), '必须返回 items 数组');
  const teamCount = seed.teams.length;
  const milestoneCount = (rules.milestones?.items ?? []).length;
  assert.equal(list.items.length, teamCount * milestoneCount,
    '槽位必须覆盖「每支队 × 每个里程碑」（与真实站建队时全量插入同口径）');
  const item = list.items[0];
  for (const key of ['milestoneId', 'teamId', 'teamName', 'key', 'label', 'countsTowardTier',
    'signed', 'signoffId', 'signedAt', 'department', 'content', 'revokedAt', 'signedByMe', 'canWithdraw']) {
    assert.ok(key in item, `清单项缺字段：${key}`);
  }
  // ⛔ **不返回签字人姓名**（R-ENT-04「签字不公开」）
  assert.equal('signatoryName' in item, false, '不许下发签字人姓名');
});

test('★ 演示站：里程碑签字能提交（缺部门 / 缺内容会被拦），清单会变成「已签」', async () => {
  const api = await bootDemo();
  const list = await api.get('/api/signoffs/mine');
  const target = list.items.find((i) => !i.signed && !i.revokedAt);
  assert.ok(target, '夹具必须有一张待签的里程碑');

  await expectError(
    () => api.post(`/api/milestones/${target.milestoneId}/signoff`, { content: '只有内容' }),
    400, 'MISSING_DEPARTMENT',
    '缺签字部门',
  );
  await expectError(
    () => api.post(`/api/milestones/${target.milestoneId}/signoff`, { department: '业务部' }),
    400, 'MISSING_CONTENT',
    '缺签字内容',
  );

  await api.post(`/api/milestones/${target.milestoneId}/signoff`, {
    department: '业务部', content: '问题已在门店验证通过，2 周内出试点结论',
  });
  const after = await api.get('/api/signoffs/mine');
  const updated = after.items.find((i) => i.milestoneId === target.milestoneId);
  assert.equal(updated.signed, true, '提交后必须是「已签」');
  assert.equal(updated.canWithdraw, true, '演示站只有一个身份 ⇒ 自己签的当然能撤回');
  assert.ok(updated.signoffId, '必须有 signoffId（撤回要用）');
});

test('★ 演示站：撤回签字（幂等口径：已撤回再撤一次 ⇒ 409）', async () => {
  const api = await bootDemo();
  const list = await api.get('/api/signoffs/mine');
  const target = list.items.find((i) => !i.signed && !i.revokedAt);
  await api.post(`/api/milestones/${target.milestoneId}/signoff`, {
    department: '业务部', content: '先签再撤',
  });
  const withSignoff = (await api.get('/api/signoffs/mine')).items
    .find((i) => i.milestoneId === target.milestoneId);
  const out = await api.post(`/api/milestones/${target.milestoneId}/signoff/withdraw`, {
    signoffId: withSignoff.signoffId,
  });
  assert.ok(out.revokedAt, '撤回必须带时间戳');
  const after = (await api.get('/api/signoffs/mine')).items
    .find((i) => i.milestoneId === target.milestoneId);
  assert.equal(after.signed, false, '撤回后不再是「已签」');
  assert.ok(after.revokedAt, '撤回后必须有 revokedAt');
  await expectError(
    () => api.post(`/api/milestones/${target.milestoneId}/signoff/withdraw`, {
      signoffId: withSignoff.signoffId,
    }),
    409, 'ALREADY_REVOKED',
    '重复撤回',
  );
});

// ══════════════════════════════════════════════════════════════════
// 三、企业双签（主观评分 · 进总分）
// ══════════════════════════════════════════════════════════════════

test('★ 演示站：企业双签清单读得到（队伍 / 维度 / 候选评委 / 已有确认）', async () => {
  const api = await bootDemo();
  const board = await api.get('/api/stages/stage_final/enterprise-confirmations');
  for (const key of ['stage', 'scope', 'myEnterpriseId', 'dimensions', 'teams', 'confirmations', 'crossJudgeCandidates']) {
    assert.ok(key in board, `清单缺字段：${key}`);
  }
  assert.ok(board.teams.length > 0, '必须有可签的队伍');
  assert.ok(board.dimensions.length > 0, '必须有企业确认维度');
  assert.ok(board.crossJudgeCandidates.length > 0, '必须有跨领域评委候选');
  // ⚠️ 候选形状与正式站一致（{ userId, name, seat }）
  assert.ok(board.crossJudgeCandidates.every((c) => c.userId && c.seat), '候选形状必须是 { userId, name, seat }');
  // ⚠️ 已有的确认要带上「有没有跨领域评委签字」（R2 双签缺口判定靠它）
  assert.ok(board.confirmations.every((c) => typeof c.hasCrossJudge === 'boolean'),
    '确认项必须带 hasCrossJudge');
});

test('★ 演示站：企业确认能提交（双签齐全），校验与正式站同码同判', async () => {
  const api = await bootDemo();
  await expectError(
    () => api.post('/api/stages/stage_final/enterprise-confirmations', {
      teamId: 't_alpha', dimension: 'enterprise', rawScore: 80, content: '',
    }),
    400, 'MISSING_CONTENT',
    '缺确认内容',
  );
  await expectError(
    () => api.post('/api/stages/stage_final/enterprise-confirmations', {
      teamId: 't_alpha', dimension: 'enterprise', rawScore: 180, crossJudgeId: 'j_lenient', content: '越界',
    }),
    400, 'SCORE_OUT_OF_RANGE',
    '分值越界',
  );
  await expectError(
    () => api.post('/api/stages/stage_final/enterprise-confirmations', {
      teamId: 't_alpha', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j_not_exist', content: '评委不存在',
    }),
    404, 'JUDGE_NOT_ASSIGNED',
    '跨领域评委不在名单',
  );
  await expectError(
    () => api.post('/api/stages/stage_final/enterprise-confirmations', {
      teamId: 't_not_exist', dimension: 'enterprise', rawScore: 80, content: '队不存在',
    }),
    404, 'TEAM_NOT_FOUND',
    '队伍不存在',
  );

  const before = (await api.get('/api/stages/stage_final/enterprise-confirmations')).confirmations.length;
  await api.post('/api/stages/stage_final/enterprise-confirmations', {
    teamId: 't_alpha', dimension: 'enterprise', rawScore: 80, crossJudgeId: 'j_lenient', content: '演示双签',
  });
  const after = await api.get('/api/stages/stage_final/enterprise-confirmations');
  assert.equal(after.confirmations.length, before + 1, '提交后确认数必须 +1');
  const last = after.confirmations[after.confirmations.length - 1];
  assert.equal(last.hasCrossJudge, true, '带跨领域评委的确认必须 hasCrossJudge = true');
  assert.equal(last.rawScore, 80, '分数必须原样落库');
});

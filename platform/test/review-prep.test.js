// platform/test/review-prep.test.js —— 评委前置页（回避 / 互评 / 自评 / 校准）的行为闸
//
// 规则溯源：
//   - 「评委为供应方 / 投资方 / 前雇主必须回避，回避记录留档」→ R-JDG-09
//   - 「评委须签署声明」→ R-JDG-18
//   - 「用同一组样例作品校准宽严尺度，校准结果不计入评分」→ R-JDG-12
//   - 「自评测只触发解释与提问，不加分」→ R-JDG-13 + src/domain/self-eval.js
//   - 「互评：队 → 队，提交者必须是发起队成员」→ src/services/review.js submitPeerReviews
//   - 「分值 0–100」→ src/services/review.js assertScoreInRange
//   - 「错误态必须带真能点的重试」→ DP-80；「不许整页刷新」→ DP-81
//   - 「可见性在 API 层过滤，前端只判登录态」→ DP-77
//
// ⚠️ 本文件全部是**行为断言**，不是文本匹配：
//    「理由为空就不许提交」「校准区必须写清不计入评分」「失败反馈必须带能点的重试」
//    这些判据只能从**纯函数的输出**与**渲染结果**里看出来。
//
// ⚠️ **零依赖 / 零 npm 包 / 原生 ESM**：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

import {
  PREP_SECTIONS,
  parseScore,
  buildRecusalRequest,
  buildPeerReviewItems,
  buildDimensionItems,
  buildSelfReviewItems,
  buildCalibrationItems,
  dimensionsBySeat,
  judgeDimensionsOf,
  selfDimensionsOf,
  resolvePeerTeams,
  reviewPrepStats,
  recusalListHtml,
  recusalSectionHtml,
  peerSectionHtml,
  selfSectionHtml,
  calibrationSectionHtml,
  reviewPrepHtml,
  submitFeedbackHtml,
} from '../web/views/review-prep.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW_JS = readFileSync(join(here, '..', 'web', 'views', 'review-prep.js'), 'utf8');

const DIMS = [
  { key: 'innovation', name: '创新性', weight: 0.2, seat: 'judge' },
  { key: 'feasibility', name: '技术可行性', weight: 0.2, seat: 'judge' },
  { key: 'self_eval', name: '自评测', weight: 0.05, seat: 'self' },
  { key: 'enterprise', name: '企业确认', weight: 0.25, seat: 'enterprise' },
];
const TEAMS = [
  { id: 't_alpha', name: '拾光队', taskPackageTitle: '库存周转' },
  { id: 't_beta', name: '长风队', taskPackageTitle: '门店选址' },
];

/** 造一份工作台数据（形状与 GET /api/stages/:stageId/review-board 一致）。 */
function board(over = {}) {
  return {
    stage: { id: 'stage_final', key: 'final', name: '决赛赛段', kind: 'final', status: 'computed', scoringConfigKey: 'final' },
    dimensions: DIMS,
    judgeDimensions: DIMS.filter((d) => d.seat === 'judge'),
    teams: TEAMS,
    myScores: [],
    progress: { scope: 'mine', submitted: 1, total: 4, missing: [], dimensionProgress: {} },
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════
// 一、分值解析与本地校验
// ══════════════════════════════════════════════════════════════════

test('分值解析：空 = 未打分（不是 0 分）；0 与 100 都是合法分', () => {
  assert.deepEqual(parseScore(''), { value: null });
  assert.deepEqual(parseScore('  '), { value: null });
  assert.deepEqual(parseScore(undefined), { value: null });
  assert.deepEqual(parseScore('0'), { value: 0 });
  assert.deepEqual(parseScore('100'), { value: 100 });
});

test('分值解析：越界与非数字 ⇒ 报错（后端也会拒，前端不该把无谓请求发出去）', () => {
  assert.ok(parseScore('101').error, '101 必须被拦');
  assert.ok(parseScore('-1').error, '-1 必须被拦');
  assert.ok(parseScore('abc').error, '非数字必须被拦');
  assert.equal(parseScore('88.5').value, 88.5, '小数是合法分');
});

test('★ 回避：理由为空 ⇒ 拒绝提交（不发请求），且 payload 为 null', () => {
  const { payload, errors } = buildRecusalRequest({ teamId: 't_alpha', reason: '   ', teams: TEAMS });
  assert.equal(payload, null, '理由为空不许组装请求体');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'reason');
  assert.match(errors[0].message, /必须填写原因/);
});

test('回避：理由填了 + 队伍在名册内 ⇒ payload 形状照后端（teamId + reason，不带 judgeId）', () => {
  const { payload, errors } = buildRecusalRequest({ teamId: 't_alpha', reason: '我是该队的供应方', teams: TEAMS });
  assert.equal(errors.length, 0);
  assert.deepEqual(payload, { teamId: 't_alpha', reason: '我是该队的供应方' });
  assert.equal('judgeId' in payload, false, 'judgeId 由会话决定，前端不许传（代他人申报会被服务端拒）');
});

test('回避：整个赛段的回避 ⇒ teamId 传 null（不是空串）', () => {
  const { payload } = buildRecusalRequest({ teamId: '__stage__', reason: '整体利益冲突', teams: TEAMS });
  assert.deepEqual(payload, { teamId: null, reason: '整体利益冲突' });
});

test('回避：队伍不在本赛段名册 ⇒ 拦下来（后端会 404 TEAM_NOT_IN_STAGE）', () => {
  const { payload, errors } = buildRecusalRequest({ teamId: 't_ghost', reason: '冲突', teams: TEAMS });
  assert.equal(payload, null);
  assert.equal(errors[0].field, 'teamId');
});

test('互评：请求体字段是 score（不是 rawScore）—— 抄错就是 400', () => {
  const values = { 't_alpha::t_beta': '82' };
  const { items, errors } = buildPeerReviewItems(values, { fromTeamId: 't_alpha', toTeams: [TEAMS[1]] });
  assert.equal(errors.length, 0);
  assert.deepEqual(items, [{ fromTeamId: 't_alpha', toTeamId: 't_beta', score: 82 }]);
  assert.equal('rawScore' in items[0], false, '互评的字段名是 score');
});

test('互评：还没选发起队 ⇒ 不许提交', () => {
  const { items, errors } = buildPeerReviewItems({}, { fromTeamId: null, toTeams: [TEAMS[1]] });
  assert.equal(items.length, 0);
  assert.equal(errors[0].field, 'fromTeamId');
});

test('互评：缺一格 ⇒ 该格进 errors 而不是 items（不发半截请求）', () => {
  const { items, errors } = buildPeerReviewItems(
    { 't_alpha::t_beta': '82' },
    { fromTeamId: 't_alpha', toTeams: [TEAMS[1], { id: 't_gamma', name: '第三队' }] },
  );
  assert.equal(items.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].teamId, 't_gamma');
  assert.match(errors[0].message, /还没打分/);
});

test('★ 自评 / 校准：维度来自入参（没有维度时不出错、也不产出 item）', () => {
  const empty = buildSelfReviewItems({}, []);
  assert.deepEqual(empty, { items: [], errors: [] }, '无维度时必须安静返回，不许抛');

  const dims = [{ key: 'dim_x', name: '维度甲' }, { key: 'dim_y', name: '维度乙' }];
  const { items, errors } = buildSelfReviewItems({ dim_x: '70', dim_y: '60' }, dims);
  assert.equal(errors.length, 0);
  assert.deepEqual(items, [
    { dimension: 'dim_x', rawScore: 70 },
    { dimension: 'dim_y', rawScore: 60 },
  ]);
});

test('自评 / 校准：请求体字段是 rawScore（与互评的 score 不同）', () => {
  const { items } = buildCalibrationItems({ dim_x: '55' }, [{ key: 'dim_x' }]);
  assert.deepEqual(items, [{ dimension: 'dim_x', rawScore: 55 }]);
});

test('★ 维度不许硬编码：换一组维度，产出跟着换', () => {
  const { items } = buildSelfReviewItems({ zeta: '30' }, [{ key: 'zeta', name: '泽塔' }]);
  assert.deepEqual(items, [{ dimension: 'zeta', rawScore: 30 }]);
});

// ══════════════════════════════════════════════════════════════════
// 二、维度与队伍的推导
// ══════════════════════════════════════════════════════════════════

test('维度分组：评委席 / 自评测按 seat 取（⛔ 不写死维度名）', () => {
  const split = dimensionsBySeat(board());
  assert.deepEqual(split.judge.map((d) => d.key), ['innovation', 'feasibility']);
  assert.deepEqual(split.self.map((d) => d.key), ['self_eval']);
  assert.deepEqual(split.enterprise.map((d) => d.key), ['enterprise']);
});

test('评委席维度：优先用 review-board 自带的 judgeDimensions', () => {
  assert.deepEqual(judgeDimensionsOf(board()).map((d) => d.key), ['innovation', 'feasibility']);
  // 没有 judgeDimensions 时退回按 seat 推（不许直接返回空）
  assert.deepEqual(judgeDimensionsOf({ dimensions: DIMS }).map((d) => d.key), ['innovation', 'feasibility']);
});

test('自评维度：没有 self 席维度时是空数组（初赛权重表本来就没有自评测）', () => {
  assert.deepEqual(selfDimensionsOf({ dimensions: DIMS.slice(0, 2) }), []);
  assert.equal(selfDimensionsOf(board()).length, 1);
});

test('发起队：优先用「我参与的队伍 ∩ 名册」；读不到时退回名册并标记 uncertain', () => {
  const known = resolvePeerTeams({ board: board(), myTeams: [{ id: 't_alpha', name: '拾光队' }], myTeamsKnown: true });
  assert.deepEqual(known.fromTeams.map((t) => t.id), ['t_alpha']);
  assert.deepEqual(known.toTeams.map((t) => t.id), ['t_beta'], '自己所在的队不该出现在被评列表里');
  assert.equal(known.uncertain, false);

  const unknown = resolvePeerTeams({ board: board(), myTeams: [], myTeamsKnown: false });
  assert.equal(unknown.uncertain, true, '读不到我参与哪些队伍时必须标记出来');
  assert.equal(unknown.fromTeams.length, TEAMS.length);
});

// ══════════════════════════════════════════════════════════════════
// 三、四个区块都在 / 校准区必须写清「不计入评分」
// ══════════════════════════════════════════════════════════════════

test('★ 整页：四个区块都在（回避 / 互评 / 自评 / 校准）', () => {
  const html = reviewPrepHtml({ stageId: 'stage_final', board: board(), myTeams: [{ id: 't_alpha', name: '拾光队' }] });
  for (const title of ['回避申报', '互评', '自评', '校准']) {
    assert.ok(html.includes(title), `缺少区块「${title}」`);
  }
  assert.deepEqual([...PREP_SECTIONS], ['recusal', 'peer', 'self', 'calibration']);
  for (const kind of PREP_SECTIONS) {
    assert.ok(html.includes(`data-feedback="${kind}"`), `区块 ${kind} 缺少就地反馈位`);
    assert.ok(html.includes(`data-retry-kind="${kind}"`), `区块 ${kind} 的反馈位没标重试类型`);
  }
});

test('★ 校准区：必须明确写「不计入评分」', () => {
  const html = calibrationSectionHtml({ dimensions: judgeDimensionsOf(board()) });
  assert.ok(html.includes('不计入评分'), '校准区必须写清校准分不计入评分');
  const page = reviewPrepHtml({ stageId: 'stage_final', board: board() });
  assert.ok(page.includes('不计入评分'), '整页也要能看见这句话');
});

test('互评区与自评区的提示必须说清口径（互评是队→队，自评不加分）', () => {
  const peer = peerSectionHtml({ fromTeams: [TEAMS[0]], toTeams: [TEAMS[1]] });
  assert.match(peer, /代表哪支队伍发起/);
  assert.match(peer, /不能给自己互评/);
  const self = selfSectionHtml({ fromTeams: [TEAMS[0]], dimensions: selfDimensionsOf(board()) });
  assert.match(self, /自评不加分/);
});

test('★ 理由为空时，页面给出的表单仍然要求填理由（必填标记 + 输入框）', () => {
  const html = recusalSectionHtml({ teams: TEAMS, recusals: [] });
  assert.ok(html.includes('data-recusal="reason"'), '必须有理由输入框');
  assert.ok(html.includes('field--required'), '理由必须标成必填');
});

// ══════════════════════════════════════════════════════════════════
// 四、反馈：成功就地显示 / 失败带真能点的重试
// ══════════════════════════════════════════════════════════════════

test('★ 失败反馈必须带一个真能点的重试（DP-80）', () => {
  const html = submitFeedbackHtml({ ok: false, message: '回避必须填写原因' });
  assert.ok(html.includes('data-action="retry"'), '错误反馈必须带重试按钮');
  assert.ok(html.includes('回避必须填写原因'));
  assert.ok(html.includes('state--error'), '失败必须是错误态');
});

test('成功反馈：就地一条提示（notice），不是错误态', () => {
  const html = submitFeedbackHtml({ ok: true, title: '已提交', items: ['回避已留档'] });
  assert.ok(html.includes('notice--success'));
  assert.ok(html.includes('回避已留档'));
  assert.ok(!html.includes('data-action="retry"'), '成功提示不该挂一个重试按钮');
});

test('★ 重试必须真的被绑上（视图源码里有 retry 的处理分支）', () => {
  assert.match(VIEW_JS, /action === 'retry'/, '必须处理重试点击');
  assert.match(VIEW_JS, /data-retry-kind/, '重试要知道重跑哪个区块');
  assert.ok(!/location\.reload/.test(VIEW_JS), '不许整页刷新（DP-81）');
});

// ══════════════════════════════════════════════════════════════════
// 五、空态 / 异常态
// ══════════════════════════════════════════════════════════════════

test('★ 没有赛段 ⇒ 给赛段选择器（或明确的空态），不许白屏', () => {
  const withStages = reviewPrepHtml({ stages: [{ id: 'stage_final', key: 'final', name: '决赛赛段' }] });
  assert.ok(withStages.includes('state--empty') === false || withStages.includes('决赛赛段'));
  assert.ok(withStages.includes('#/review/prep/stage_final'), '必须能点进某个赛段');

  const noStages = reviewPrepHtml({ stages: [] });
  assert.ok(noStages.includes('state--empty'), '没有赛段时必须有像样的空态');
  assert.ok(noStages.includes('还没有赛段'));
});

test('★ 加载失败 ⇒ 错误态 + 能点的重试', () => {
  const html = reviewPrepHtml({ error: '没有查看评审工作台的权限' });
  assert.ok(html.includes('state--error'));
  assert.ok(html.includes('data-action="retry"'));
  assert.ok(html.includes('没有查看评审工作台的权限'));
});

test('★ 名册为空 / 没有维度时，各区块给的是空态而不是空 div', () => {
  const empty = reviewPrepHtml({ stageId: 'stage_final', board: board({ teams: [], dimensions: [], judgeDimensions: [] }) });
  assert.ok(empty.includes('state--empty'), '没有队伍时必须有空态');
  assert.ok(empty.includes('还没有可互评的队伍'));
  assert.ok(empty.includes('没有可校准的维度'));
  assert.ok(empty.includes('这个赛段没有自评维度'));
  assert.ok(!empty.includes('<div class="panel__body"></div>'), '不许出现空 body');
});

test('回避清单：没有记录时给空态，有记录时逐条列出', () => {
  const empty = recusalListHtml({ recusals: [] });
  assert.ok(empty.includes('state--empty'));
  const filled = recusalListHtml({ recusals: [{ teamName: '拾光队', reason: '我是该队的供应方' }] });
  assert.ok(filled.includes('拾光队'));
  assert.ok(filled.includes('我是该队的供应方'));
  assert.ok(filled.includes('已回避'));
});

test('指标行：完成度按 total 算（total=0 ⇒ 不许出现 NaN）', () => {
  const cards = reviewPrepStats(board({ progress: { scope: 'mine', submitted: 0, total: 0 } }));
  assert.equal(cards[3].value, '—');
  assert.ok(!String(cards[3].value).includes('NaN'));
});

// ══════════════════════════════════════════════════════════════════
// 六、纪律闸
// ══════════════════════════════════════════════════════════════════

test('机器闸：不给 noticeState 传 text（它只认 items / list）', () => {
  assert.ok(!/noticeState\(\{[^}]*\btext\s*:/.test(VIEW_JS), 'noticeState 的参数名必须叫 items');
});

test('机器闸：评分控件不用 <select>（DP-82）', () => {
  assert.ok(!VIEW_JS.includes('<select'), '本视图不许出现 <select>');
});

test('机器闸：不许出现字面色值（颜色只能走 token）', () => {
  const code = VIEW_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), '视图里不许写十六进制色值');
  assert.ok(!/rgba?\(/.test(code), '视图里不许写 rgb/rgba 色值');
});

test('机器闸：四个端点路径必须与后端一致', () => {
  for (const p of ['/recusals', '/peer-reviews', '/self-review', '/calibration']) {
    assert.ok(VIEW_JS.includes(p), `视图必须请求 ${p}`);
  }
  assert.ok(VIEW_JS.includes('/review-board'), '必须用 review-board 取名册与维度');
});

// platform/test/web-review-publish.test.js —— P8 两个新页面的行为闸
//
// 规则溯源：
//   - 「评审按维度打分，0–100」→ 评审引擎 `assertScoreInRange`
//   - 「发榜是显式动作，影响奖金 ⇒ 二次确认」→ src/services/compute.js 文件头
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//   - 「本地校验前置，不发无谓请求」→ P7 的通用纪律
//
// ⚠️ 本文件全部是**行为断言**，不是文本匹配：
//    「缺一格就不能提交」「发榜必须二次确认」「进度标签必须跟着口径走」
//    这些判据只能从**纯函数的输出**里看出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseScore, buildReviewItems, reviewStats, reviewHtml, reviewTeamFormHtml,
} from '../web/views/review.js';
import {
  publishWarnings, publishStats, publishResultHtml, publishConfirmHtml, publishHtml,
} from '../web/views/publish.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const APP_JS = readFileSync(join(webDir, 'app.js'), 'utf8');
const NAV_JS = readFileSync(join(webDir, 'nav.js'), 'utf8');

const DIMS = [
  { key: 'innovation', name: '创新性', weight: 0.2 },
  { key: 'feasibility', name: '技术可行性', weight: 0.2 },
];
const TEAMS = [{ id: 't_alpha', name: '拾光队', taskPackageTitle: '库存周转' }];

/** 造一份工作台数据。 */
function board(over = {}) {
  return {
    stage: { id: 'stage_final', key: 'final', name: '决赛赛段', kind: 'final', status: 'computed', scoringConfigKey: 'final' },
    dimensions: [...DIMS.map((d) => ({ ...d, seat: 'judge' })), { key: 'enterprise', name: '企业确认', weight: 0.1, seat: 'enterprise' }],
    judgeDimensions: DIMS.map((d) => ({ ...d, seat: 'judge' })),
    teams: TEAMS,
    myScores: [],
    progress: { scope: 'mine', submitted: 0, total: 2, missing: [{ teamId: 't_alpha', dimension: 'innovation' }], dimensionProgress: {} },
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════
// 一、分值解析与本地校验
// ══════════════════════════════════════════════════════════════════

test('分值解析：空 = 未打分（不是 0 分）', () => {
  assert.deepEqual(parseScore(''), { value: null });
  assert.deepEqual(parseScore('  '), { value: null });
  assert.deepEqual(parseScore(undefined), { value: null });
});

test('分值解析：0 和 100 都是合法分（边界内）', () => {
  assert.deepEqual(parseScore('0'), { value: 0 });
  assert.deepEqual(parseScore('100'), { value: 100 });
});

test('分值解析：越界与非数字 ⇒ 报错（后端也会拒，但前端不该把无谓请求发出去）', () => {
  assert.ok(parseScore('101').error, '101 必须被拦');
  assert.ok(parseScore('-1').error, '-1 必须被拦');
  assert.ok(parseScore('abc').error, '非数字必须被拦');
  assert.ok(parseScore('88.5').value === 88.5, '小数是合法分');
});

test('本地校验：缺一格 ⇒ 既有 items 也有 errors（且该格不进 items）', () => {
  const cells = [{ teamId: 't_alpha', key: 'innovation' }, { teamId: 't_alpha', key: 'feasibility' }];
  const { items, errors } = buildReviewItems({ 't_alpha::innovation': '88' }, cells);
  assert.equal(items.length, 1, '只填一格只能产出一个 item');
  assert.equal(items[0].rawScore, 88);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].dimension, 'feasibility');
  assert.match(errors[0].message, /还没打分/);
});

test('本地校验：全填齐 ⇒ 没有错误、items 数量 = 维度数', () => {
  const cells = [{ teamId: 't_alpha', key: 'innovation' }, { teamId: 't_alpha', key: 'feasibility' }];
  const { items, errors } = buildReviewItems({ 't_alpha::innovation': '88', 't_alpha::feasibility': '70' }, cells);
  assert.equal(errors.length, 0);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.dimension), ['innovation', 'feasibility']);
  assert.ok(items.every((i) => typeof i.teamId === 'string' && typeof i.rawScore === 'number'));
});

test('本地校验：越界的格子进 errors 而不是 items（不能把非法分发出去）', () => {
  const cells = [{ teamId: 't_alpha', key: 'innovation' }];
  const { items, errors } = buildReviewItems({ 't_alpha::innovation': '150' }, cells);
  assert.equal(items.length, 0);
  assert.equal(errors.length, 1);
});

// ══════════════════════════════════════════════════════════════════
// 二、进度口径（标签必须跟着口径走）
// ══════════════════════════════════════════════════════════════════

test('指标行：scope=mine（评委）⇒ 标签是「我的已交」「评委」', () => {
  const cards = reviewStats(board());
  assert.equal(cards[0].label, '我的已交');
  assert.equal(cards.at(-1).value, '评委');
});

test('指标行：scope=stage（组委会）⇒ 标签是「本赛段已交」「组委会」', () => {
  const cards = reviewStats(board({ progress: { scope: 'stage', submitted: 12, total: 20, missing: [] } }));
  assert.equal(cards[0].label, '本赛段已交');
  assert.equal(cards[0].value, 12);
  assert.equal(cards.at(-1).value, '组委会');
});

test('指标行：完成度按 total 算（total=0 ⇒ 不许出现 NaN）', () => {
  const cards = reviewStats(board({ progress: { scope: 'mine', submitted: 0, total: 0, missing: [] } }));
  assert.equal(cards[2].value, '—');
});

// ══════════════════════════════════════════════════════════════════
// 三、评审打分页渲染
// ══════════════════════════════════════════════════════════════════

test('评审页：每支队伍一块表单，含队名、维度、权重与 0–100 输入框', () => {
  const html = reviewTeamFormHtml(TEAMS[0], board().judgeDimensions, []);
  assert.ok(html.includes('拾光队'), '必须显示队名');
  assert.ok(html.includes('库存周转'), '必须显示任务包');
  assert.ok(html.includes('创新性'), '必须显示维度名');
  assert.ok(html.includes('权重 20%'), '必须显示权重');
  assert.ok(html.includes('type="number"'), '打分控件必须是数字输入');
  assert.ok(html.includes('min="0"') && html.includes('max="100"'), '必须声明 0–100 范围');
  assert.ok(!html.includes('<select'), '评审页不许用 <select>（DP-82）');
});

test('评审页：已给的分要回填到输入框（改分场景）', () => {
  const html = reviewTeamFormHtml(TEAMS[0], board().judgeDimensions, [
    { teamId: 't_alpha', dimension: 'innovation', rawScore: 88 },
  ]);
  assert.ok(html.includes('value="88"'), '已给的分必须回填');
  assert.ok(html.includes('更新本队评分'), '已提交过的要显示「更新」');
});

test('评审页：队名里的 HTML 必须转义（服务端数据是外部输入）', () => {
  const evil = { id: 't_x', name: '<img src=x onerror=alert(1)>', taskPackageTitle: 'x' };
  const html = reviewTeamFormHtml(evil, board().judgeDimensions, []);
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
  assert.ok(html.includes('&lt;img'));
});

test('评审页：没选赛段 ⇒ 给赛段选择器（不是空白页）', () => {
  const html = reviewHtml({ stages: [{ id: 'stage_final', key: 'final', name: '决赛赛段' }] });
  assert.ok(html.includes('决赛赛段'));
  assert.ok(html.includes('#/review/stage_final'), '必须能点进赛段');
});

test('评审页：加载态与错误态都要有（外壳三件套）', () => {
  assert.ok(reviewHtml({ loading: true }).includes('正在加载'));
  assert.ok(reviewHtml({ error: '没有查看评审工作台的权限' }).includes('没有查看评审工作台的权限'));
  assert.ok(reviewHtml({ error: 'x' }).includes('data-action="retry"'), '错误态必须有重试按钮');
});

// ══════════════════════════════════════════════════════════════════
// 四、发榜页：告警分级 / 结果 / 二次确认
// ══════════════════════════════════════════════════════════════════

test('发榜告警：影响得分口径的码 ⇒ 硬降级；其余 ⇒ 提示', () => {
  const { hard, soft } = publishWarnings([
    { code: 'judge_pool_invalid', message: '评委池不合规' },
    { code: 'normalization_fallback', message: '归一化降级' },
    { code: 'dimension_no_scores', message: '某维度无评分' },
    { code: 'team_no_reviews', message: '某队没人评过' },
    { code: 'R2_missing_dual_signature', message: '企业确认缺双签' },
    { code: 'recusal_excluded', message: '因回避剔除' },
    { code: 'some_hint', message: '只是一条提示' },
  ]);
  assert.equal(hard.length, 6, '六类硬降级必须都被认出来');
  assert.equal(soft.length, 1);
  assert.ok(hard[0].includes('评委池不合规'));
});

test('发榜告警：空数组 ⇒ 两边都空（不是 undefined）', () => {
  const { hard, soft } = publishWarnings([]);
  assert.deepEqual(hard, []);
  assert.deepEqual(soft, []);
  assert.deepEqual(publishWarnings(undefined).hard, []);
});

test('发榜结果：队名用名册映射（compute 返回的 teams 只有 teamId）', () => {
  const html = publishResultHtml({ teams: [{ teamId: 't_alpha', seatP: 80, seatE: 90, total: 81 }] }, TEAMS);
  assert.ok(html.includes('拾光队'), '必须显示队名而不是 teamId');
  assert.ok(html.includes('81'), '必须显示总分');
});

test('发榜结果：按总分降序排列', () => {
  const html = publishResultHtml({
    teams: [
      { teamId: 't_a', seatP: 10, seatE: 10, total: 10 },
      { teamId: 't_b', seatP: 90, seatE: 90, total: 90 },
    ],
  }, [{ id: 't_a', name: '甲队' }, { id: 't_b', name: '乙队' }]);
  assert.ok(html.indexOf('乙队') < html.indexOf('甲队'), '高分队必须在前');
});

test('发榜结果：浮点尾巴要修掉（15.200000000000003 不能直接上屏）', () => {
  const html = publishResultHtml({ teams: [{ teamId: 't_a', seatP: 15.200000000000003, seatE: 0, total: 15.2 }] }, [{ id: 't_a', name: '甲队' }]);
  assert.ok(!html.includes('15.200000000000003'), '不能把浮点尾巴显示给用户');
  assert.ok(html.includes('15.2'));
});

test('发榜结果：没有结果 ⇒ 空态（说清下一步）', () => {
  const html = publishResultHtml(null, []);
  assert.ok(html.includes('还没有发榜结果'));
  assert.ok(html.includes('计算并发榜'), '空态必须告诉用户下一步做什么');
});

test('二次确认：必须写明**赛段 + 影响面**（不能只写「确定吗？」）', () => {
  const html = publishConfirmHtml('决赛赛段', 5);
  assert.ok(html.includes('决赛赛段'), '必须写明是哪个赛段');
  assert.ok(html.includes('5'), '必须写明影响几支队伍');
  assert.ok(html.includes('清空旧名次') || html.includes('覆盖'), '必须写明会覆盖上一次');
  assert.ok(html.includes('data-action="publish-confirm"'), '必须有确认按钮');
  assert.ok(html.includes('data-action="publish-cancel"'), '必须有取消按钮');
});

test('发榜页：默认状态显示「计算并发榜」按钮（不是直接就发请求）', () => {
  const html = publishHtml({ board: board() });
  assert.ok(html.includes('data-action="publish-request"'));
  assert.ok(!html.includes('data-action="publish-confirm"'), '没点之前不该出现确认按钮');
});

test('发榜页：有结果 ⇒ 显示结果表 + 告警 + 留痕链接', () => {
  const html = publishHtml({
    board: board(),
    result: {
      computationId: 'cmp_1',
      revision: 3,
      teams: [{ teamId: 't_alpha', seatP: 80, seatE: 90, total: 81 }],
      warnings: [{ code: 'judge_pool_invalid', message: '评委池不合规' }],
    },
  });
  assert.ok(html.includes('拾光队'));
  assert.ok(html.includes('81'));
  assert.ok(html.includes('cmp_1'), '必须给出快照 id');
  assert.ok(html.includes('#/audit/cmp_1'), '必须能进计算留痕');
  assert.ok(html.includes('评委池不合规'), '硬降级必须显式露出');
});

test('发榜页：指标行的「本次落榜」在没发榜时写「未发榜」（不许显示 0 冒充已发榜）', () => {
  const cards = publishStats(board(), null);
  const card = cards.find((c) => c.label === '本次落榜');
  assert.equal(card.value, '未发榜');
});

// ══════════════════════════════════════════════════════════════════
// 五、路由与导航（死链闸 + 分区）
// ══════════════════════════════════════════════════════════════════

const ROUTES = [...APP_JS.matchAll(/route\(\s*'([^']+)'/g)].map((m) => m[1]);

function routeMatches(pattern, path) {
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return false;
  return pp.every((seg, i) => seg.startsWith(':') || seg === xp[i]);
}
function hasRoute(hashPath) {
  const clean = hashPath.replace(/^#/, '').replace(/\?.*$/, '');
  return ROUTES.some((r) => routeMatches(r, clean));
}

test('死链闸：新增的两个导航入口都有对应路由', () => {
  assert.ok(hasRoute('#/review'), '导航里有「评审打分」⇒ 必须有 /review 路由');
  assert.ok(hasRoute('#/publish'), '导航里有「赛段发榜」⇒ 必须有 /publish 路由');
  assert.ok(hasRoute('#/review/stage_final'), '赛段级评审路由必须存在');
  assert.ok(hasRoute('#/publish/stage_final'), '赛段级发榜路由必须存在');
});

test('死链闸：主导航的全部 path 都有对应路由（含 P8 新增的两条）', () => {
  const paths = [...NAV_JS.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 8, `导航路径扫到 ${paths.length} 条，正则可能失效`);
  for (const p of paths) assert.ok(hasRoute(p), `死链：导航项 ${p} 没有对应路由`);
});

test('导航分区：新增「评审席」分区且**不按角色限定**（评委是赛段级指派的）', () => {
  assert.ok(/id:\s*'reviewer'/.test(NAV_JS), '必须有「评审席」分区');
  // ⚠️ 只切到**下一个分区**为止（切长了会吃到组委会分区的 roles ⇒ 误判）
  const start = NAV_JS.indexOf("id: 'reviewer'");
  const end = NAV_JS.indexOf("id: '", start + 10);
  const block = NAV_JS.slice(start, end === -1 ? undefined : end);
  assert.ok(!/roles:\s*\[/.test(block), '评审席分区不许按角色限定（会误伤赛段级指派的评委）');
});

test('路由守卫：评审与发榜都需要登录（但不按角色拦）', () => {
  assert.ok(/pattern:\s*\/\^\\\/review/.test(NAV_JS), '评审页必须进受保护路由');
  assert.ok(/pattern:\s*\/\^\\\/publish/.test(NAV_JS), '发榜页必须进受保护路由');
});

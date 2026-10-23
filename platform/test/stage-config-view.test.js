// test/stage-config-view.test.js — 赛段配置与权重表页（组委会）
//
// 依据：设计文档 §9「组委会视角 → **赛段配置与权重表**」（IA 图第 883 行）
//   + §8「API 设计」+ §7.3「三态状态码」
//   + src/http/routes/stages.js（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）
//   + rules/scoring-initial.json（权重表与 judgePool 席构成约束）
//
// ⚠️ **这组用例为什么必须存在**：
//   P11 之前，后端六个写端点早就写好，前端却**一个界面都没有**
//   ⇒ 「写了没接线」：端点在产品里零调用方。
//   ⇒ 这组用例钉住的是**界面本身的行为**（不是端点通不通）：
//     ① 权重表看得见、且**按声明序**（不是按权重降序 —— 降序会把企业维度插进评委维度中间）；
//     ② 三种席位渲染成**不同**的标签，观察席必须写明「无投票权」；
//     ③ 名册为空 / 没派评委走**空态**而不是报错；
//     ④ 403 显示「没有权限」而不是空白页；
//     ⑤ 逆向路径（撤评委 / 退名册）必须**二次确认**且写明影响面；
//     ⑥ 服务端返回的用户数据**必须转义**。
//
// ⚠️ 另外钉住**端点契约**（静态读源文件，与 web-review-publish.test.js 读 app.js 同款）：
//   权重表端点是届期作用域的 `/api/editions/:editionId/scoring-configs`
//   （不是 global 的 `/api/scoring-configs` —— 那会造成「能改赛段、却读不到权重表」）。
//
// ⛔ 零依赖、零构建、node:test + ESM；只测**纯函数**（HTML 渲染函数），不起 HTTP 服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  editionPickerHtml,
  fmtStageTime,
  fmtWeight,
  judgeSeatHtml,
  judgeSeatLabel,
  pickCurrentEdition,
  removeJudgeConfirmHtml,
  removeTeamConfirmHtml,
  rosterHtml,
  stageConfigHtml,
  stageConfigPageHtml,
  stageCreateFormHtml,
  stageErrorText,
  stageKindLabel,
  stageListHtml,
  stageStatusLabel,
  toIso,
  toLocalInput,
  weightTableHtml,
} from '../web/views/stages.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW_SRC = readFileSync(join(here, '..', 'web', 'views', 'stages.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 测试夹具
//
// ⚠️ **时间夹具一律不带时区**（'2026-10-20T09:00:00' 而不是 '...Z'）：
//    Date.parse 会按**本地时间**解读无时区串 ⇒ 断言（"2026-10-20 09:00"）与时区无关，
//    不会在 CI 的另一台机器上飘。
// ─────────────────────────────────────────────────────────────────────────

/** 权重表（形状照 rules/scoring-initial.json；维度顺序 = **声明序**）。 */
const SCORING = {
  key: 'initial',
  id: 'scoring-initial',
  version: '2026-10-20',
  source: 'S7 §2.1 初赛权重表 + §3.1 评分公式',
  note: '初赛 wEnterprise=0.10 —— 依据权重表合计正好 100% 反推',
  judgePool: {
    minJudgesPerDimension: 7,
    minEnterpriseSeatShare: 0.30,
    maxExpertSeatShare: 0.50,
    votingSeats: ['judge', 'enterprise'],
    nonVotingSeats: ['observer'],
  },
  dimensions: [
    { key: 'track_fit', name: '赛题契合度', weight: 0.10, seat: 'judge' },
    { key: 'innovation', name: '创新性', weight: 0.20, seat: 'judge' },
    { key: 'feasibility', name: '技术可行性', weight: 0.20, seat: 'judge' },
    { key: 'completeness', name: '完成度', weight: 0.25, seat: 'judge' },
    { key: 'enterprise', name: '企业确认', weight: 0.10, seat: 'enterprise' },
    { key: 'collaboration', name: '团队协作', weight: 0.15, seat: 'judge' },
  ],
};

/** 第二个权重表（用来证明「页按 key 选表」，而不是永远显示第一张）。 */
const SCORING_FINAL = {
  key: 'final',
  id: 'scoring-final',
  version: '2026-10-20',
  source: 'S7 §3.1 决赛权重表',
  judgePool: { ...SCORING.judgePool },
  dimensions: [
    { key: 'innovation', name: '创新性', weight: 0.40, seat: 'judge' },
    { key: 'enterprise', name: '企业确认', weight: 0.60, seat: 'enterprise' },
  ],
};

/** 三个席位的评委（席构成各不相同 ⇒ 断言才有判别性）。 */
const JUDGES = [
  {
    id: 'sj_1', stageId: 'st_1', userId: 'u_judge1', seat: 'judge',
    scopeType: 'global', scopeId: null,
    assignedAt: '2026-10-20T09:00:00', conflictDeclaredAt: '2026-10-20T09:05:00', conflictDeclarationId: 'cd_1',
  },
  {
    id: 'sj_2', stageId: 'st_1', userId: 'u_ent1', seat: 'enterprise',
    scopeType: 'edition', scopeId: 'ed_2026',
    assignedAt: '2026-10-20T09:10:00', conflictDeclaredAt: null, conflictDeclarationId: null,
  },
  {
    id: 'sj_3', stageId: 'st_1', userId: 'u_obs1', seat: 'observer',
    scopeType: 'stage', scopeId: 'st_1',
    assignedAt: '2026-10-20T09:20:00', conflictDeclaredAt: '2026-10-20T09:21:00', conflictDeclarationId: 'cd_3',
  },
];

/** 评委候选池（页面用它把 userId 回填成姓名）。 */
const CANDIDATES = [
  { id: 'u_judge1', name: '陈砚秋', org: '青瓷研究院' },
  { id: 'u_ent1', name: '林望舒', org: '青瓷科技' },
  { id: 'u_obs1', name: '周叙白', org: '创业邦' },
  { id: 'u_new', name: '吴未名', org: '南山资本' },
];

/** 本届期队伍。 */
const TEAMS = [
  { id: 't_alpha', name: '拾光队', tier: 'A' },
  { id: 't_beta', name: '溯洄队', tier: 'B' },
];

/** 赛段（列表端点只给摘要：没有 freezeAt / scoringConfigKey）。 */
const STAGES = [
  { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00' },
  { id: 'st_2', key: 'final', name: '决赛评审', kind: 'final', status: 'open', startsAt: '2026-11-20T09:00:00', endsAt: '2026-11-28T18:00:00' },
];

const EDITIONS = [
  { id: 'ed_2025', name: '2025 届', city: '杭州', startsAt: '2025-03-01T00:00:00', endsAt: '2025-09-01T00:00:00' },
  { id: 'ed_2026', name: '2026 届', city: '深圳', startsAt: '2026-03-01T00:00:00', endsAt: '2026-12-01T00:00:00' },
];

// ══════════════════════════════════════════════════════════════════
// 一、权重表（只读）
// ══════════════════════════════════════════════════════════════════

test('权重表：多个维度按**声明序**渲染（不是按权重降序）', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  const order = ['赛题契合度', '创新性', '技术可行性', '完成度', '企业确认', '团队协作'];
  const positions = order.map((name) => html.indexOf(name));
  for (const [i, p] of positions.entries()) {
    assert.ok(p >= 0, `${order[i]} 必须出现在权重表里`);
    if (i > 0) {
      assert.ok(positions[i - 1] < p, `${order[i - 1]} 必须排在 ${order[i]} 前面（声明序）`);
    }
  }
  // ⛔ 声明序 ≠ 权重降序（降序会把「完成度 25%」提到最前、把「赛题契合度 10%」压到倒数第二）
  assert.ok(html.indexOf('赛题契合度') < html.indexOf('完成度'), '声明序里赛题契合度在完成度之前');
  assert.ok(html.indexOf('企业确认') > html.indexOf('完成度'), '企业席维度在评委席维度之后（保持席分组）');
});

test('权重表：权重百分比与合计都渲染出来', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  assert.ok(html.includes('10%'), '0.10 要显示成 10%');
  assert.ok(html.includes('25%'), '0.25 要显示成 25%');
  assert.ok(html.includes('合计'), '要给出权重合计');
  assert.ok(html.includes('100%'), '这张表合计正好 100%（六维之和）');
});

test('权重表：席构成约束按规则里的数值展示（企业席 ≥30% / 专家席 ≤50% / 每维最少 7 人）', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  assert.ok(html.includes('每维度最少评委数'), '要列出约束项');
  assert.ok(html.includes('30%'), '企业席最低占比 30%');
  assert.ok(html.includes('50%'), '专家席最高占比 50%');
  assert.ok(html.includes('有投票权的席'), '要说明哪些席有投票权');
  assert.ok(html.includes('无投票权的席'), '要说明哪些席没有投票权');
});

test('权重表：三种席位渲染成**不同**的标签，观察席明确写「无投票权」', () => {
  assert.equal(judgeSeatLabel('judge').label, '评委席');
  assert.equal(judgeSeatLabel('enterprise').label, '企业席');
  assert.equal(judgeSeatLabel('observer').label, '观察席 · 无投票权');
  // 三个标签必须互不相同 ⇒ 断言不是「同一个模板套三遍」
  const labels = new Set([judgeSeatLabel('judge').label, judgeSeatLabel('enterprise').label, judgeSeatLabel('observer').label]);
  assert.equal(labels.size, 3, '三种席位必须渲染成三个不同的标签');
  assert.equal(judgeSeatLabel('observer').voting, false, '观察席无投票权');
  assert.equal(judgeSeatLabel('judge').voting, true);
  assert.equal(judgeSeatLabel('enterprise').voting, true);
});

test('权重表：读的是当前赛段那一张（key 决定表，不是永远第一张）', () => {
  const html = weightTableHtml({ configs: [SCORING, SCORING_FINAL], scoringConfigKey: 'final' });
  assert.ok(html.includes('决赛权重表'), '应显示 final 那一张的来源');
  assert.ok(html.includes('40%'), 'final 表的创新性权重 40%');
  assert.ok(!html.includes('技术可行性'), 'initial 表的维度不该出现在 final 表里');
});

test('权重表：规则没加载 ⇒ 显示「规则未加载」，但**不阻断**其余面板', () => {
  const page = stageConfigPageHtml({
    configs: [],
    configsDegraded: true,
    stages: STAGES,
    editionId: 'ed_2026',
    editions: EDITIONS,
  });
  assert.ok(page.includes('规则未加载'), '降级时必须说「规则未加载」');
  assert.ok(page.includes('notice--warn'), '降级要给出可见告警');
  // 其余面板照常渲染
  assert.ok(page.includes('届期与赛段'), '赛段列表面板不能被降级带没');
  assert.ok(page.includes('评委席'), '评委席面板不能被降级带没');
  assert.ok(page.includes('名册'), '名册面板不能被降级带没');
});

test('权重表：规则加载了但这个键不在里面 ⇒ 「权重表未找到」（不是「规则未加载」）', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'final' });
  assert.ok(html.includes('权重表未找到'), '键缺失要说「权重表未找到」');
  assert.ok(html.includes('final'), '要点名是哪个键找不到');
  assert.ok(!html.includes('规则未加载'), '两种降级不能混为一谈');
});

test('权重表：**不知道当前用哪一张**（列表端点没返回键）≠「权重表未找到」', () => {
  const html = weightTableHtml({ configs: [SCORING, SCORING_FINAL], scoringConfigKey: '' });
  assert.ok(html.includes('还不知道'), '要说清是「不知道」而不是「没有」');
  assert.ok(!html.includes('权重表未找到'), '不能误报「权重表未找到」');
  assert.ok(html.includes('initial') && html.includes('final'), '要把可用的权重表列出来');
  assert.ok(html.includes('规则里可用的权重表'), '要有可用权重表清单');
});

test('权重表：权重表**只读** —— 页面不提供改权重的入口', () => {
  const html = weightTableHtml({ configs: [SCORING], scoringConfigKey: 'initial' });
  assert.ok(!html.includes('data-action="weight-update"'), '权重表不能有写入口');
  assert.ok(html.includes('rules/scoring-*.json'), '要说明改表的方式是改规则文件');
});

// ══════════════════════════════════════════════════════════════════
// 二、赛段列表与届期
// ══════════════════════════════════════════════════════════════════

test('赛段列表：代号 / 名称 / 类型 / 时间窗 / 状态都渲染出来', () => {
  const html = stageListHtml(STAGES, 'st_1');
  assert.ok(html.includes('initial'), '代号');
  assert.ok(html.includes('初赛评审'), '名称');
  assert.ok(html.includes('初赛'), '类型');
  assert.ok(html.includes('2026-10-20 09:00'), '时间窗起点');
  assert.ok(html.includes('2026-10-28 18:00'), '时间窗终点');
  assert.ok(html.includes('草稿'), '状态');
  assert.ok(html.includes('决赛评审'), '第二条赛段也要在列表里');
});

test('赛段列表：可以点选进入配置（委托用的 data-action）', () => {
  const html = stageListHtml(STAGES, 'st_1');
  assert.ok(html.includes('data-action="stage-select"'), '要有选择动作');
  assert.ok(html.includes('data-stage-id="st_2"'), '要带上赛段 id');
  // ⚠️ P12：选中的那个改成「左轨条目 + is-active + aria-current」，
  //    旧的「当前赛段」按钮文字没有了 ⇒ 断言改看这两个标记。
  assert.ok(html.includes('is-active'), '选中的那个要标出来');
  assert.ok(html.includes('aria-current="true"'), '选中的那个要告诉读屏器「你在这儿」');
});

test('赛段列表：一个赛段都没有 ⇒ 空态（不是报错）', () => {
  const html = stageListHtml([], '');
  assert.ok(html.includes('state--empty'), '要走空态');
  assert.ok(html.includes('本届期还没有赛段'));
  assert.ok(!html.includes('state--error'), '空 ≠ 错');
});

test('届期：默认当届（尚未结束的最早一届），不是最早的一届', () => {
  assert.equal(pickCurrentEdition(EDITIONS, '2026-06-01')?.id, 'ed_2026');
  // 全都结束了 ⇒ 退回最后一届
  assert.equal(pickCurrentEdition(EDITIONS, '2027-01-01')?.id, 'ed_2026');
  assert.equal(pickCurrentEdition([], '2026-06-01'), null);
});

test('届期选择器：渲染下拉，并回填当前届期', () => {
  const html = editionPickerHtml(EDITIONS, 'ed_2026');
  assert.ok(html.includes('id="stage-edition"'), '要有届期选择器');
  assert.ok(html.includes('data-stage="edition"'), '要能被委托监听');
  assert.ok(html.includes('2026 届'), '届期名要在选项里');
  assert.ok(html.includes('深圳'), '城市也要显示');
  assert.ok(html.includes('value="ed_2026" selected'), '当前届期要选中');
});

// ══════════════════════════════════════════════════════════════════
// 三、建段 / 改配置
// ══════════════════════════════════════════════════════════════════

test('建赛段表单：七项字段齐全 + 提交动作', () => {
  const html = stageCreateFormHtml({ draft: {}, configs: [SCORING] });
  for (const id of ['stage-new-key', 'stage-new-name', 'stage-new-kind', 'stage-new-config', 'stage-new-starts', 'stage-new-ends', 'stage-new-freeze']) {
    assert.ok(html.includes(`id="${id}"`), `建段表单必须有 ${id}`);
  }
  assert.ok(html.includes('data-action="stage-create-submit"'), '要有创建按钮');
  assert.ok(html.includes('初赛') && html.includes('决赛'), '赛段类型下拉要有枚举选项');
});

test('改赛段配置：**key 与 kind 建后不可改**（置灰，不是隐藏）', () => {
  const html = stageConfigHtml({
    stage: { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00', freezeAt: '', scoringConfigKey: 'initial' },
    draft: {},
    configs: [SCORING],
  });
  const keyField = html.slice(html.indexOf('id="stage-cfg-key"'), html.indexOf('id="stage-cfg-name"'));
  assert.ok(keyField.includes('disabled'), '代号输入框必须 disabled');
  const kindField = html.slice(html.indexOf('id="stage-cfg-kind"'), html.indexOf('id="stage-cfg-config"'));
  assert.ok(kindField.includes('disabled'), '类型下拉必须 disabled');
  // 可改的字段不能被置灰
  const nameField = html.slice(html.indexOf('id="stage-cfg-name"'), html.indexOf('id="stage-cfg-kind"'));
  assert.ok(!nameField.includes('disabled'), '名称可以改');
  assert.ok(html.includes('data-action="stage-update-submit"'), '要有保存按钮');
});

test('改赛段配置：没选赛段 ⇒ 空态引导', () => {
  const html = stageConfigHtml({ stage: null, draft: {}, configs: [] });
  assert.ok(html.includes('state--empty'));
  assert.ok(html.includes('先选一个赛段'));
});

test('改赛段配置：列表端点没返回冻结时间 / 权重表键时，页面如实说明（且这两项不被清空）', () => {
  const html = stageConfigHtml({
    // 列表端点的摘要形状：没有 freezeAt / scoringConfigKey
    stage: { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00', freezeAt: '', scoringConfigKey: '', freezeAtKnown: false, scoringConfigKeyKnown: false },
    draft: {},
    configs: [SCORING],
  });
  assert.ok(html.includes('没有随赛段列表返回'), '必须如实说明这两项没有回填');
  assert.ok(html.includes('不会被提交'), '必须说明没改动就不提交（不会误清空）');
});

test('类型 / 状态 / 席位的中文标签映射', () => {
  assert.equal(stageKindLabel('initial').label, '初赛');
  assert.equal(stageKindLabel('final').label, '决赛');
  assert.equal(stageKindLabel('roadshow').label, '路演');
  assert.equal(stageKindLabel('landing').label, '落地');
  assert.equal(stageKindLabel('nonsense').label, 'nonsense', '未知值原样透出，不静默吞掉');
  assert.equal(stageStatusLabel('draft').label, '草稿');
  assert.equal(stageStatusLabel('open').label, '进行中');
  assert.equal(stageStatusLabel('published').label, '已发榜');
});

// ══════════════════════════════════════════════════════════════════
// 四、评委席
// ══════════════════════════════════════════════════════════════════

test('评委席：姓名从候选池回填，三种席位渲染成不同标签', () => {
  const html = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {} });
  assert.ok(html.includes('陈砚秋'), '姓名要从候选池回填');
  assert.ok(html.includes('青瓷研究院'), '单位也要显示');
  assert.ok(html.includes('u_judge1'), 'userId 也要显示（回填不到时用户能自己认）');
  assert.ok(html.includes('评委席'), 'judge 席');
  assert.ok(html.includes('企业席'), 'enterprise 席');
  assert.ok(html.includes('观察席'), 'observer 席');
  assert.ok(html.includes('无投票权'), 'observer 必须写明无投票权');
  // 三种席位的徽章文案不同（不是同一个模板套三遍）
  assert.notEqual(html.indexOf('badge--brand'), html.indexOf('badge--info'), '评委席与企业席的色调要不同');
});

test('评委席：一个都没派 ⇒ 空态（不是报错）', () => {
  const html = judgeSeatHtml({ judges: [], candidates: CANDIDATES, draft: {} });
  assert.ok(html.includes('state--empty'), '要走空态');
  assert.ok(html.includes('还没有派评委'));
  assert.ok(!html.includes('state--error'), '空 ≠ 错');
});

test('评委席：派评委表单（选人 + 选席），已派的人不再出现在候选下拉里', () => {
  const html = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {} });
  assert.ok(html.includes('id="stage-judge-user"'), '要有选人的下拉');
  assert.ok(html.includes('id="stage-judge-seat"'), '要有选席的下拉');
  assert.ok(html.includes('data-action="judge-assign-submit"'), '要有派评委按钮');
  const select = html.slice(html.indexOf('id="stage-judge-user"'), html.indexOf('id="stage-judge-seat"'));
  assert.ok(!select.includes('value="u_judge1"'), '已派的人不该再出现在候选下拉里');
  assert.ok(select.includes('value="u_new"'), '没派的人应该在候选下拉里');
  assert.ok(select.includes('吴未名'), '候选要显示姓名');
});

test('评委席：席位下拉里观察席写明「无投票权」', () => {
  const html = judgeSeatHtml({ judges: [], candidates: CANDIDATES, draft: {} });
  const seatSelect = html.slice(html.indexOf('id="stage-judge-seat"'));
  assert.ok(seatSelect.includes('无投票权'), '选席时就要看清观察席没有投票权');
});

test('撤评委（逆向路径）：二次确认块写明席位失效 + 利益冲突声明被解除', () => {
  const html = removeJudgeConfirmHtml({ userId: 'u_judge1', name: '陈砚秋', stageName: '初赛评审' });
  assert.ok(html.includes('确认撤回该评委'), '要有二次确认');
  assert.ok(html.includes('data-action="judge-remove-confirm"'), '要有确认按钮');
  assert.ok(html.includes('data-action="judge-remove-cancel"'), '要有取消按钮');
  assert.ok(html.includes('席位'), '要说明席位失效');
  assert.ok(html.includes('利益冲突声明'), '要说明连带处理利益冲突声明');
  assert.ok(html.includes('陈砚秋'), '要点名是谁');
  assert.ok(html.includes('初赛评审'), '确认文案要写明是哪个赛段（影响面）');
});

test('撤评委：点了「撤评委」才出现确认块（确认块本身不是常驻的）', () => {
  const before = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {}, pending: null });
  assert.ok(!before.includes('data-stage-confirm="judge"'), '没点之前不出现确认块');
  const after = judgeSeatHtml({ judges: JUDGES, candidates: CANDIDATES, draft: {}, pending: { userId: 'u_judge1' } });
  assert.ok(after.includes('data-stage-confirm="judge"'), '点了之后出现确认块');
  assert.ok(after.includes('data-action="judge-remove-confirm"'), '确认按钮可用');
});

// ══════════════════════════════════════════════════════════════════
// 五、名册
// ══════════════════════════════════════════════════════════════════

test('名册：空名册 ⇒ 空态（不是报错），但登记入口仍然在（不能是死路）', () => {
  const html = rosterHtml({ teams: TEAMS, rosterTeamIds: [] });
  assert.ok(html.includes('state--empty'), '要走空态');
  assert.ok(html.includes('本赛段名册还是空的'));
  assert.ok(!html.includes('state--error'), '空 ≠ 错');
  // ⛔ 关键：名册为空时也得能登记（勾选框 + 提交按钮）
  assert.ok(html.includes('data-stage="roster-pick"'), '要有勾选框');
  assert.ok(html.includes('data-action="roster-register-submit"'), '要有登记按钮');
  assert.ok(html.includes('拾光队'), '候选队伍要列出来');
});

test('名册：在榜队伍被标记「在榜」，并显示队名与段位', () => {
  const html = rosterHtml({ teams: TEAMS, rosterTeamIds: ['t_alpha'] });
  assert.ok(html.includes('在榜'), '在榜队伍要有标记');
  assert.ok(html.includes('拾光队'), '队名');
  assert.ok(html.includes('溯洄队'), '没在榜的队伍也要列出来（可登记）');
  assert.ok(html.includes('>A<'), '段位要显示');
  assert.ok(html.includes('data-action="roster-remove-request"'), '在榜队伍要能退名册');
  // 只有在榜的那支才给退名册按钮
  const alphaRow = html.slice(html.indexOf('拾光队'), html.indexOf('溯洄队'));
  assert.ok(alphaRow.includes('退名册'), '在榜队伍有退名册入口');
  const betaRow = html.slice(html.indexOf('溯洄队'));
  assert.ok(!betaRow.includes('data-action="roster-remove-request"'), '不在榜的队伍不该有退名册入口');
});

test('名册：本届期一支队伍都没有 ⇒ 空态', () => {
  const html = rosterHtml({ teams: [], rosterTeamIds: [] });
  assert.ok(html.includes('state--empty'));
  assert.ok(html.includes('本届期还没有队伍'));
});

test('退名册（逆向路径）：二次确认块写明评分与确认失效', () => {
  const html = removeTeamConfirmHtml({ teamId: 't_alpha', name: '拾光队', stageName: '初赛评审' });
  assert.ok(html.includes('确认把该队伍退名册'), '要有二次确认');
  assert.ok(html.includes('data-action="roster-remove-confirm"'));
  assert.ok(html.includes('data-action="roster-remove-cancel"'));
  assert.ok(html.includes('评分与确认'), '要说明评分与确认失效');
  assert.ok(html.includes('失效'), '要写明影响面');
  assert.ok(html.includes('拾光队'), '要点名是哪支队伍');
});

test('退名册：点了「退名册」才出现确认块', () => {
  const before = rosterHtml({ teams: TEAMS, rosterTeamIds: ['t_alpha'], pending: null });
  assert.ok(!before.includes('data-stage-confirm="team"'));
  const after = rosterHtml({ teams: TEAMS, rosterTeamIds: ['t_alpha'], pending: { teamId: 't_alpha' } });
  assert.ok(after.includes('data-stage-confirm="team"'));
});

// ══════════════════════════════════════════════════════════════════
// 六、整页：状态码 / 反馈 / 转义
// ══════════════════════════════════════════════════════════════════

test('403 ⇒ 页面显示「没有权限」（而不是空白页，也不是通用「请求失败」）', () => {
  assert.ok(stageErrorText(403, '缺少能力：stage:compute').includes('权限'), '403 文案必须出现「权限」');
  assert.ok(stageErrorText(403).includes('权限'));
  assert.ok(!stageErrorText(403, 'x').includes('请求失败'));

  const page = stageConfigPageHtml({
    error: '缺少能力：stage:compute',
    errorStatus: 403,
    stages: STAGES,
    editions: EDITIONS,
    editionId: 'ed_2026',
  });
  assert.ok(page.includes('权限'), '页面上要出现「权限」');
  assert.ok(page.includes('state--error'), '错误态');
  assert.ok(page.includes('届期与赛段'), '出错时也不能是空白页（赛段列表仍要在）');
});

test('404 ⇒ 页面显示「不存在」', () => {
  assert.ok(stageErrorText(404, '赛段不存在').includes('不存在'));
  const page = stageConfigPageHtml({ error: '赛段不存在', errorStatus: 404, stages: [], editions: EDITIONS });
  assert.ok(page.includes('不存在'));
});

test('其它状态码 ⇒ 服务端的中文原因原样透出', () => {
  assert.equal(stageErrorText(400, '开始时间必须早于结束时间'), '开始时间必须早于结束时间');
  assert.equal(stageErrorText(null, ''), '加载失败，请重试。');
});

test('加载中 ⇒ 骨架屏（不是白屏）', () => {
  const page = stageConfigPageHtml({ loading: true });
  assert.ok(page.includes('state--loading'));
  assert.ok(page.includes('正在加载'));
});

test('成功反馈：noticeState 的参数是 **items 数组**（不是 text）', () => {
  const page = stageConfigPageHtml({
    stages: STAGES,
    editions: EDITIONS,
    editionId: 'ed_2026',
    feedback: { tone: 'success', title: '赛段已创建', items: ['赛段「初赛评审」已建好。', '新赛段是草稿状态。'] },
  });
  assert.ok(page.includes('notice--success'), '反馈条要有色调');
  assert.ok(page.includes('赛段已创建'), '标题');
  assert.ok(page.includes('赛段「初赛评审」已建好。'), 'items 的第一条必须渲染出来');
  assert.ok(page.includes('新赛段是草稿状态。'), 'items 的第二条必须渲染出来');
});

test('整页：六个面板都在（建段 / 改配置 / 权重表 / 评委席 / 名册 / 赛段列表）', () => {
  const page = stageConfigPageHtml({
    stages: STAGES,
    editions: EDITIONS,
    editionId: 'ed_2026',
    stage: { id: 'st_1', key: 'initial', name: '初赛评审', kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00', freezeAt: '', scoringConfigKey: 'initial' },
    configs: [SCORING],
    judges: JUDGES,
    candidates: CANDIDATES,
    teams: TEAMS,
    rosterTeamIds: ['t_alpha'],
  });
  for (const title of ['届期与赛段', '新建赛段', '赛段配置', '权重表（只读）', '评委席', '名册']) {
    assert.ok(page.includes(title), `整页必须「${title}」面板`);
  }
  // 六个写端点的动作都在页面上（端点不再零调用方）
  for (const action of ['stage-create-submit', 'stage-update-submit', 'judge-assign-submit', 'judge-remove-request', 'roster-register-submit', 'roster-remove-request']) {
    assert.ok(page.includes(`data-action="${action}"`), `页面上必须有「${action}」动作`);
  }
});

test('整页：服务端返回的用户数据必须转义（存储型 XSS 面）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const page = stageConfigPageHtml({
    stages: [{ id: 'st_evil', key: 'x', name: evil, kind: 'initial', status: 'draft', startsAt: '2026-10-20T09:00:00', endsAt: '2026-10-28T18:00:00' }],
    editions: EDITIONS,
    editionId: 'ed_2026',
    judges: [{ id: 'sj_x', stageId: 'st_evil', userId: 'u_x', seat: 'judge', scopeType: 'global', scopeId: null, assignedAt: '2026-10-20T09:00:00' }],
    candidates: [{ id: 'u_x', name: evil, org: 'x' }],
    teams: [{ id: 't_evil', name: evil, tier: 'A' }],
    rosterTeamIds: ['t_evil'],
  });
  assert.ok(!page.includes(evil), '原始 HTML 串不许出现在输出里');
  assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'), '必须转义后再插入');
});

// ══════════════════════════════════════════════════════════════════
// 七、时间与权重格式化
// ══════════════════════════════════════════════════════════════════

test('时间格式化：无时区串按本地时间读，非法值原样透出（不显示 Invalid Date）', () => {
  assert.equal(fmtStageTime('2026-10-20T09:00:00'), '2026-10-20 09:00');
  assert.equal(fmtStageTime(''), '');
  assert.equal(fmtStageTime('不是时间'), '不是时间');
});

test('datetime-local 回填与提交：toLocalInput ↔ toIso 同一时刻', () => {
  assert.equal(toLocalInput('2026-10-20T09:00:00'), '2026-10-20T09:00');
  assert.equal(toLocalInput(''), '');
  assert.equal(toLocalInput('不是时间'), '');
  const iso = toIso('2026-10-20T09:00:00');
  assert.equal(new Date(iso).getTime(), new Date('2026-10-20T09:00:00').getTime(), '转 ISO 不能改时刻');
  assert.equal(toIso(''), '');
});

test('权重格式化：0.2 → 20%，非法值 → —', () => {
  assert.equal(fmtWeight(0.2), '20%');
  assert.equal(fmtWeight(0.125), '12.5%');
  assert.equal(fmtWeight('不是数字'), '—');
});

// ══════════════════════════════════════════════════════════════════
// 八、端点契约（静态读源文件钉住 —— 与 web-review-publish.test.js 同款）
// ══════════════════════════════════════════════════════════════════

test('契约：权重表端点是**届期作用域**的 /api/editions/:editionId/scoring-configs', () => {
  assert.ok(
    VIEW_SRC.includes('/api/editions/${encodeURIComponent(state.editionId)}/scoring-configs'),
    '必须读届期作用域的权重表端点',
  );
  assert.ok(
    !VIEW_SRC.includes("get('/api/scoring-configs'") && !VIEW_SRC.includes('get("/api/scoring-configs"'),
    '不能用 global 作用域的 /api/scoring-configs（会造成「能改赛段、却读不到权重表」）',
  );
});

test('契约：视图用到的端点路径与约定一致', () => {
  for (const p of [
    "'/api/editions'",
    '/api/stages?editionId=',
    '/judges`',
    '/teams`',
    '/api/editions/${encodeURIComponent(state.editionId)}/teams',
    '/api/editions/${encodeURIComponent(state.editionId)}/judge-candidates',
  ]) {
    assert.ok(VIEW_SRC.includes(p), `端点路径 ${p} 必须出现在视图里`);
  }
});

test('契约：ctx.api 的方法名是 get / post / patch / **del**（不是 delete）', () => {
  for (const m of ['ctx.api.get(', 'ctx.api.post(', 'ctx.api.patch(', 'ctx.api.del(']) {
    assert.ok(VIEW_SRC.includes(m), `必须用 ${m}`);
  }
  assert.ok(!VIEW_SRC.includes('ctx.api.delete('), '本仓的 API 客户端没有 delete 方法，删除一律是 del');
  assert.ok(!VIEW_SRC.includes('ctx.api.remove('), '删除端点用的是 del');
});

test('契约：视图是浏览器可 import 的纯 ESM（不 import 任何 Node 内置模块）', () => {
  assert.ok(!/from\s+['"]node:/.test(VIEW_SRC), '不许 import node: 内置模块');
  assert.ok(VIEW_SRC.includes("from '../escape.js'"), '转义必须走全站唯一入口');
  assert.ok(VIEW_SRC.includes("from '../ui.js'"), '组件必须用 web/ui.js 里现成的');
});

test('契约：不许自造 CSS 类名（只用仓库里已有的类）', () => {
  // 视图里出现的 class 名必须都在 web/styles.css 里存在
  const css = readFileSync(join(here, '..', 'web', 'styles.css'), 'utf8');
  const used = new Set();
  for (const m of VIEW_SRC.matchAll(/class="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) used.add(cls);
  }
  const missing = [...used].filter((cls) => !new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}[^\\w-]`).test(css));
  assert.deepEqual(missing, [], `这些 class 在 styles.css 里不存在：${missing.join(', ')}`);
});

test('⛔ 契约：用户可见文案里**不许**出现 markdown 星号（`**`）', () => {
  // ⛔ 为什么钉这条（浏览器实测抓到的真缺陷）：
  //   本仓前端**不渲染 markdown** —— `noticeState` 会 escapeHtml，`field__hint` 是纯文本。
  //   ⇒ 文案里写 `观察席**无投票权**`，用户在页面上看到的就是**字面的星号**。
  //   （浏览器实跑 E158 时在「席位」下方看到「观察席**无投票权**」才暴露出来。）
  //
  // ⚠️ 注释里用 `**` 做强调是**正常**的（仓库惯例）⇒ 只查非注释行。
  const offenders = [];
  VIEW_SRC.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return;
    if (line.includes('**')) offenders.push(`${i + 1}: ${s.slice(0, 120)}`);
  });
  assert.deepEqual(offenders, [], `这些行的用户可见文案里带了 markdown 星号：\n${offenders.join('\n')}`);
});

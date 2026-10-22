// platform/test/admin-appeals.test.js — 申诉（W4-c）：选手提交 + 组委会裁决
//
// 依据：R-REG-08（C 级不接收 ⇒ 可向组委会提交申诉）
//   + 设计文档 §11.2（人工复核与申诉状态机）
//   + 端点契约以源码为准（src/http/routes/audit.js + src/services/review-state.js）
//
// ⚠️ 为什么这组用例**必须存在**：
//   报名结果区一直写着「本级不接收，可向组委会提交申诉（R-REG-08）」，
//   但**全站没有任何申诉按钮** —— 选手被告知可以做一件做不到的事。
//   这组用例钉住两件事：入口**只在不接收时**出现；理由/说明为空时**不许提交**。
//
// ⛔ 零依赖、零构建、node:test + ESM；DOM 用**最小桩**（不引 jsdom）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离必须**早于**任何临时目录的第一次求值（本文件本身不用临时目录，
//    但保持这个顺序 ⇒ 将来加了临时目录也不会漏）。
isolateTempDir();

import {
  APPEAL_REASON_MAX,
  buildAppealForm,
  buildResultHtml,
  isAppealable,
  mountAppealForm,
  validateAppealReason,
} from '../web/views/registration.js';
import {
  appealStatusLabel,
  appealStatusTone,
  buildDecisionForm,
  canDecide,
  renderAdminAppeals,
  validateDecision,
} from '../web/views/admin-appeals.js';

// ─────────────────────────────────────────────────────────────────────────
// 最小 DOM 桩
//
// ⚠️ 只支持**按 id 取节点**（视图里新写的表单节点都是 id 锚定的），
//    innerHTML 赋值时把里面的 id 记下来 ⇒ `querySelector('#x')` 能取到。
//    这套桩的取舍与 platform/test/audit-api.test.js 同款：够测行为，不做真解析。
// ─────────────────────────────────────────────────────────────────────────

function mk(tag) {
  const el = {
    tagName: tag,
    className: '',
    id: '',
    children: [],
    handlers: {},
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    _text: '',
    _html: '',
    _htmlIds: [],
    _byId: {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this._htmlIds = [...String(v).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      // ⚠️ 真浏览器里赋 innerHTML 会**清掉原有子节点** —— 桩必须等价，
      //    否则「裁决后表单被结果面板替换」这类断言测不到。
      this.children = [];
    },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    querySelector(sel) {
      if (!sel.startsWith('#')) return null;
      const id = sel.slice(1);
      if (this._htmlIds.includes(id)) {
        if (!this._byId[id]) { const s = mk('div'); s.id = id; this._byId[id] = s; }
        return this._byId[id];
      }
      for (const c of this.children) {
        if (c.id === id) return c;
        const hit = c.querySelector?.(sel);
        if (hit) return hit;
      }
      return null;
    },
  };
  return el;
}

function installDom() {
  globalThis.document = { createElement: (tag) => mk(tag) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** 从 statRow 的 HTML 里取某个指标的数字（按 label 定位，避免误匹配别的 0）。 */
function statValue(html, label) {
  const m = String(html).match(
    new RegExp(`stat__value">(\\d+)</p>\\s*<p class="stat__label">${label}<`),
  );
  return m ? Number(m[1]) : null;
}

/** 报名记录（accepted=false ⇒ C 级不接收）。 */
const REJECTED_REG = {
  id: 'reg-1',
  level: 'C',
  status: 'rejected',
  grading: { score: 30, accepted: false, explain: [] },
};

const ACCEPTED_REG = {
  id: 'reg-2',
  level: 'A',
  status: 'accepted',
  grading: { score: 66, accepted: true, explain: [] },
};

const MODEL = {
  levels: [
    { key: 'A', label: '优秀候选', minScore: 60, accept: true },
    { key: 'C', label: '底线外', minScore: 0, accept: false },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// 选手侧：入口的出现条件 + 理由必填
// ─────────────────────────────────────────────────────────────────────────

test('申诉入口只在报名「不接收」时出现（R-REG-08）', () => {
  assert.equal(isAppealable(REJECTED_REG), true, '不接收 ⇒ 必须能给申诉入口');
  assert.equal(isAppealable(ACCEPTED_REG), false, '已接收 ⇒ 没有可申诉的东西，不给入口');
  assert.equal(isAppealable(null), false, '没有记录 ⇒ 不给入口');
});

test('结果区：被拒时挂申诉容器，已接收时不挂（不给死路）', () => {
  const rejected = buildResultHtml(REJECTED_REG, MODEL, { scale: { max: 5 } });
  assert.ok(rejected.includes('id="reg-appeal"'), '被拒 ⇒ 结果区必须有申诉容器');
  assert.ok(rejected.includes('可向组委会提交申诉'), '原有承诺文案不许被删掉');

  const accepted = buildResultHtml(ACCEPTED_REG, MODEL, { scale: { max: 5 } });
  assert.ok(!accepted.includes('id="reg-appeal"'), '已接收 ⇒ 不得出现申诉容器');
  assert.ok(accepted.includes('你已被接收'), '已接收的文案保持原样');
});

test('申诉表单：提交按钮存在，理由字段必填', () => {
  const html = buildAppealForm();
  assert.ok(html.includes('id="reg-appeal-submit"'), '必须有提交按钮');
  assert.ok(html.includes('提交申诉'), '按钮文案要说清是提交申诉');
  assert.ok(html.includes('id="reg-appeal-reason"'), '必须有理由输入框');
  assert.ok(html.includes('field--required'), '理由字段必须标必填');
  assert.ok(html.includes(`maxlength="${APPEAL_REASON_MAX}"`), '理由有长度上限');
});

test('申诉理由校验：空理由不许提交（服务端也会拒收）', () => {
  assert.equal(validateAppealReason('').ok, false);
  assert.equal(validateAppealReason('    ').ok, false, '只填空格等于没填');
  assert.match(validateAppealReason('').message, /必填/);
  const ok = validateAppealReason('  我的业务方向与评分不符  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, '我的业务方向与评分不符', '理由要 trim 后提交');
});

test('提交申诉：空理由不发请求；填了理由才 POST /api/appeals', async () => {
  const container = mk('div');
  const posts = [];
  mountAppealForm({
    container,
    reg: REJECTED_REG,
    api: { post: async (p, body) => { posts.push([p, body]); return { id: 'ap-1' }; } },
  });

  container.querySelector('#reg-appeal-reason').value = '   ';
  await container.querySelector('#reg-appeal-submit').handlers.click[0]();
  assert.equal(posts.length, 0, '空理由不得发请求');
  assert.match(container.querySelector('#reg-appeal-error').textContent, /必填/);

  container.querySelector('#reg-appeal-reason').value = ' 我认为评分与实际不符 ';
  await container.querySelector('#reg-appeal-submit').handlers.click[0]();
  assert.equal(posts.length, 1, '填了理由必须真的提交');
  assert.equal(posts[0][0], '/api/appeals');
  assert.deepEqual(posts[0][1], {
    subjectType: 'registration',
    subjectId: 'reg-1',
    reason: '我认为评分与实际不符',
  });
});

test('提交申诉：成功后就地反馈并禁用表单；失败给可点重试', async () => {
  const container = mk('div');
  const posts = [];
  let fail = true;
  mountAppealForm({
    container,
    reg: REJECTED_REG,
    api: {
      post: async (p, body) => {
        posts.push([p, body]);
        if (fail) throw new Error('档位不在可申诉的低可见档范围内');
        return { id: 'ap-9' };
      },
    },
  });

  container.querySelector('#reg-appeal-reason').value = '申诉理由';
  await container.querySelector('#reg-appeal-submit').handlers.click[0]();
  const feedback = container.querySelector('#reg-appeal-feedback');
  assert.match(feedback.innerHTML, /申诉提交失败/, '失败必须看得见');
  assert.match(feedback.innerHTML, /data-action="retry"/, '失败态必须给可点的重试');
  assert.ok(!container.querySelector('#reg-appeal-submit').disabled, '失败后按钮要能再点');

  fail = false;
  await container.querySelector('#reg-appeal-submit').handlers.click[0]();
  assert.equal(posts.length, 2, '重试必须真的重发');
  assert.match(feedback.innerHTML, /申诉已提交/, '成功后就地反馈');
  assert.equal(container.querySelector('#reg-appeal-submit').disabled, true, '成功防重复提交');
});

// ─────────────────────────────────────────────────────────────────────────
// 组委会侧：状态徽章 + 裁决校验 + 就地更新
// ─────────────────────────────────────────────────────────────────────────

test('申诉状态：徽章标签与色调一一对应', () => {
  assert.equal(appealStatusLabel('submitted'), '待裁决');
  assert.equal(appealStatusTone('submitted'), 'warn');
  assert.equal(appealStatusLabel('reviewing'), '复核中');
  assert.equal(appealStatusTone('reviewing'), 'info');
  assert.equal(appealStatusLabel('accepted'), '申诉成立');
  assert.equal(appealStatusTone('accepted'), 'success');
  assert.equal(appealStatusLabel('rejected'), '申诉驳回');
  assert.equal(appealStatusTone('rejected'), 'danger');
  assert.equal(appealStatusTone('不存在的状态'), 'neutral', '未知状态不许猜颜色');
});

test('可裁决性：只有 submitted / reviewing 可裁决（服务端状态机口径）', () => {
  assert.equal(canDecide('submitted'), true);
  assert.equal(canDecide('reviewing'), true);
  assert.equal(canDecide('accepted'), false);
  assert.equal(canDecide('rejected'), false);
});

test('裁决校验：说明为空必须拒绝；结论只能是 accepted / rejected', () => {
  assert.equal(validateDecision({ decision: 'accepted', note: '' }).ok, false);
  assert.equal(validateDecision({ decision: 'accepted', note: '   ' }).ok, false);
  assert.match(validateDecision({ decision: 'accepted', note: '' }).message, /裁决说明必填/);
  assert.equal(validateDecision({ decision: 'maybe', note: 'x' }).ok, false);
  const ok = validateDecision({ decision: 'rejected', note: '  材料不足，维持原判 ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.note, '材料不足，维持原判', '说明要 trim 后提交');
});

test('裁决表单：提交按钮存在，说明字段必填', () => {
  const html = buildDecisionForm();
  assert.ok(html.includes('id="ap-submit"'), '必须有提交裁决按钮');
  assert.ok(html.includes('id="ap-note"'), '必须有裁决说明输入框');
  assert.ok(html.includes('field--required'), '说明字段必须标必填');
  assert.ok(html.includes('value="accepted"') && html.includes('value="rejected"'), '两个结论都要给');
});

test('申诉队列：无数据时给像样的空态（不是白屏）', async () => {
  installDom();
  const wrap = renderAdminAppeals({ api: { get: async () => ({ rows: [], total: 0 }) } });
  await tick();
  const list = wrap.querySelector('#ap-list');
  assert.ok(list.innerHTML.includes('state--empty'), '空队列必须渲染空态');
  assert.ok(list.innerHTML.includes('申诉队列是空的'), '空态要说清是什么没了');
  assert.ok(list.innerHTML.includes('选手'), '空态要说明下一步谁会往这里提交');
});

test('申诉队列：列表渲染 + 裁决后就地更新（徽章换色 + 计数同步）', async () => {
  installDom();
  const posts = [];
  const wrap = renderAdminAppeals({
    api: {
      get: async () => ({
        rows: [
          {
            id: 'ap-1',
            subjectType: 'registration',
            subjectId: 'reg-1',
            filedBy: 'u_player',
            reason: '我的业务方向与评分不符',
            status: 'submitted',
            createdAt: '2026-10-22T00:00:00.000Z',
          },
          {
            id: 'ap-2',
            subjectType: 'registration',
            subjectId: 'reg-2',
            filedBy: 'u_player2',
            reason: '补充材料',
            status: 'accepted',
            decidedBy: 'u_admin',
            decidedAt: '2026-10-22T01:00:00.000Z',
            decisionNote: '材料成立',
            createdAt: '2026-10-21T00:00:00.000Z',
          },
        ],
        total: 2,
      }),
      post: async (p, body) => {
        posts.push([p, body]);
        return {
          appeal: { id: 'ap-1', status: body.decision, decision_note: body.note },
          transitions: [],
          recomputeRequired: body.decision === 'accepted',
        };
      },
    },
  });
  await tick();

  const list = wrap.querySelector('#ap-list');
  const cards = list.children;
  assert.equal(cards.length, 2, '两条申诉都要渲染出来');
  assert.ok(cards[0].innerHTML.includes('待裁决'), '待裁决徽章');
  assert.ok(cards[0].innerHTML.includes('我的业务方向与评分不符'), '申诉理由要显示给组委会看');
  assert.ok(cards[1].innerHTML.includes('申诉成立'), '已裁决的徽章');
  assert.ok(cards[1].innerHTML.includes('材料成立'), '已裁决的条目必须留下裁决说明（复盘要看）');
  assert.ok(cards[1].innerHTML.includes('u_admin'), '已裁决的条目必须标出裁决人');

  // 待裁决那条才有裁决表单；已裁决那条没有（不能重复裁决）。
  const form = cards[0].children[0];
  assert.ok(form, '待裁决条目必须带裁决表单');
  assert.equal(cards[1].children.length, 0, '已裁决条目不再给裁决表单');

  // 说明为空 ⇒ 不发请求。
  form.querySelector('#ap-decision').value = 'accepted';
  form.querySelector('#ap-note').value = '  ';
  await form.querySelector('#ap-submit').handlers.click[0]();
  assert.equal(posts.length, 0, '说明为空不得提交');
  assert.match(form.querySelector('#ap-error').textContent, /裁决说明必填/);

  // 填了说明 ⇒ 提交，并就地更新这一条。
  form.querySelector('#ap-note').value = ' 材料成立，转入重新复核 ';
  await form.querySelector('#ap-submit').handlers.click[0]();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/appeals/ap-1/decide');
  assert.deepEqual(posts[0][1], { decision: 'accepted', note: '材料成立，转入重新复核' });

  assert.ok(cards[0].innerHTML.includes('申诉成立'), '裁决后徽章必须换色/换词（就地更新）');
  assert.ok(cards[0].innerHTML.includes('材料成立，转入重新复核'), '裁决说明要留在页面上');
  assert.equal(cards[0].children.length, 0, '裁决后表单被结果面板替换');

  // 计数同步：裁决后 待裁决 1 → 0、已裁决 1 → 2（ap-1 刚裁决 + ap-2 本来就裁决过）。
  const stats = wrap.querySelector('#ap-stats');
  assert.equal(statValue(stats.innerHTML, '待裁决'), 0, '待裁决计数要同步');
  assert.equal(statValue(stats.innerHTML, '已裁决'), 2, '已裁决计数要同步');
  assert.equal(statValue(stats.innerHTML, '总数'), 2, '总数不变');
});

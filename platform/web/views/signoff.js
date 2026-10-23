// web/views/signoff.js — 企业签字台（里程碑签字 + 企业双签）· P10 · W4-b
//
// 规则溯源（口径一律以源码为准）：
//   - 「里程碑 = 客观事实确认，**单签**，不进总分」→ R-ENT-02 / R-PTS-02
//     + src/services/milestone.js（文件头明写：与 enterprise_confirmations 是两张不同的表）
//   - 「企业确认 = 主观评分，**双签**（出题企业签字 + ≥1 名跨领域评委签字），进总分」
//     → R-JDG-06（R2 双签）/ S7 §2.4 + db/migrations/003_review.sql 的 enterprise_confirmations 注释
//   - 「签字必须写清解决哪个环节 / 落地时间 / 我方角色」→ R-JDG-14
//   - 「签字不公开」→ R-ENT-04（⇒ 本视图与 API **都不回传签字人姓名**）
//   - 「企业项缺双签 → 该项按 0 分计」→ R2（src/domain/enterprise-seat.js applyEnterpriseRules）
//   - 「错误态必须带真能点的重试」→ DP-80；「不许整页刷新 / 不许冲掉已填内容」→ DP-81
//   - 「可见性在 API 层过滤，前端只判登录态」→ DP-77 / 全局约束
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js 的文件头 + 机器闸
//   - 「赛制 / 赛事事实只从 API 来」→ 设计文档 §7 + 机器闸（前端不许硬编码规则字面量）
//
// ⚠️ **三个写端点的请求体形状互不相同，抄错就是 400**（照后端源码摘出来的）：
//   ① 里程碑签字  POST /api/milestones/:id/signoff
//      { department: string, content: string }
//      （两个都必填 —— rules/milestones.default.json 的 signoffRequires 决定的）
//   ② 撤回签字    POST /api/milestones/:id/signoff/withdraw
//      { signoffId: string }
//   ③ 企业确认    POST /api/stages/:stageId/enterprise-confirmations
//      { teamId: string, dimension?: string, rawScore: number,
//        crossJudgeId?: string, signatoryUserId?: string, content: string,
//        enterpriseId?: string }
//      ⚠️ `rawScore` 是 **0–100 百分制**（不是 1–5 量表）。
//      ⚠️ `enterpriseId` 只有**组委会代录**时才需要带（出题企业只能为自己签）。
//
// ⚠️ **纯函数与 DOM 接线分离**：
//   分组（signoffWorklistItems）、载荷组装（signoffFormState / enterpriseConfirmPayload）、
//   双签缺口判定（enterpriseConfirmRows）、候选过滤（crossJudgeCandidates）、
//   HTML 渲染（signoffWorklistHtml / enterpriseConfirmHtml / signoffPageHtml）
//   **全部是无 IO、无 DOM 的纯函数** ⇒ 可以直接对**结果**做行为断言
//   （platform/test/web-signoff.test.js），而不是对源码做文本匹配。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  statRow, tableWrap, emptyRow,
} from '../ui.js';

/** 分值范围：0–100 百分制（后端 assertScoreInRange 的同一口径，见 src/services/review.js）。 */
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/**
 * 评委席别 → 中文标签。
 * ⚠️ 依据是 `stage_judges.seat` 的取值域（db/migrations/003_review.sql 的建表注释），
 *   **不是**赛制规则（权重表、维度表一概不从这里来）。
 *   同类先例：web/nav.js 的 ROLE_META（角色键 → 中文标签）。
 *   认不出来的值原样透出（不猜、不吞）。
 */
const SEAT_LABELS = { judge: '专家席', enterprise: '企业席', observer: '观察员' };

/** 席别标签（认不出来就原样显示）。 */
export function seatLabel(seat) {
  const key = String(seat ?? '');
  return SEAT_LABELS[key] ?? key;
}

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：里程碑签字台的三态分组
// ══════════════════════════════════════════════════════════════════

/**
 * 把签字台清单整理成「待签 / 已签 / 已撤回」三组（纯函数）。
 *
 * ⚠️ **为什么是三组而不是两个**：
 *   撤回是**软删除**（`milestone_signoffs.revoked_at`，src/db/repo/tiers.js revokeSignoff）——
 *   撤回后该里程碑回到「未达成」，段位由重算体现降档（src/services/milestone.js 的注释）。
 *   ⇒ 「已撤回」与「待签」在数据上都是「当前没有有效签字」，但**语义完全不同**：
 *     待签 = 还没签过；已撤回 = 签过又撤了（要让人看见撤过，别让它长得跟没签一样）。
 *
 * ⚠️ **形状恒定**：每一项的字段集合完全一致，缺值一律 null / false / ''，
 *   **绝不出现 undefined**（前端模板里 `undefined` 会渲染成字符串 "undefined"）。
 *
 * @param {object|Array} raw GET /api/signoffs/mine 的返回（或它的 items 数组）
 * @returns {{pending:Array, signed:Array, revoked:Array}}
 */
export function signoffWorklistItems(raw) {
  const list = Array.isArray(raw?.items)
    ? raw.items
    : (Array.isArray(raw) ? raw : []);
  const pending = [];
  const signed = [];
  const revoked = [];
  for (const item of list) {
    const row = {
      milestoneId: String(item?.milestoneId ?? ''),
      teamId: String(item?.teamId ?? ''),
      teamName: String(item?.teamName ?? ''),
      key: String(item?.key ?? ''),
      label: String(item?.label ?? ''),
      countsTowardTier: item?.countsTowardTier === true,
      signed: item?.signed === true,
      signoffId: item?.signoffId ?? null,
      signedAt: item?.signedAt ?? null,
      department: item?.department ?? null,
      content: item?.content ?? null,
      revokedAt: item?.revokedAt ?? null,
      signedByMe: item?.signedByMe === true,
      canWithdraw: item?.canWithdraw === true,
    };
    if (row.signed) signed.push(row);
    else if (row.revokedAt) revoked.push(row);
    else pending.push(row);
  }
  return { pending, signed, revoked };
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：表单初值与提交载荷
// ══════════════════════════════════════════════════════════════════

/**
 * 里程碑签字表单的初值 + 提交载荷（纯函数）。
 *
 * ⚠️ **载荷字段名逐字照后端**（src/services/milestone.js createSignoff 的 body）：
 *   `department` / `content` —— 抄成 `dept` / `text` 就是 400 MISSING_DEPARTMENT / MISSING_CONTENT。
 *
 * @param {object} o
 * @param {object|null} o.item    这条里程碑（用来回填已存在的签字 id）
 * @param {object} o.values       用户填的值 { department, content }
 * @returns {{values:object, payload:object|null, errors:Array<{field:string,message:string}>}}
 */
export function signoffFormState({ item = null, values = {} } = {}) {
  const department = String(values?.department ?? '').trim();
  const content = String(values?.content ?? '').trim();
  const errors = [];
  // ⚠️ rules/milestones.default.json 的 signoffRequires = { content: true, department: true, signatory: true }
  //   ⇒ 两个字段都必填（前端先拦一道，不发无谓请求；后端还会再拦一道）。
  if (!department) errors.push({ field: 'department', message: '必须填写签字部门（R-PTS-03：只认业务部门签字）' });
  if (!content) {
    errors.push({
      field: 'content',
      message: '必须写清签字内容：解决了哪个环节 / 预计落地时间 / 我方投入角色（R-JDG-14）',
    });
  }
  const payload = errors.length ? null : { department, content };
  return {
    // 初值 + 已填值（回填用的 signoffId 来自服务端，**不来自用户输入**）。
    values: {
      department,
      content,
      signoffId: item?.signoffId ?? null,
    },
    payload,
    errors,
  };
}

/**
 * 撤回签字的请求体（纯函数）。
 * ⚠️ **载荷字段名逐字照后端**：src/http/routes/milestone.js 读的是 `ctx.body?.signoffId`
 *   （不是 id / signoff_id）。
 *
 * @returns {{payload:object|null, errors:Array}}
 */
export function buildWithdrawPayload({ signoffId = '' } = {}) {
  const id = String(signoffId ?? '').trim();
  if (!id) {
    return { payload: null, errors: [{ field: 'signoffId', message: '没有拿到签字 id，无法撤回' }] };
  }
  return { payload: { signoffId: id }, errors: [] };
}

/**
 * 企业双签清单的行（含「还缺哪一签」的判定）（纯函数）。
 *
 * ⚠️ **「哪一条确认算数」的判定口径**（必须与领域层一致 —— src/domain/enterprise-seat.js）：
 *   ① 非自由命题组：只有**出题企业**（team.enterpriseId）那条确认算数
 *      （R1：别家企业签的 ⇒ 该队企业项权重降 0）；
 *   ② 自由命题组（isFreeBrief）：**任一**企业的确认都算数（R4 只在「完全没有确认」时接管）。
 *   ③ 双签齐全 = 有 cross_judge_id **且** 有 signatory_user_id（领域层的三层有效性判定）。
 *      本视图只看得到 `hasCrossJudge`（有没有跨领域评委签字）与「出题企业已签」，
 *      ⇒ 「缺哪一签」的口径：
 *        - 还没有出题企业的确认 → 缺 **enterprise**（企业这一签）；
 *        - 有确认但没带跨领域评委 → 缺 **crossJudge**（R2 ⇒ 该项按 0 分计）；
 *        - 都有 → 不缺（双签齐全）。
 *
 * @param {object} raw GET /api/stages/:stageId/enterprise-confirmations 的返回
 * @returns {Array<object>} 每行字段恒定
 */
export function enterpriseConfirmRows(raw) {
  const teams = Array.isArray(raw?.teams) ? raw.teams : [];
  const confirmations = Array.isArray(raw?.confirmations) ? raw.confirmations : [];
  return teams.map((team) => {
    const teamId = String(team?.teamId ?? '');
    const enterpriseId = team?.enterpriseId ?? null;
    const isFreeBrief = team?.isFreeBrief === true;
    const all = confirmations.filter((c) => c?.teamId === teamId);
    const relevant = isFreeBrief
      ? all
      : all.filter((c) => c?.enterpriseId === enterpriseId);
    const signed = relevant.length > 0;
    const hasCrossJudge = relevant.some((c) => c?.hasCrossJudge === true);
    const missing = [];
    if (!signed) missing.push('enterprise');
    else if (!hasCrossJudge) missing.push('crossJudge');
    const first = relevant[0] ?? null;
    return {
      teamId,
      teamName: String(team?.teamName ?? ''),
      taskPackageTitle: team?.taskPackageTitle ?? null,
      enterpriseId,
      isFreeBrief,
      canSign: team?.canSign !== false,
      signed,
      hasCrossJudge,
      missing,
      dimension: first?.dimension ?? null,
      // ⛔ P11 · E141：逆向路径（撤回 / 改签）要按**确认 id**操作 ⇒ 这里把 id 带出来。
      confirmationId: first?.id ? String(first.id) : null,
      rawScore: typeof first?.rawScore === 'number' ? first.rawScore : null,
      signedAt: first?.signedAt ?? null,
      content: first?.content ?? null,
      confirmations: all.map((c) => ({
        id: String(c?.id ?? ''),
        enterpriseId: c?.enterpriseId ?? null,
        dimension: c?.dimension ?? null,
        rawScore: typeof c?.rawScore === 'number' ? c.rawScore : null,
        hasCrossJudge: c?.hasCrossJudge === true,
        signedAt: c?.signedAt ?? null,
      })),
    };
  });
}

/**
 * 跨领域评委候选（纯函数）：**剔除「我自己」**。
 *
 * ⚠️ **为什么必须剔除自己**：
 *   后端 `POST /api/stages/:stageId/enterprise-confirmations` 明确拒绝
 *   `crossJudgeId === 出题企业签字人`（400 CROSS_JUDGE_SAME_AS_SIGNATORY，见 src/http/routes/review.js）。
 *   ⇒ 把自己放进候选 = 用户选了就是一次必失败的请求（看起来像页面坏了）。
 *   ⇒ 「我」= 当前用户 id（服务端给的 `myEnterpriseId`）；
 *      组委会代录时还要剔除**被代签的那家企业**（`signatoryId`）。
 *
 * @param {object|Array} raw 端点返回（或候选数组）
 * @param {object} o { signatoryId } —— 本次签字的「企业签字人」id（默认 = 我）
 * @returns {Array<{userId:string,name:string,seat:string}>}
 */
export function crossJudgeCandidates(raw, { signatoryId = null } = {}) {
  const list = Array.isArray(raw?.crossJudgeCandidates)
    ? raw.crossJudgeCandidates
    : (Array.isArray(raw) ? raw : []);
  const exclude = new Set(
    [String(raw?.myEnterpriseId ?? ''), String(signatoryId ?? '')].filter((x) => x !== ''),
  );
  return list
    .filter((c) => c && !exclude.has(String(c.userId ?? '')))
    .map((c) => ({
      userId: String(c.userId ?? ''),
      name: String(c.name ?? ''),
      seat: String(c.seat ?? ''),
    }));
}

/**
 * 企业双签表单的初值（纯函数）。
 * @param {object|null} row enterpriseConfirmRows() 的一行
 * @returns {{teamId:string, dimension:string, rawScore:string, content:string, crossJudgeId:string}}
 */
export function enterpriseConfirmFormState(row = null) {
  return {
    teamId: String(row?.teamId ?? ''),
    dimension: String(row?.dimension ?? ''),
    rawScore: '',
    content: '',
    crossJudgeId: '',
  };
}

/**
 * 企业双签的提交载荷 + 本地校验（纯函数）。
 *
 * ⚠️ **载荷字段名逐字照后端**（src/http/routes/review.js 的 POST 分支）：
 *   `teamId` / `dimension` / `rawScore` / `crossJudgeId` / `content` / `enterpriseId`。
 *   ⚠️ `signatoryUserId` **不传** —— 后端会把它设成 `enterpriseId`；
 *      前端自己传反而可能与 enterpriseId 不一致 ⇒ 403「签字人必须与出题企业一致」。
 *
 * @param {object} o
 * @param {string} o.teamId
 * @param {string} o.dimension  企业确认维度（**从规则表来**，不写死 'enterprise'）
 * @param {string|number} o.rawScore
 * @param {string} o.content
 * @param {string} o.crossJudgeId
 * @param {string} o.enterpriseId  组委会代录时才带（出题企业自己签时留空）
 * @returns {{payload:object|null, errors:Array<{field:string,message:string}>}}
 */
export function enterpriseConfirmPayload({
  teamId = '',
  dimension = '',
  rawScore = '',
  content = '',
  crossJudgeId = '',
  enterpriseId = '',
} = {}) {
  const errors = [];
  const tid = String(teamId ?? '').trim();
  const dim = String(dimension ?? '').trim();
  const scoreText = String(rawScore ?? '').trim();
  const score = Number(scoreText);
  const text = String(content ?? '').trim();
  const judge = String(crossJudgeId ?? '').trim();
  const ent = String(enterpriseId ?? '').trim();
  if (!tid) errors.push({ field: 'teamId', message: '先选要确认的队伍' });
  if (!dim) errors.push({ field: 'dimension', message: '缺少企业确认维度（规则表里没有企业席维度）' });
  // ⚠️ 空字符串会被 Number('') 变成 0 ⇒ 必须先判空，否则「没填分」会被当成 0 分提交。
  if (scoreText === '' || !Number.isFinite(score) || score < MIN_SCORE || score > MAX_SCORE) {
    errors.push({ field: 'rawScore', message: `企业确认分必须在 ${MIN_SCORE}–${MAX_SCORE} 之间` });
  }
  if (!text) {
    errors.push({
      field: 'content',
      message: '必须写清签字内容：解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色（R-JDG-14）',
    });
  }
  if (!judge) {
    errors.push({ field: 'crossJudgeId', message: '必须指定一名跨领域评委 —— 企业确认是双签制（R2）' });
  }
  if (errors.length) return { payload: null, errors };
  const payload = {
    teamId: tid,
    dimension: dim,
    rawScore: score,
    content: text,
    crossJudgeId: judge,
  };
  // ⚠️ 只有**组委会代录**才带 enterpriseId（出题企业自己签时由后端取当前用户）。
  if (ent) payload.enterpriseId = ent;
  return { payload, errors: [] };
}

// ══════════════════════════════════════════════════════════════════
// 三、纯函数：HTML 渲染（⛔ 服务端数据一律过 escapeHtml）
// ══════════════════════════════════════════════════════════════════

/** 签字时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。 */
function fmtTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 一条里程碑的抬头（队名 + 里程碑名 + 徽章）。 */
function milestoneHeadHtml(row, tone) {
  return `<div class="signoff__item-head">
      <strong>${escapeHtml(row.label || row.key)}</strong>
      ${badge(tone.label, tone.tone)}
      <span class="muted small">${escapeHtml(row.teamName)}${row.countsTowardTier ? ' · 计入段位' : ''}</span>
    </div>`;
}

/**
 * 待签项的表单（纯 HTML 拼接）。
 * ⚠️ 每个输入框都带 `data-signoff="<字段>"` + `data-milestone="<milestoneId>"`：
 *   DOM 侧按这两个属性取值（提交时读当前输入框的值，不缓存到状态里 ——
 *   否则整块重绘会把用户已填的内容冲掉，DP-81）。
 */
function pendingItemHtml(row) {
  const mid = escapeHtml(row.milestoneId);
  return `<li class="signoff__item" data-milestone="${mid}">
      ${milestoneHeadHtml(row, { label: '待签', tone: 'warn' })}
      <div class="signoff__form">
        <div class="field field--required">
          <label class="field__label" for="signoff-dept-${mid}">签字部门</label>
          <input class="input" id="signoff-dept-${mid}" data-signoff="department" data-milestone="${mid}"
            autocomplete="off" />
          <p class="field__hint">R-PTS-03：只认业务部门签字。</p>
        </div>
        <div class="field field--required">
          <label class="field__label" for="signoff-content-${mid}">签字内容</label>
          <textarea class="textarea" id="signoff-content-${mid}" data-signoff="content" data-milestone="${mid}"
            rows="3"></textarea>
          <p class="field__hint">必须写清：解决了哪个环节 / 预计落地时间 / 我方投入角色（R-JDG-14）。</p>
        </div>
        <div class="row">
          <button type="button" class="btn btn--primary btn--sm" data-action="signoff-submit"
            data-milestone="${mid}">提交签字</button>
        </div>
      </div>
      <div class="form-feedback" data-feedback="signoff:${mid}"></div>
    </li>`;
}

/**
 * 已签项（含**撤回的二次确认**）。
 *
 * ⚠️ **撤回是破坏性动作** ⇒ 必须有二次确认：
 *   撤回 = 软删除，该里程碑回到「未达成」，段位会重算降档
 *   （src/services/milestone.js withdrawSignoff 的注释）。
 *   ⇒ 第一次点「撤回」只**展开**确认区（`hidden` 属性），第二次点「确认撤回」才发请求。
 *   ⇒ 确认区在 HTML 里**始终存在**（hidden）⇒ 「有没有二次确认」可以直接对渲染结果断言。
 */
function signedItemHtml(row) {
  const mid = escapeHtml(row.milestoneId);
  const sid = escapeHtml(row.signoffId ?? '');
  const time = fmtTime(row.signedAt);
  const meta = [row.department, time].filter(Boolean).map((x) => escapeHtml(x)).join(' · ');
  return `<li class="signoff__item" data-milestone="${mid}">
      ${milestoneHeadHtml(row, { label: '已签', tone: 'success' })}
      <p class="signoff__meta muted small">${meta || '—'}</p>
      <p class="signoff__meta">${escapeHtml(row.content ?? '')}</p>
      <div class="signoff__actions">
        ${row.canWithdraw ? `<button type="button" class="btn btn--danger btn--sm" data-action="withdraw"
            data-milestone="${mid}" data-signoff="${sid}" data-needs-confirm="true">撤回</button>` : ''}
        <div class="signoff__confirm" data-confirm="withdraw" data-milestone="${mid}" hidden>
          <p class="signoff__confirm-text">撤回后该里程碑回到「未达成」，段位会重算降档。确认撤回？</p>
          <div class="row">
            <button type="button" class="btn btn--danger btn--sm" data-action="withdraw-confirm"
              data-milestone="${mid}" data-signoff="${sid}">确认撤回</button>
            <button type="button" class="btn btn--ghost btn--sm" data-action="withdraw-cancel"
              data-milestone="${mid}">取消</button>
          </div>
        </div>
      </div>
      <div class="form-feedback" data-feedback="withdraw:${mid}"></div>
    </li>`;
}

/** 已撤回项（只读展示：让人看见「签过又撤了」，不给再撤回的入口 —— 后端是幂等的 409）。 */
function revokedItemHtml(row) {
  const mid = escapeHtml(row.milestoneId);
  const time = fmtTime(row.revokedAt);
  const meta = [row.department, time ? `撤回于 ${time}` : ''].filter(Boolean).map((x) => escapeHtml(x)).join(' · ');
  return `<li class="signoff__item" data-milestone="${mid}">
      ${milestoneHeadHtml(row, { label: '已撤回', tone: 'danger' })}
      <p class="signoff__meta muted small">${meta || '—'}</p>
      ${row.content ? `<p class="signoff__meta">${escapeHtml(row.content)}</p>` : ''}
    </li>`;
}

/**
 * 里程碑签字台区块的 HTML（纯函数）。
 * @param {object} o { raw, error, loading }
 */
export function signoffWorklistHtml({ raw = null, error = null, loading = false } = {}) {
  if (loading) return loadingState({ rows: 3, label: '正在加载签字清单…' });
  if (error) {
    return `<div data-retry-kind="worklist">${errorState({
      message: error,
      hint: '点「重试」重新拉一次签字清单。',
    })}</div>`;
  }
  const { pending, signed, revoked } = signoffWorklistItems(raw);
  if (!pending.length && !signed.length && !revoked.length) {
    return emptyState({
      title: '没有需要签字的里程碑',
      hint: '里程碑清单在报名 / 组队时固定，赛程中不能自行新增。等队伍产出里程碑后，这里会出现待签项。',
      action: { href: '#/team', label: '查看我的战队' },
    });
  }
  const group = (title, hint, items, render) => (items.length
    ? `<section class="signoff__group">
        <h3 class="section-title">${escapeHtml(title)} <span class="muted small">${items.length}</span></h3>
        <p class="muted small">${escapeHtml(hint)}</p>
        <ul class="list-divided signoff__items">${items.map(render).join('')}</ul>
      </section>`
    : '');
  return [
    group('待签', '每项要填「签字部门」与「签字内容」（R-JDG-14）。', pending, pendingItemHtml),
    group('已签', '签字已生效。撤回是破坏性动作，需要二次确认。', signed, signedItemHtml),
    group('已撤回', '撤回后该里程碑回到「未达成」，可以重新签一次。', revoked, revokedItemHtml),
  ].join('');
}

/** 跨领域评委下拉的选项（纯 HTML）。 */
function judgeOptionsHtml(candidates, selected = '') {
  if (!candidates.length) {
    return '<option value="">本赛段没有可用的跨领域评委</option>';
  }
  const opts = candidates.map((c) => `<option value="${escapeHtml(c.userId)}"${c.userId === selected ? ' selected' : ''}>${escapeHtml(c.name)}${c.seat ? `（${escapeHtml(seatLabel(c.seat))}）` : ''}</option>`);
  return `<option value="">请选择跨领域评委</option>${opts.join('')}`;
}

/** 一行「还缺哪一签」的说明。 */
function missingHtml(row) {
  if (!row.signed) return '<span class="muted small">还没签（缺企业这一签）</span>';
  if (!row.hasCrossJudge) {
    return '<span class="signoff__missing">缺跨领域评委这一签（R2：该项按 0 分计）</span>';
  }
  return '<span class="muted small">双签齐全</span>';
}

/** 企业双签清单表格（纯 HTML）。 */
function confirmTableHtml(rows) {
  // ⛔ P11 · E141：企业确认落库后必须**能改、能撤** ——
  //    此前只有正向流程 ⇒ 签错了改不了、缺的那一半签**永远补不上**（企业席恒 0 分且产品内修不了）。
  const actions = (row) => {
    if (!row.signed || !row.confirmationId) return '<span class="muted small">—</span>';
    const cid = escapeHtml(row.confirmationId);
    const label = row.hasCrossJudge ? '改签' : '补签并改签';
    return `<div class="row">
        <button type="button" class="btn btn--ghost btn--sm" data-action="confirm-resign"
          data-confirmation="${cid}" data-team="${escapeHtml(row.teamId)}">${label}</button>
        <button type="button" class="btn btn--danger btn--sm" data-action="confirm-withdraw"
          data-confirmation="${cid}" data-team="${escapeHtml(row.teamId)}">撤回</button>
        <div class="signoff__confirm" data-confirm="confirm-withdraw" data-confirmation="${cid}" hidden>
          <p class="signoff__confirm-text">撤回后这条企业确认失效（证据留痕），该队企业席计分归零，需重新计算并重新发榜。确认撤回？</p>
          <div class="row">
            <button type="button" class="btn btn--danger btn--sm" data-action="confirm-withdraw-confirm"
              data-confirmation="${cid}">确认撤回</button>
            <button type="button" class="btn btn--ghost btn--sm" data-action="confirm-withdraw-cancel"
              data-confirmation="${cid}">取消</button>
          </div>
        </div>
      </div>`;
  };
  const body = rows.map((row) => `<tr>
      <td>${escapeHtml(row.teamName || row.teamId)}</td>
      <td>${escapeHtml(row.taskPackageTitle ?? '—')}</td>
      <td>${row.signed ? badge(row.hasCrossJudge ? '已确认（双签齐全）' : '已确认（缺双签）', row.hasCrossJudge ? 'success' : 'danger') : badge('待确认', 'warn')}</td>
      <td>${missingHtml(row)}</td>
      <td>${actions(row)}</td>
    </tr>`).join('');
  return tableWrap(
    `<thead><tr><th>队伍</th><th>任务包</th><th>状态</th><th>还缺</th><th>操作</th></tr></thead>
     <tbody>${body || emptyRow(5, '这个赛段没有你能确认的队伍')}</tbody>`,
    { caption: '企业确认待签清单' },
  );
}

/**
 * 企业双签区块的 HTML（纯函数）。
 * @param {object} o { board, error, loading, stages, stageId, selectedTeamId, selectedJudgeId }
 */
export function enterpriseConfirmHtml({
  board = null,
  error = null,
  loading = false,
  stages = [],
  stageId = '',
  selectedTeamId = '',
  selectedJudgeId = '',
} = {}) {
  const stageOptions = stages.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === stageId ? ' selected' : ''}>${escapeHtml(s.name || s.key || s.id)}</option>`).join('');
  const stagePicker = `<div class="field">
      <label class="field__label" for="signoff-stage">赛段</label>
      <select class="select" id="signoff-stage" data-confirm="stage">
        ${stageOptions || '<option value="">（没有可选赛段）</option>'}
      </select>
      <p class="field__hint">企业确认按赛段记分（初赛 / 决赛各一套权重表）。</p>
    </div>`;

  if (loading) return `${stagePicker}<div data-retry-kind="board">${loadingState({ rows: 3, label: '正在加载企业确认清单…' })}</div>`;
  if (error) {
    return `${stagePicker}<div data-retry-kind="board">${errorState({
      message: error,
      hint: '点「重试」重新拉一次企业确认清单。',
    })}</div>`;
  }
  if (!board) {
    return `${stagePicker}${emptyState({
      title: '还没有加载企业确认清单',
      hint: '先选一个赛段，再拉取该赛段的企业确认待签清单。',
      action: { href: '#/', label: '回到首页' },
    })}`;
  }

  const rows = enterpriseConfirmRows(board);
  const signable = rows.filter((r) => r.canSign);
  const selected = rows.find((r) => r.teamId === selectedTeamId) ?? null;
  const candidates = crossJudgeCandidates(board, {
    signatoryId: selected?.enterpriseId ?? null,
  });
  const dimensions = Array.isArray(board.dimensions) ? board.dimensions : [];
  const dimensionOptions = dimensions.map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.name || d.key)}</option>`).join('');
  const teamOptions = signable.map((r) => `<option value="${escapeHtml(r.teamId)}"${r.teamId === selectedTeamId ? ' selected' : ''}>${escapeHtml(r.teamName || r.teamId)}</option>`).join('');

  const noCandidate = candidates.length === 0;
  const form = `<div class="signoff__form">
      <div class="field">
        <label class="field__label" for="signoff-team">要确认的队伍</label>
        <select class="select" id="signoff-team" data-confirm="team">
          ${teamOptions || '<option value="">（没有可确认的队伍）</option>'}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="signoff-dimension">确认维度</label>
        <select class="select" id="signoff-dimension" data-confirm="dimension">
          ${dimensionOptions || '<option value="">（规则表里没有企业席维度）</option>'}
        </select>
      </div>
      <div class="field field--required">
        <label class="field__label" for="signoff-score">企业确认分</label>
        <input class="input" id="signoff-score" type="number" inputmode="decimal"
          min="${MIN_SCORE}" max="${MAX_SCORE}" step="0.1" data-confirm="rawScore" />
        <p class="field__hint">0–100 百分制（后端 assertScoreInRange 的同一口径）。</p>
      </div>
      <div class="field field--required">
        <label class="field__label" for="signoff-confirm-content">签字内容</label>
        <textarea class="textarea" id="signoff-confirm-content" rows="3" data-confirm="content"></textarea>
        <p class="field__hint">必须写清：解决了我方哪个具体环节 / 预计落地时间 / 我方投入角色（R-JDG-14）。</p>
      </div>
      <div class="field field--required">
        <label class="field__label" for="signoff-judge">跨领域评委（双签之一）</label>
        <select class="select" id="signoff-judge" data-confirm="crossJudge">
          ${judgeOptionsHtml(candidates, selectedJudgeId)}
        </select>
        <p class="field__hint">R2 双签：出题企业签字 + 至少一名跨领域评委签字，缺一即该项按 0 分计。</p>
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" data-action="confirm-submit"
          ${noCandidate || !signable.length ? 'disabled' : ''}>提交企业确认</button>
      </div>
    </div>`;

  const warn = noCandidate
    ? noticeState({
      tone: 'warn',
      title: '本赛段没有可用的跨领域评委',
      items: ['企业确认是双签制（R2）：没有第二签字人就没有可签的确认。请联系组委会把跨领域评委排进本赛段。'],
    })
    : '';

  return `${stagePicker}
    ${warn}
    ${confirmTableHtml(rows)}
    <h3 class="section-title">签一笔企业确认</h3>
    ${form}
    <div class="form-feedback" data-feedback="confirm"></div>`;
}

/**
 * 整页 HTML（纯函数）。
 * @param {object} o { worklist, worklistError, loadingWorklist, board, boardError, loadingBoard, stages, stageId, ... }
 */
export function signoffPageHtml(o = {}) {
  const head = pageHead({
    title: '企业签字台',
    sub: '两条线各签各的：里程碑签字只确认客观事实（单签、不进总分）；企业确认是主观评分（双签、进总分）。',
  });
  const stats = statRow([
    { label: '待签里程碑', value: String(o.pendingCount ?? 0) },
    { label: '已签里程碑', value: String(o.signedCount ?? 0) },
    { label: '已撤回', value: String(o.revokedCount ?? 0) },
    { label: '待确认队伍', value: String(o.pendingConfirmCount ?? 0) },
  ]);
  return `<div class="signoff-view">
    ${head}
    ${stats}
    ${panel({
    title: '里程碑签字',
    desc: '只确认「这件事到底发生了没有」——单签，不进总分。',
    body: signoffWorklistHtml({
      raw: o.worklist,
      error: o.worklistError,
      loading: o.loadingWorklist,
    }),
  })}
    ${panel({
    title: '企业双签',
    desc: '主观评分，进总分 —— 需要出题企业签字 + 一名跨领域评委签字（R2 双签）。',
    body: enterpriseConfirmHtml({
      board: o.board,
      error: o.boardError,
      loading: o.loadingBoard,
      stages: o.stages,
      stageId: o.stageId,
      selectedTeamId: o.selectedTeamId,
      selectedJudgeId: o.selectedJudgeId,
    }),
  })}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 四、DOM 接线（renderSignoff）
// ══════════════════════════════════════════════════════════════════

/**
 * 企业签字台视图。
 *
 * ⚠️ **交互纪律**：
 *   ① 提交一律「本地校验 → 发请求 → 就地反馈」（DP-80 / DP-81）：
 *      失败时**只改反馈位**（不改整页）⇒ 用户已填的内容不会被冲掉；
 *   ② 提交成功后**重新拉一次清单**（不是本地改状态）⇒ 页面显示的永远是服务端口径；
 *   ③ 撤回有**二次确认**；
 *   ④ 加载态 / 错误态 / 空态全部用 web/ui.js 的现成组件（不自己造）。
 *
 * ⚠️ **最小 DOM 桩上不许抛**：所有 DOM 读取都用可选链（`?.`），
 *   `querySelector` 返回 null 时按「没有这个元素」处理。
 */
export async function renderSignoff(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'signoff-view';

  const state = {
    stageId: String(ctx?.params?.stageId ?? ctx?.query?.stageId ?? ''),
    stages: [],
    worklist: null,
    worklistError: null,
    loadingWorklist: true,
    board: null,
    boardError: null,
    loadingBoard: false,
    selectedTeamId: '',
    selectedJudgeId: '',
  };

  /** 重绘整页（只在「数据变了」时调用；表单失败反馈不走这里，避免冲掉已填内容）。 */
  const render = () => {
    const { pending, signed, revoked } = signoffWorklistItems(state.worklist);
    const rows = enterpriseConfirmRows(state.board);
    wrap.innerHTML = signoffPageHtml({
      worklist: state.worklist,
      worklistError: state.worklistError,
      loadingWorklist: state.loadingWorklist,
      board: state.board,
      boardError: state.boardError,
      loadingBoard: state.loadingBoard,
      stages: state.stages,
      stageId: state.stageId,
      selectedTeamId: state.selectedTeamId,
      selectedJudgeId: state.selectedJudgeId,
      pendingCount: pending.length,
      signedCount: signed.length,
      revokedCount: revoked.length,
      pendingConfirmCount: rows.filter((r) => !r.signed).length,
    });
  };

  /** 拉里程碑签字清单。 */
  const loadWorklist = async () => {
    state.loadingWorklist = true;
    state.worklistError = null;
    render();
    try {
      const data = await ctx.api.get('/api/signoffs/mine');
      state.worklist = data ?? null;
    } catch (e) {
      state.worklist = null;
      state.worklistError = e?.message ?? '加载失败';
    } finally {
      state.loadingWorklist = false;
      render();
    }
  };

  /** 拉某赛段的企业双签清单。 */
  const loadBoard = async () => {
    if (!state.stageId) {
      state.board = null;
      state.boardError = null;
      state.loadingBoard = false;
      render();
      return;
    }
    state.loadingBoard = true;
    state.boardError = null;
    render();
    try {
      const stage = encodeURIComponent(state.stageId);
      const data = await ctx.api.get(`/api/stages/${stage}/enterprise-confirmations`);
      state.board = data ?? null;
      const rows = enterpriseConfirmRows(state.board);
      if (!rows.some((r) => r.teamId === state.selectedTeamId)) {
        state.selectedTeamId = '';
        state.selectedJudgeId = '';
      }
    } catch (e) {
      state.board = null;
      state.boardError = e?.message ?? '加载失败';
    } finally {
      state.loadingBoard = false;
      render();
    }
  };

  /** 赛段列表（失败不致命：没有赛段就只显示里程碑签字那一块）。 */
  const loadStages = async () => {
    try {
      const data = await ctx.api.get('/api/stages');
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      state.stages = Array.isArray(items) ? items : [];
    } catch {
      state.stages = [];
    }
    if (!state.stageId && state.stages.length) state.stageId = state.stages[0].id;
  };

  /** 就地反馈位（不整页刷新）。 */
  const feedback = (key) => wrap.querySelector(`[data-feedback="${key}"]`);

  /** 读某个输入框的值（读不到就当空串 —— 最小 DOM 桩上不许抛）。 */
  const value = (selector) => {
    const el = wrap.querySelector(selector);
    return el && typeof el.value === 'string' ? el.value : '';
  };

  /** 提交里程碑签字。 */
  const submitSignoff = async (milestoneId) => {
    const slot = feedback(`signoff:${milestoneId}`);
    const built = signoffFormState({
      values: {
        department: value(`[data-signoff="department"][data-milestone="${milestoneId}"]`),
        content: value(`[data-signoff="content"][data-milestone="${milestoneId}"]`),
      },
    });
    if (!built.payload) {
      const html = errorState({
        message: '还有必填项没填好',
        hint: built.errors.map((e) => e.message).join('；'),
      });
      if (slot) slot.innerHTML = html;
      return;
    }
    try {
      await ctx.api.post(`/api/milestones/${encodeURIComponent(milestoneId)}/signoff`, built.payload);
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已签字',
          items: ['签字已记入（只确认客观事实，不进总分）。'],
        });
      }
      // ⚠️ 成功后**重新拉清单**（不是本地改状态）⇒ 显示的永远是服务端口径。
      await loadWorklist();
    } catch (e) {
      if (slot) {
        slot.innerHTML = errorState({
          message: e?.message ?? '签字失败',
          hint: '点「重试」会按当前填写的内容重新提交一次。',
        });
      }
    }
  };

  /** 撤回签字（破坏性动作 ⇒ 二次确认在点击「撤回」时展开）。 */
  const openWithdraw = (milestoneId) => {
    const box = wrap.querySelector(`[data-confirm="withdraw"][data-milestone="${milestoneId}"]`);
    if (!box) return;
    box.hidden = false;
    const btn = box.querySelector?.('[data-action="withdraw-confirm"]');
    btn?.focus?.();
  };

  const closeWithdraw = (milestoneId) => {
    const box = wrap.querySelector(`[data-confirm="withdraw"][data-milestone="${milestoneId}"]`);
    if (box) box.hidden = true;
  };

  const submitWithdraw = async (milestoneId, signoffId) => {
    const slot = feedback(`withdraw:${milestoneId}`);
    const built = buildWithdrawPayload({ signoffId });
    if (!built.payload) {
      if (slot) slot.innerHTML = errorState({ message: built.errors[0].message });
      return;
    }
    try {
      await ctx.api.post(
        `/api/milestones/${encodeURIComponent(milestoneId)}/signoff/withdraw`,
        built.payload,
      );
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已撤回',
          items: ['该里程碑回到「未达成」，段位会重算降档。'],
        });
      }
      await loadWorklist();
    } catch (e) {
      if (slot) {
        slot.innerHTML = errorState({
          message: e?.message ?? '撤回失败',
          hint: '点「重试」会重新发一次撤回请求。',
        });
      }
    }
  };

  /** 提交企业双签。 */
  const submitEnterpriseConfirm = async () => {
    const slot = feedback('confirm');
    const rows = enterpriseConfirmRows(state.board);
    const teamId = value('[data-confirm="team"]') || state.selectedTeamId;
    const row = rows.find((r) => r.teamId === teamId) ?? null;
    const dimension = value('[data-confirm="dimension"]')
      || (Array.isArray(state.board?.dimensions) ? state.board.dimensions[0]?.key ?? '' : '');
    // ⚠️ 组委会代录时要把 enterpriseId 带上（否则后端会把「委员会」当成出题企业）。
    const myEnterpriseId = String(state.board?.myEnterpriseId ?? '');
    const signatory = row?.enterpriseId && row.enterpriseId !== myEnterpriseId ? row.enterpriseId : '';
    const built = enterpriseConfirmPayload({
      teamId,
      dimension,
      rawScore: value('[data-confirm="rawScore"]'),
      content: value('[data-confirm="content"]'),
      crossJudgeId: value('[data-confirm="crossJudge"]'),
      enterpriseId: signatory,
    });
    if (!built.payload) {
      if (slot) {
        slot.innerHTML = errorState({
          message: '还有必填项没填好',
          hint: built.errors.map((e) => e.message).join('；'),
        });
      }
      return;
    }
    const stage = encodeURIComponent(state.stageId);
    try {
      await ctx.api.post(`/api/stages/${stage}/enterprise-confirmations`, built.payload);
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已提交企业确认',
          items: ['企业签字 + 跨领域评委签字已一并记入（R2 双签齐全）。'],
        });
      }
      await loadBoard();
    } catch (e) {
      if (slot) {
        slot.innerHTML = errorState({
          message: e?.message ?? '提交失败',
          hint: '点「重试」会按当前填写的内容重新提交一次。',
        });
      }
    }
  };

  /**
   * 撤回一条企业确认（P11 · E141）。
   * ⚠️ 撤回是软删：证据留痕（deleted_at + 审计日志），但该队企业席计分归零。
   */
  const submitConfirmWithdraw = async (confirmationId) => {
    const slot = feedback('confirm');
    const stage = encodeURIComponent(state.stageId);
    try {
      await ctx.api.post(`/api/stages/${stage}/enterprise-confirmations/${encodeURIComponent(confirmationId)}/withdraw`, {});
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已撤回企业确认',
          items: ['该条确认已失效（证据留痕）。请重新计算并重新发榜 —— 名次与段位会跟着变。'],
        });
      }
      await loadBoard();
    } catch (e) {
      if (slot) {
        slot.innerHTML = errorState({
          message: e?.message ?? '撤回失败',
          hint: '只有签字的出题企业（或组委会）可以撤回。',
        });
      }
    }
  };

  /**
   * 改签一条企业确认（P11 · E141 + E148①）。
   * ⚠️ 表单里现在的分数 / 内容就是改签后的值；
   *    **缺的那一半跨领域签字**在改签时一并**后补**（R2 双签的后补路径）。
   */
  const submitConfirmResign = async (confirmationId, teamId) => {
    const slot = feedback('confirm');
    const rows = enterpriseConfirmRows(state.board);
    const row = rows.find((r) => r.teamId === teamId) ?? null;
    const stage = encodeURIComponent(state.stageId);
    const payload = {};
    const scoreText = value('[data-confirm="rawScore"]');
    const score = Number(scoreText);
    if (scoreText !== '' && Number.isFinite(score)) payload.rawScore = score;
    const content = value('[data-confirm="content"]');
    if (content) payload.content = content;
    // ⛔ 只有**缺**双签时才补 crossJudgeId（已有签字的不覆盖别人的签名）
    if (row && !row.hasCrossJudge) {
      const judge = value('[data-confirm="crossJudge"]');
      if (judge) payload.crossJudgeId = judge;
    }
    try {
      await ctx.api.post(
        `/api/stages/${stage}/enterprise-confirmations/${encodeURIComponent(confirmationId)}/resign`,
        payload,
      );
      if (slot) {
        slot.innerHTML = noticeState({
          tone: 'success',
          title: '已改签',
          items: ['改签已生效（原记录留痕）。请重新计算并重新发榜 —— 名次与段位会跟着变。'],
        });
      }
      await loadBoard();
    } catch (e) {
      if (slot) {
        slot.innerHTML = errorState({
          message: e?.message ?? '改签失败',
          hint: '内容与分数只能由签字的出题企业（或组委会）改；跨领域评委只能给自己补签。',
        });
      }
    }
  };

  // 首屏：两个区块各自加载，互不牵连（一个失败不拖垮另一个）。
  await loadStages();
  await loadWorklist();
  await loadBoard();

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘（反馈位 / 确认区）不会丢监听。
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      const kind = btn.closest?.('[data-retry-kind]')?.dataset?.retryKind;
      if (kind === 'board') loadBoard();
      else loadWorklist();
      return;
    }
    if (action === 'signoff-submit') {
      submitSignoff(btn.dataset.milestone);
      return;
    }
    if (action === 'withdraw') {
      openWithdraw(btn.dataset.milestone);
      return;
    }
    if (action === 'withdraw-cancel') {
      closeWithdraw(btn.dataset.milestone);
      return;
    }
    if (action === 'withdraw-confirm') {
      submitWithdraw(btn.dataset.milestone, btn.dataset.signoff);
      return;
    }
    if (action === 'confirm-submit') {
      submitEnterpriseConfirm();
      return;
    }
    // ⛔ P11 · E141：撤回（破坏性 ⇒ 二次确认）
    if (action === 'confirm-withdraw') {
      const box = wrap.querySelector(`[data-confirm="confirm-withdraw"][data-confirmation="${btn.dataset.confirmation}"]`);
      if (box) box.hidden = false;
      return;
    }
    if (action === 'confirm-withdraw-cancel') {
      const box = wrap.querySelector(`[data-confirm="confirm-withdraw"][data-confirmation="${btn.dataset.confirmation}"]`);
      if (box) box.hidden = true;
      return;
    }
    if (action === 'confirm-withdraw-confirm') {
      submitConfirmWithdraw(btn.dataset.confirmation);
      return;
    }
    // ⛔ P11 · E141 + E148①：改签（更正内容 / 分数；缺的那一半签字就在这里**后补**）
    if (action === 'confirm-resign') {
      submitConfirmResign(btn.dataset.confirmation, btn.dataset.team);
      return;
    }
  });

  // 换赛段 / 换队伍：只改「相关的下拉」，不整页重绘（否则会冲掉已填的分数与内容）。
  wrap.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.confirm;
    if (kind === 'stage') {
      state.stageId = el.value;
      state.selectedTeamId = '';
      state.selectedJudgeId = '';
      loadBoard();
      return;
    }
    if (kind === 'team') {
      state.selectedTeamId = el.value;
      state.selectedJudgeId = '';
      const rows = enterpriseConfirmRows(state.board);
      const row = rows.find((r) => r.teamId === state.selectedTeamId) ?? null;
      const candidates = crossJudgeCandidates(state.board, { signatoryId: row?.enterpriseId ?? null });
      const judge = wrap.querySelector('[data-confirm="crossJudge"]');
      if (judge) {
        judge.innerHTML = judgeOptionsHtml(candidates, '');
        judge.value = '';
      }
    }
  });

  return wrap;
}

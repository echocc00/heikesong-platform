// web/views/stages.js — 赛段配置与权重表（组委会 · P11 新建）
//
// 规则溯源（每条设计依据都指到具体规则 / 设计文档章节）：
//   - 「组委会视角 → **赛段配置与权重表**」→ 设计文档 §9「前端信息架构」（IA 图第 883 行）
//     —— 这一块界面在 §9 里明写存在，但 P11 之前**一个界面都没有** ⇒
//        六个写端点（建段 / 改配置 / 派评委 / 撤评委 / 报名册 / 退名册）在产品里零调用方。
//   - 六个写端点 + 两个读口的形状 → src/http/routes/stages.js（P11 补齐）
//     规则与校验全在 src/services/stage.js（路由层只接线，不复制规则）。
//   - 「赛段从属于届期」→ src/db/repo/stages.js（stages.edition_id 外键）
//     ⇒ 建段是 `POST /api/editions/:editionId/stages`，页面必须先有届期。
//   - 「席构成：企业席 ≥30% / 专家席 ≤50%；观察席无投票权」→ S7 §3.4（R-JDG-11）
//     + rules/scoring-initial.json 的 judgePool
//     ⛔ **页面不复制这套校验**（服务端会校验）—— 前端照抄一遍必然与服务端漂移。
//   - 「利益冲突声明随席位同事务写入」→ S7 §3.4（R-JDG-18）
//     + src/services/stage.js 的 assignStageJudgeToStage。
//   - 「权重表只读：改一份 JSON、重启即生效」→ 设计文档 S-2
//     ⇒ 页面**只展示**当前用的是哪一张表 + 席构成约束，不提供改权重的入口。
//   - 「权重表端点是**届期作用域**」→ `GET /api/editions/:editionId/scoring-configs`
//     ⛔ 曾经按 global 作用域判能力点，而赛段的写端点（建段 / 改配置 / 派评委）接受
//        **edition 级或 stage 级**的 stage:compute ⇒ 会出现「能改赛段、却读不到权重表」
//        的前后端不一致 ⇒ 页面拿不到席构成约束，组委会无法判断席够不够合法。
//        ⇒ 统一成届期作用域（页面的读口与写口同域）。
//   - 「三态状态码：404 不存在 / 403 没权限 / 200 成功」→ 设计文档 §7.3
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//     ⇒ 按钮**始终渲染**；403 时把服务端的中文原因显示出来。
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js 文件头（本仓已踩过的坑）
//   - 「HTML 文本插值一律过 escapeHtml（全站唯一转义入口）」→ web/escape.js
//   - 「加载 / 空 / 错三态用现成组件，不自己造」→ web/ui.js
//
// ⚠️ **为什么这个视图不判权限**：能不能配赛段、能不能派评委，一律由 API 裁决
//   （全局约束「授权的唯一裁决者是 can()，前端只拿到提示」）。
//   ⇒ 表单按钮**始终渲染**；被 403 时页面显示「没有权限」，而不是空白页或前端自行藏按钮。
//
// ⚠️ **权重表的顺序按「声明序」**（rules/scoring-*.json 里的顺序），不按权重降序：
//   规则文件里同一席的维度是**连着写**的（judge 维度在前、enterprise 维度在后），
//   按权重重排会把企业维度插进评委维度中间 ⇒ 席分组被拆散，反而看不出「哪张表」。
//   权重合计单独一行给出（100% ⇒ 页面能一眼看出表是完整的）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, kvList, loadingState, noticeState, pageHead,
  panel, sectionTitle, statRow, tableWrap, workbench, workbenchItem,
} from '../ui.js';

// ── 枚举（口径与服务层 src/services/stage.js 同一份）──────────────────
// ⛔ 这些是**下拉框的选项**，不是校验：真正的校验在服务端（rules 与枚举都由服务端说了算）。
//    前端复制一份枚举只为「不让人手打一个服务端不认的值」，不参与任何判定。

/** 赛段类型（src/services/stage.js: STAGE_KINDS）。 */
export const STAGE_KINDS = [
  { value: 'initial', label: '初赛', tone: 'brand' },
  { value: 'final', label: '决赛', tone: 'success' },
  { value: 'roadshow', label: '路演', tone: 'info' },
  { value: 'landing', label: '落地', tone: 'neutral' },
];

/** 评委席类型（src/services/stage.js: JUDGE_SEATS）。 */
export const JUDGE_SEATS = [
  { value: 'judge', label: '评委席', tone: 'brand', voting: true },
  { value: 'enterprise', label: '企业席', tone: 'info', voting: true },
  { value: 'observer', label: '观察席 · 无投票权', tone: 'neutral', voting: false },
];

/** 可用的权重表键（src/services/stage.js: SCORING_CONFIG_KEYS）。 */
export const SCORING_CONFIG_KEYS = ['initial', 'final'];

// ── 小工具（纯函数）───────────────────────────────────────────────────

/** 时间 → 「2026-10-20 12:00」（不合法就原样显示，别显示 Invalid Date）。 */
export function fmtStageTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 时间 → `<input type="datetime-local">` 的值（「2026-10-20T12:00」）。
 * ⚠️ 服务端 `Date.parse` 接受 ISO 与 YYYY-MM-DD；datetime-local 给的是**本地时间**，
 *    与展示用的 fmtStageTime（本地时间）同一口径 ⇒ 存进去和显示出来不会差一个时区。
 */
export function toLocalInput(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 权重 → 「20%」（0.2 → 20%）。 */
export function fmtWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const pct = Math.round(n * 1000) / 10;
  return `${pct}%`;
}

/**
 * `<input type="datetime-local">` 的值 → ISO 字符串（发给服务端前统一转一道）。
 * ⚠️ datetime-local 给的是**本地时间**（"2026-10-20T12:00"），直接存进库会和
 *    其它端点写入的 ISO 串格式不一致 ⇒ 统一转成 ISO（同一个时刻，不改语义）。
 */
export function toIso(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text;
  return d.toISOString();
}

/** 赛段类型 → { label, tone }（未知值原样透出，不静默吞掉）。 */
export function stageKindLabel(kind) {
  const hit = STAGE_KINDS.find((k) => k.value === String(kind ?? ''));
  return hit ? { label: hit.label, tone: hit.tone } : { label: String(kind ?? '—'), tone: 'neutral' };
}

/** 赛段状态 → { label, tone }。 */
export function stageStatusLabel(status) {
  const raw = String(status ?? '').trim();
  if (raw === 'draft') return { label: '草稿', tone: 'neutral' };
  if (raw === 'open' || raw === 'active') return { label: '进行中', tone: 'success' };
  if (raw === 'closed' || raw === 'finished') return { label: '已结束', tone: 'neutral' };
  if (raw === 'computed') return { label: '已计算', tone: 'info' };
  if (raw === 'published') return { label: '已发榜', tone: 'success' };
  return { label: raw || '—', tone: 'neutral' };
}

/**
 * 席位 → { label, tone, voting }。
 * ⚠️ observer 的标签里**必须**写明「无投票权」（S7 §3.4 / R-JDG-11）：
 *    组委会派一个观察席进来，是为了「看」而不是「评」—— 标签不写清楚，
 *    就会有评委以为自己也有票，事后才发现投不了。
 */
export function judgeSeatLabel(seat) {
  const hit = JUDGE_SEATS.find((s) => s.value === String(seat ?? ''));
  return hit
    ? { label: hit.label, tone: hit.tone, voting: hit.voting }
    : { label: String(seat ?? '—'), tone: 'neutral', voting: false };
}

/**
 * 三态状态码 → 人话（纯函数）。
 * ⛔ 403 必须说「没有权限」而不是「请求失败」—— 设计文档 §7.3 的三态就是给用户看的。
 * @param {number|string} status
 * @param {string} message 服务端给的中文原因（403 时优先用它，因为它最具体）
 */
export function stageErrorText(status, message) {
  const code = Number(status);
  const serverMsg = String(message ?? '').trim();
  if (code === 403) {
    return serverMsg
      ? `没有权限：${serverMsg}`
      : '没有权限：赛段配置需要组委会能力（stage:compute）。';
  }
  if (code === 404) {
    return serverMsg ? `对象不存在：${serverMsg}` : '对象不存在：赛段或届期可能已被删除。';
  }
  if (code === 401) return '请先登录后再配置赛段。';
  return serverMsg || '加载失败，请重试。';
}

/** 选项列表（纯 HTML）。 */
function optionsHtml(items, selected) {
  return (items ?? [])
    .map((it) => `<option value="${escapeHtml(it.value)}"${String(it.value) === String(selected ?? '') ? ' selected' : ''}>${escapeHtml(it.label)}</option>`)
    .join('');
}

/** 取值：数组优先（规则文件里就是数组），也认单个字符串。 */
function seatList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x ?? '')).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：届期 / 赛段列表
// ══════════════════════════════════════════════════════════════════

/**
 * 「哪一届是当届」（纯函数）。
 * ⚠️ 判据与 src/http/routes/registration.js 的 pickCurrentEdition 同款：
 *    **尚未结束**（ends_at >= 今天）的最早一届；都没有就退回最后一届。
 *    （不能用「最新一届」—— 那会把评委导到还没开赛的届期去。）
 */
export function pickCurrentEdition(editions, today = new Date().toISOString().slice(0, 10)) {
  const list = Array.isArray(editions) ? editions : [];
  if (!list.length) return null;
  const day = String(today).slice(0, 10);
  const started = list.filter((e) => String(e?.endsAt ?? e?.ends_at ?? '') >= day);
  if (started.length) return started[0];
  return list[list.length - 1];
}

/** 届期选择器（纯 HTML）。 */
export function editionPickerHtml(editions, editionId) {
  const list = Array.isArray(editions) ? editions : [];
  if (!list.length) {
    return '<p class="muted small">还没有届期 —— 届期是赛段的容器，组委会先建届期才能建赛段。</p>';
  }
  const items = list.map((e) => ({
    value: e.id,
    label: `${e.name ?? e.id}${e.city ? `（${e.city}）` : ''}${e.startsAt ? ` · ${fmtStageTime(e.startsAt)}` : ''}`,
  }));
  return `<div class="field">
      <label class="field__label" for="stage-edition">届期</label>
      <select class="select" id="stage-edition" data-stage="edition">
        ${optionsHtml(items, editionId)}
      </select>
      <p class="field__hint">赛段从属于届期：建段、改配置、派评委、报名册都在本届期下操作。</p>
    </div>`;
}

/**
 * 赛段列表（纯 HTML）：左轨里的**赛段选择器**。
 *
 * ⚠️ **P12：从表格改成列表**（不是为了好看，是因为表格放不下）：
 *    改版前这里是一张 6 列表格（代号/名称/类型/时间窗/状态/操作），
 *    而整个页面是「一列面板一字排开」⇒ 表格和 5 张操作面板**同权重**，
 *    访客在一屏里既找不到「我现在操作的是哪个赛段」，也读不完一张宽表。
 *    ⇒ 改成左轨的**条目列表**（代号 / 名称 / 类型·状态·时间窗一行），
 *      当前赛段用 `is-active` 着色（tinted）标出。
 *    ⚠️ **类型与状态用纯文字而不是 badge**：左轨是导航面，
 *      再往里塞彩色徽章会把「每屏强调色 ≤ 3」顶破（实测赛段配置页曾出现 4 档）。
 * @param {Array}  stages      赛段列表
 * @param {string} selectedId  当前选中的赛段 id
 */
export function stageListHtml(stages, selectedId) {
  const list = Array.isArray(stages) ? stages : [];
  if (!list.length) {
    return emptyState({
      title: '本届期还没有赛段',
      hint: '用下面的「新建赛段」建一条 —— 评审、发榜、破同分、企业签字台全都挂在赛段上，没有赛段这些页面一个都进不去。',
    });
  }
  const items = list.map((s) => {
    const kind = stageKindLabel(s.kind);
    const status = stageStatusLabel(s.status);
    const on = String(s.id ?? '') === String(selectedId ?? '');
    const window = `${fmtStageTime(s.startsAt) || '—'} → ${fmtStageTime(s.endsAt) || '—'}`;
    // ⚠️ 条目的形状由 web/ui.js 的 workbenchItem() 统一产出
    //    （条件 class 不许在视图里用模板表达式拼 —— 见 ui.js 的说明）。
    return `<li>${workbenchItem({
      key: s.key ?? '—',
      name: s.name ?? '—',
      meta: `${kind.label} · ${status.label} · ${window}`,
      active: on,
      action: 'stage-select',
      dataKey: 'stage-id',
      dataValue: s.id ?? '',
    })}</li>`;
  }).join('');
  return `<ul class="workbench__list">${items}</ul>`;
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：建段 / 改配置
// ══════════════════════════════════════════════════════════════════

/** 权重表下拉的选项（规则列表优先，取不到就退回枚举）。 */
function scoringOptions(configs, selected) {
  const list = Array.isArray(configs) ? configs : [];
  const items = list.length
    ? list.map((c) => ({ value: c.key, label: `${c.key}${c.version ? `（${c.version}）` : ''}` }))
    : SCORING_CONFIG_KEYS.map((k) => ({ value: k, label: k }));
  // 选中的键不在列表里也保留它（服务端的规则可能比前端读到的多）
  const values = items.map((i) => String(i.value));
  if (selected && !values.includes(String(selected))) {
    items.push({ value: selected, label: `${selected}（规则里暂未读到）` });
  }
  return items;
}

/** 新建赛段表单（纯 HTML）。 */
export function stageCreateFormHtml({ draft = {}, configs = [] } = {}) {
  const kindItems = STAGE_KINDS.map((k) => ({ value: k.value, label: k.label }));
  const configItems = scoringOptions(configs, draft.scoringConfigKey ?? 'initial');
  return `<div class="field">
      <label class="field__label" for="stage-new-key">赛段代号</label>
      <input class="input" id="stage-new-key" type="text" autocomplete="off"
        placeholder="如 initial / final" value="${escapeHtml(draft.key ?? '')}" data-stage="new-key" />
      <p class="field__hint">代号建后不可改（它进 URL 与日志）：只能用字母、数字、连字符与下划线，同一届期内不能重复。</p>
    </div>
    <div class="field field--required">
      <label class="field__label" for="stage-new-name">赛段名称</label>
      <input class="input" id="stage-new-name" type="text" autocomplete="off"
        placeholder="如 初赛评审" value="${escapeHtml(draft.name ?? '')}" data-stage="new-name" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-kind">赛段类型</label>
      <select class="select" id="stage-new-kind" data-stage="new-kind">${optionsHtml(kindItems, draft.kind ?? 'initial')}</select>
      <p class="field__hint">类型建后不可改：类型决定赛段在赛程里的位置与要交付的东西。</p>
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-config">权重表</label>
      <select class="select" id="stage-new-config" data-stage="new-config">${optionsHtml(configItems, draft.scoringConfigKey ?? 'initial')}</select>
      <p class="field__hint">权重表来自 rules/scoring-*.json（改文件、重启即生效）—— 这里只选择用哪一张。</p>
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-starts">开始时间</label>
      <input class="input" id="stage-new-starts" type="datetime-local" value="${escapeHtml(toLocalInput(draft.startsAt))}" data-stage="new-starts" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-ends">结束时间</label>
      <input class="input" id="stage-new-ends" type="datetime-local" value="${escapeHtml(toLocalInput(draft.endsAt))}" data-stage="new-ends" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-new-freeze">冻结时间</label>
      <input class="input" id="stage-new-freeze" type="datetime-local" value="${escapeHtml(toLocalInput(draft.freezeAt))}" data-stage="new-freeze" />
      <p class="field__hint">冻结后不再接受本赛段的评分（可留空）。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="stage-create-submit">创建赛段</button>
    </div>`;
}

/**
 * 赛段配置（改配置）表单（纯 HTML）。
 * ⚠️ **key 与 kind 建后不可改** ⇒ 置灰（disabled）而不是隐藏 ——
 *    隐藏会让组委会以为「这里能改」，于是到处找入口。
 *
 * ⚠️ **列表端点只给摘要**（id / key / name / kind / status / startsAt / endsAt），
 *    **不含** freezeAt 与 scoringConfigKey ⇒ 这两项无法回填。
 *    ⛔ 因此这两项**没被改动就不提交**（服务端的 PATCH 语义是「undefined = 不改」）
 *       —— 否则一次「只改名字」的保存会把冻结时间清空、把权重表换成默认值。
 */
export function stageConfigHtml({ stage = null, draft = {}, configs = [] } = {}) {
  if (!stage) {
    return emptyState({
      title: '先选一个赛段',
      hint: '在上方列表点「进入配置」，这里会显示该赛段的时间窗、冻结时间与用的权重表。',
    });
  }
  const kind = stageKindLabel(stage.kind);
  const keyKnown = stage.scoringConfigKeyKnown !== false;
  const freezeKnown = stage.freezeAtKnown !== false;
  const currentKey = String(stage.scoringConfigKey ?? stage.scoring_config_key ?? '');
  // 草稿优先（用户改过）⇒ 回显用户选的那一张；否则回显当前在用的那张。
  const selectedKey = String(draft.scoringConfigKey || currentKey || '');
  const configItems = scoringOptions(configs, selectedKey);
  const status = stageStatusLabel(stage.status);
  return `<div class="row">
      ${badge(`代号 ${stage.key ?? '—'}`, 'neutral')}
      ${badge(kind.label, kind.tone)}
      ${badge(status.label, status.tone)}
    </div>
    ${(keyKnown && freezeKnown) ? '' : noticeState({
      tone: 'warn',
      title: '这两项没有随赛段列表返回',
      items: [
        '赛段列表端点只返回摘要（代号 / 名称 / 类型 / 时间窗 / 状态），不含冻结时间与权重表键 ⇒ 页面无法回填它们的当前值。',
        '没有改动的字段不会被提交（服务端的改配置语义是「不传 = 不改」）⇒ 保存一次不会误清空已有的冻结时间，也不会把权重表换成默认值。',
      ],
    })}
    <div class="field">
      <label class="field__label" for="stage-cfg-key">赛段代号（建后不可改）</label>
      <input class="input" id="stage-cfg-key" type="text" value="${escapeHtml(stage.key ?? '')}" disabled />
      <p class="field__hint">代号进 URL 与日志，建后不改；要换代号请新建赛段。</p>
    </div>
    <div class="field field--required">
      <label class="field__label" for="stage-cfg-name">赛段名称</label>
      <input class="input" id="stage-cfg-name" type="text" autocomplete="off" value="${escapeHtml(draft.name ?? stage.name ?? '')}" data-stage="cfg-name" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-kind">赛段类型（建后不可改）</label>
      <select class="select" id="stage-cfg-kind" disabled>${optionsHtml(STAGE_KINDS.map((k) => ({ value: k.value, label: k.label })), stage.kind)}</select>
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-config">权重表</label>
      <select class="select" id="stage-cfg-config" data-stage="cfg-config">${optionsHtml(configItems, selectedKey)}</select>
      <p class="field__hint">权重表来自规则文件，页面只读展示（改表要改 rules/scoring-*.json，重启即生效）。已有评分数据时服务端会拒绝换表（历史评分将不可复算）。</p>
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-starts">开始时间</label>
      <input class="input" id="stage-cfg-starts" type="datetime-local" value="${escapeHtml(toLocalInput(draft.startsAt ?? stage.startsAt))}" data-stage="cfg-starts" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-ends">结束时间</label>
      <input class="input" id="stage-cfg-ends" type="datetime-local" value="${escapeHtml(toLocalInput(draft.endsAt ?? stage.endsAt))}" data-stage="cfg-ends" />
    </div>
    <div class="field">
      <label class="field__label" for="stage-cfg-freeze">冻结时间</label>
      <input class="input" id="stage-cfg-freeze" type="datetime-local" value="${escapeHtml(toLocalInput(draft.freezeAt ?? stage.freezeAt))}" data-stage="cfg-freeze" />
      <p class="field__hint">冻结后不再接受本赛段的评分（可留空）。</p>
    </div>
    <div class="row">
      <button type="button" class="btn btn--primary" data-action="stage-update-submit">保存赛段配置</button>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 三、纯函数：权重表（只读）
// ══════════════════════════════════════════════════════════════════

/**
 * 权重表（**只读**）—— 纯函数。
 *
 * ⚠️ 三种降级必须分清楚，不能都写成「没数据」：
 *   ① 规则文件没加载上来（权重表读口拿不到）⇒ 「规则未加载」，**不阻断其余面板**；
 *   ② 规则加载了但这个键不在里面 ⇒ 「权重表未找到」（多半是服务端规则与前端读到的版本不一致）；
 *   ③ 找到了 ⇒ 展示维度表 + 席构成约束。
 *
 * @param {object} o
 * @param {Array<object>} o.configs       `GET /api/editions/:editionId/scoring-configs` 的 items
 * @param {string} o.scoringConfigKey     当前赛段在用的权重表键
 * @param {boolean} o.degraded            规则是否没加载上来
 * @param {number|string} o.degradedStatus 降级时的 HTTP 状态码（403 要说「没有权限」）
 */
export function weightTableHtml({ configs = [], scoringConfigKey = '', degraded = false, degradedStatus = null } = {}) {
  if (degraded) {
    const forbidden = Number(degradedStatus) === 403;
    return noticeState({
      tone: 'warn',
      title: '规则未加载',
      items: [
        '权重表来自 rules/scoring-*.json（改一份 JSON、重启即生效），此刻拿不到规则文件，权重表暂时显示不出来。',
        forbidden
          ? '读取权重表没有权限（权重表端点是届期作用域的读口，需要该届期的组委会能力）。'
          : '其余面板（赛段配置 / 评委席 / 名册）不受影响，可以照常操作。',
      ],
    });
  }
  const list = Array.isArray(configs) ? configs : [];
  if (!list.length) {
    return emptyState({
      title: '规则未加载',
      hint: '权重表来自 rules/scoring-*.json（改一份 JSON、重启即生效）。此刻没有读到任何权重表，其余面板不受影响。',
    });
  }
  const key = String(scoringConfigKey ?? '');
  const config = list.find((c) => String(c?.key ?? '') === key);
  if (!config && !key) {
    // ⚠️ **「不知道当前用的是哪一张」≠「权重表不存在」** ——
    //   赛段列表端点只返回摘要（没有权重表键）⇒ 页面无从知道当前那一张。
    //   这时不能报「权重表未找到」（那是误导），而是把规则里可用的都列出来。
    const available = list.map((c) => `<tr>
      <td>${escapeHtml(c.key ?? '—')}</td>
      <td>${escapeHtml(c.version ?? '—')}</td>
      <td class="td-num num">${escapeHtml(String((Array.isArray(c.dimensions) ? c.dimensions : []).length))}</td>
    </tr>`).join('');
    return noticeState({
      tone: 'info',
      title: '这个赛段在用哪一张权重表，页面现在还不知道',
      items: [
        '赛段列表端点只返回摘要（不含权重表键）⇒ 页面显示不出「当前在用的那一张」。',
        '下面是规则里可用的权重表；在上面的「赛段配置」里选一张保存，就会写进这个赛段。',
      ],
    }) + tableWrap(
      `<thead><tr><th>权重表</th><th>版本</th><th class="td-num">维度数</th></tr></thead>
       <tbody>${available}</tbody>`,
      { caption: '规则里可用的权重表' },
    );
  }
  if (!config) {
    return noticeState({
      tone: 'warn',
      title: '权重表未找到',
      items: [
        key
          ? `这个赛段在用权重表「${key}」，但规则文件里没有找到这一张。`
          : '这个赛段没有设置权重表键。',
        '权重表只在规则文件里（rules/scoring-*.json），页面不提供改权重的入口 —— 请检查服务端规则是否与该赛段匹配。',
      ],
    });
  }

  const dims = Array.isArray(config.dimensions) ? config.dimensions : [];
  const pool = config.judgePool ?? {};
  const voting = seatList(pool.votingSeats);
  const nonVoting = seatList(pool.nonVotingSeats);
  const seatName = (seat) => {
    const hit = JUDGE_SEATS.find((s) => s.value === String(seat ?? ''));
    return hit ? hit.label : String(seat ?? '—');
  };
  const sum = dims.reduce((acc, d) => acc + (Number(d?.weight) || 0), 0);

  const dimTable = dims.length
    ? tableWrap(
      `<thead><tr><th>维度</th><th>键</th><th class="td-num">权重</th><th>计分席</th></tr></thead>
       <tbody>${dims.map((d) => `<tr>
         <td>${escapeHtml(d?.name ?? d?.key ?? '—')}</td>
         <td>${escapeHtml(d?.key ?? '—')}</td>
         <td class="td-num num">${escapeHtml(fmtWeight(d?.weight))}</td>
         <td>${escapeHtml(seatName(d?.seat))}</td>
       </tr>`).join('')}
       <tr>
         <td>合计</td>
         <td>—</td>
         <td class="td-num num">${escapeHtml(fmtWeight(sum))}</td>
         <td>—</td>
       </tr></tbody>`,
      { caption: `权重表 ${key}（按规则文件的声明序）` },
    )
    : emptyState({ title: '这张权重表没有维度', hint: '规则文件里的 dimensions 是空的。' });

  const poolRows = [
    ['每维度最少评委数', pool.minJudgesPerDimension === undefined ? '—' : String(pool.minJudgesPerDimension)],
    ['企业席最低占比', pool.minEnterpriseSeatShare === undefined ? '—' : fmtWeight(pool.minEnterpriseSeatShare)],
    ['专家席最高占比', pool.maxExpertSeatShare === undefined ? '—' : fmtWeight(pool.maxExpertSeatShare)],
    ['有投票权的席', voting.length ? voting.map(seatName).join('、') : '—'],
    ['无投票权的席', nonVoting.length ? nonVoting.map(seatName).join('、') : '—'],
  ];

  return `<div class="row">
      ${badge(`权重表 ${key}`, 'brand')}
      ${config.version ? badge(`版本 ${config.version}`, 'neutral') : ''}
      ${config.source ? badge(String(config.source), 'neutral') : ''}
    </div>
    ${config.note ? `<p class="muted small">${escapeHtml(config.note)}</p>` : ''}
    ${dimTable}
    ${sectionTitle('席构成约束')}
    ${kvList(poolRows)}
    <p class="muted small">以上约束由服务端校验（企业席 ≥30%、专家席 ≤50%）；页面不复制这套判定。</p>
    <p class="muted small">权重表只读：要改权重，改 rules/scoring-*.json 这一份 JSON，重启即生效。</p>`;
}

// ══════════════════════════════════════════════════════════════════
// 四、纯函数：评委席
// ══════════════════════════════════════════════════════════════════

/**
 * 评委席面板（纯函数）。
 * @param {object} o
 * @param {Array<object>} o.judges      `GET /api/stages/:stageId/judges` 的 judges
 * @param {Array<object>} o.candidates  `GET /api/editions/:editionId/judge-candidates` 的 items
 * @param {object} o.draft             { userId, seat }
 * @param {object|null} o.pending       待确认撤下的评委 { userId }
 */
export function judgeSeatHtml({ judges = [], candidates = [], draft = {}, pending = null, stageName = '' } = {}) {
  const list = Array.isArray(judges) ? judges : [];
  const pool = Array.isArray(candidates) ? candidates : [];
  const nameOf = (userId) => {
    const hit = pool.find((c) => String(c?.id ?? '') === String(userId ?? ''));
    return hit ? { name: hit.name ?? hit.id, org: hit.org ?? '' } : { name: String(userId ?? '—'), org: '' };
  };

  const table = list.length
    ? tableWrap(
      `<thead><tr><th>评委</th><th>席位</th><th>授权范围</th><th>派任时间</th><th>利益冲突声明</th><th></th></tr></thead>
       <tbody>${list.map((j) => {
        const who = nameOf(j.userId);
        const seat = judgeSeatLabel(j.seat);
        const scope = j.scopeId ? `${j.scopeType ?? 'global'} / ${j.scopeId}` : String(j.scopeType ?? 'global');
        const declared = j.conflictDeclaredAt
          ? `已声明 · ${fmtStageTime(j.conflictDeclaredAt)}`
          : '未声明';
        const isPending = pending && String(pending.userId ?? '') === String(j.userId ?? '');
        const actions = isPending
          ? removeJudgeConfirmHtml({ userId: j.userId, name: who.name, stageName })
          : `<button type="button" class="btn btn--ghost btn--sm" data-action="judge-remove-request" data-user-id="${escapeHtml(j.userId ?? '')}">撤评委</button>`;
        return `<tr>
          <td>${escapeHtml(who.name)}${who.org ? `<span class="muted small"> · ${escapeHtml(who.org)}</span>` : ''}<br><span class="muted small">${escapeHtml(j.userId ?? '')}</span></td>
          <td>${badge(seat.label, seat.tone)}</td>
          <td>${escapeHtml(scope)}</td>
          <td>${escapeHtml(fmtStageTime(j.assignedAt) || '—')}</td>
          <td>${escapeHtml(declared)}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}</tbody>`,
      { caption: '本赛段评委席' },
    )
    : emptyState({
      title: '本赛段还没有派评委',
      hint: '派评委要选「人 + 席」：观察席无投票权；企业席与专家席的比例由服务端校验。',
    });

  const assigned = new Set(list.map((j) => String(j.userId ?? '')));
  const selectable = pool.filter((c) => !assigned.has(String(c?.id ?? '')));
  const seatItems = JUDGE_SEATS.map((s) => ({ value: s.value, label: s.label }));
  const assignForm = selectable.length
    ? `<div class="field">
        <label class="field__label" for="stage-judge-user">评委</label>
        <select class="select" id="stage-judge-user" data-stage="judge-user">
          ${optionsHtml(selectable.map((c) => ({ value: c.id, label: `${c.name ?? c.id}${c.org ? `（${c.org}）` : ''}` })), draft.userId ?? '')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="stage-judge-seat">席位</label>
        <select class="select" id="stage-judge-seat" data-stage="judge-seat">${optionsHtml(seatItems, draft.seat ?? 'judge')}</select>
        <p class="field__hint">观察席无投票权；企业席 ≥30%、专家席 ≤50% 由服务端校验（页面不复制这套判定）。</p>
      </div>
      <div class="row">
        <button type="button" class="btn btn--primary" data-action="judge-assign-submit">派评委</button>
      </div>`
    : '<p class="muted small">候选池里的评委都已经在本赛段了（没有更多可派的）。</p>';

  return `${table}
    ${sectionTitle('派评委')}
    ${assignForm}`;
}

/**
 * 撤评委的二次确认块（纯函数 · 逆向路径）。
 *
 * ⚠️ **为什么要二次确认**：撤评委会连带**解除**他在本赛段签署的利益冲突声明
 *   （声明记录作为历史事实保留，不删除，但不再绑定任何席位）。
 *   ⇒ 文案必须写明影响面，而不是「确定吗？」。
 */
export function removeJudgeConfirmHtml({ userId = '', name = '', stageName = '' } = {}) {
  const who = name || userId;
  const where = stageName ? `赛段「${stageName}」` : '本赛段';
  return `<div class="notice notice--warn" data-stage-confirm="judge">
    <p class="notice__title">确认撤回该评委？</p>
    <p class="notice__text">撤回 ${escapeHtml(who)} 在${escapeHtml(where)}的席位后：他的席位立即失效，其在本赛段签署的<strong>利益冲突声明一并解除</strong>（声明记录作为历史事实保留，不会删除）；该评委不再计入本赛段的评委池与席构成校验，已提交的历史评分不受影响。</p>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="judge-remove-confirm" data-user-id="${escapeHtml(userId)}">确认撤回</button>
      <button type="button" class="btn btn--ghost" data-action="judge-remove-cancel">取消</button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 五、纯函数：名册
// ══════════════════════════════════════════════════════════════════

/**
 * 名册面板（纯函数）。
 * @param {object} o
 * @param {Array<object>} o.teams        `GET /api/editions/:editionId/teams` 的 items
 * @param {Array<string>} o.rosterTeamIds `GET /api/stages/:stageId/teams` 的 teamIds
 * @param {object|null} o.pending       待确认退名的队伍 { teamId }
 */
export function rosterHtml({ teams = [], rosterTeamIds = [], pending = null, stageName = '' } = {}) {
  const list = Array.isArray(teams) ? teams : [];
  const roster = new Set((Array.isArray(rosterTeamIds) ? rosterTeamIds : []).map((x) => String(x ?? '')));
  const nameOf = (id) => {
    const hit = list.find((t) => String(t?.id ?? '') === String(id ?? ''));
    return hit ? { name: hit.name ?? hit.id, tier: hit.tier ?? '' } : { name: String(id ?? '—'), tier: '' };
  };

  if (!list.length) {
    return emptyState({
      title: '本届期还没有队伍',
      hint: '名册登记的是「本届期的队伍」—— 没有队伍就没法往赛段里登记。',
    });
  }

  const rosterRows = list.filter((t) => roster.has(String(t?.id ?? '')));
  const rosterBlock = rosterRows.length
    ? tableWrap(
      `<thead><tr><th>队伍</th><th>段位</th><th>名册状态</th><th></th></tr></thead>
       <tbody>${rosterRows.map((t) => {
        const id = String(t?.id ?? '');
        const tier = t?.tier ?? '';
        const isPending = pending && String(pending.teamId ?? '') === id;
        const actions = isPending
          ? removeTeamConfirmHtml({ teamId: id, name: t?.name ?? id, stageName })
          : `<button type="button" class="btn btn--ghost btn--sm" data-action="roster-remove-request" data-team-id="${escapeHtml(id)}">退名册</button>`;
        return `<tr>
          <td>${escapeHtml(t?.name ?? id)}<br><span class="muted small">${escapeHtml(id)}</span></td>
          <td>${escapeHtml(tier || '—')}</td>
          <td>${badge('在榜', 'success')}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}</tbody>`,
      { caption: '本赛段名册（在榜队伍）' },
    )
    : emptyState({
      title: '本赛段名册还是空的',
      hint: '在下面勾选队伍登记进来 —— 名册里的队伍才会出现在本赛段的评审、发榜与名次里。',
    });

  const pendingIds = [...roster].filter((id) => !list.some((t) => String(t?.id ?? '') === id));
  const pickList = list
    .filter((t) => !roster.has(String(t?.id ?? '')))
    .map((t) => `<li class="row">
        <label class="row">
          <input type="checkbox" data-stage="roster-pick" data-team-id="${escapeHtml(t?.id ?? '')}" />
          <span>${escapeHtml(t?.name ?? t?.id ?? '')}${t?.tier ? ` <span class="muted small">${escapeHtml(t.tier)}</span>` : ''}</span>
        </label>
      </li>`)
    .join('');
  // ⚠️ 「登记所选队伍」按钮**必须**跟着勾选框一起出现 ——
  //   早先只在「名册非空」时渲染按钮 ⇒ 名册为空时用户勾了队却找不到提交按钮（死路）。
  const registerList = pickList
    ? `<ul class="list-divided">${pickList}</ul>
      <div class="row">
        <button type="button" class="btn btn--primary" data-action="roster-register-submit">登记所选队伍</button>
      </div>`
    : '<p class="muted small">本届期的队伍都已经在名册里了。</p>';

  const orphanNote = pendingIds.length
    ? `<p class="muted small">名册里还有 ${pendingIds.length} 支队伍不在本届期队伍列表中（可能已转队或被删除）：${pendingIds.map((id) => escapeHtml(nameOf(id).name)).join('、')}</p>`
    : '';

  return `${sectionTitle('本赛段名册')}
    ${rosterBlock}
    ${orphanNote}
    ${sectionTitle('登记队伍')}
    ${registerList}`;
}

/**
 * 退名册的二次确认块（纯函数 · 逆向路径）。
 * ⚠️ 退名册后，该队在本赛段的评分与确认**失效** ⇒ 文案必须写明影响面。
 */
export function removeTeamConfirmHtml({ teamId = '', name = '', stageName = '' } = {}) {
  const who = name || teamId;
  const where = stageName ? `赛段「${stageName}」` : '本赛段';
  return `<div class="notice notice--warn" data-stage-confirm="team">
    <p class="notice__title">确认把该队伍退名册？</p>
    <p class="notice__text">把 ${escapeHtml(who)} 从${escapeHtml(where)}的名册里退出后：该队在本赛段的<strong>评分与确认全部失效</strong>（已交的评分不再计入本赛段的计算与名次），名次与榜单也会随之变化。这一步是逆向操作，请确认。</p>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="roster-remove-confirm" data-team-id="${escapeHtml(teamId)}">确认退名册</button>
      <button type="button" class="btn btn--ghost" data-action="roster-remove-cancel">取消</button>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 六、整页
// ══════════════════════════════════════════════════════════════════

/** 顶部指标（纯函数）。 */
export function stageConfigStats(model = {}) {
  const stages = Array.isArray(model.stages) ? model.stages : [];
  const judges = Array.isArray(model.judges) ? model.judges : [];
  const roster = Array.isArray(model.rosterTeamIds) ? model.rosterTeamIds : [];
  const stage = model.stage ?? null;
  return [
    { label: '本届期赛段', value: stages.length, tone: 'brand' },
    { label: '本赛段评委席', value: stage ? judges.length : '—', hint: stage ? '观察席无投票权' : '先选一个赛段' },
    { label: '本赛段名册', value: stage ? roster.length : '—', hint: stage ? '在榜队伍数' : '先选一个赛段' },
    {
      label: '在用权重表',
      value: stage ? (stage.scoringConfigKey ?? stage.scoring_config_key ?? '—') : '—',
      tone: 'neutral',
      hint: '只读：改表要改 rules/scoring-*.json',
    },
  ];
}

/**
 * 整页 HTML（纯函数，可单测）。
 * @param {object} model {
 *   loading, error, errorStatus, editions, editionId, stages, stageId, stage,
 *   judges, candidates, teams, rosterTeamIds, configs, configsDegraded, feedback,
 *   drafts, pending
 * }
 */
/**
 * 赛段配置页（纯 HTML）。
 *
 * ⚠️ **P12：页面形状 = 操作台（左轨选对象 + 右画布做操作）**。
 *    改版前是「head + 指标行 + 6 张同款面板」的一字排开（实测顶层结构：
 *    div.stack > header + div.stat-row + section.panel × 6）⇒
 *    六个面板同权重同材质，访客既分不出主次，也找不到「我现在操作的是哪个赛段」。
 *    ⇒ 左轨 = 届期 + 赛段选择器（导航器 ⇒ 材质下沉）；
 *      右画布 = 指标 + 五个操作面板（工作面 ⇒ 材质浮起）。
 *    样式见 web/styles.css ⑫ 段；结构由 web/ui.js 的 workbench() 统一产出。
 */
export function stageConfigPageHtml(model = {}) {
  const head = pageHead({
    title: '赛段配置与权重表',
    sub: '组委会：建赛段、改配置、派评委、报名册；权重表来自规则文件，只读展示。',
  });

  const feedbackHtml = model.feedback
    ? noticeState({
      tone: model.feedback.tone ?? 'info',
      title: model.feedback.title ?? '',
      items: model.feedback.items ?? [],
      list: true,
    })
    : '';

  const editions = Array.isArray(model.editions) ? model.editions : [];
  const stages = Array.isArray(model.stages) ? model.stages : [];
  const railPanel = panel({
    title: '届期与赛段',
    desc: '赛段从属于届期：建段、改配置、派评委、报名册都在本届期下操作。',
    body: editionPickerHtml(editions, model.editionId ?? '') + stageListHtml(stages, model.stageId ?? ''),
  });

  if (model.loading) {
    // ⚠️ 加载中**不要**先渲染赛段列表（那时 stages 还是空数组 ⇒ 会闪一句
    //    「本届期还没有赛段」，那是**假消息**）⇒ 轨里只放加载态。
    return head + workbench({
      rail: panel({ title: '届期与赛段', body: loadingState({ rows: 2, label: '正在加载届期与赛段…' }) }),
      canvas: loadingState({ rows: 4, label: '正在加载赛段配置…' }),
    });
  }

  if (model.error) {
    return head + workbench({
      rail: railPanel,
      canvas: feedbackHtml + errorState({
        message: stageErrorText(model.errorStatus, model.error),
        hint: '赛段配置需要组委会能力（stage:compute）；确认已登录并拥有该能力后点「重试」。',
      }),
    });
  }

  const drafts = model.drafts ?? {};
  const stage = model.stage ?? null;

  return head + workbench({
    rail: railPanel,
    canvas: [
      feedbackHtml,
      statRow(stageConfigStats(model)),
      panel({
        title: '新建赛段',
        desc: '代号与类型建后不可改 —— 它们决定赛段在赛程里的位置。',
        body: stageCreateFormHtml({ draft: drafts.create ?? {}, configs: model.configs ?? [] }),
      }),
      panel({
        title: '赛段配置',
        desc: '改名称、时间窗、冻结时间与权重表；代号与类型不可改。',
        body: stageConfigHtml({ stage, draft: drafts.edit ?? {}, configs: model.configs ?? [] }),
      }),
      panel({
        title: '权重表（只读）',
        desc: '当前赛段用的是哪一张权重表、席构成约束是什么。改表要改 rules/scoring-*.json，重启即生效。',
        body: weightTableHtml({
          configs: model.configs ?? [],
          scoringConfigKey: stage?.scoringConfigKey ?? stage?.scoring_config_key ?? '',
          degraded: Boolean(model.configsDegraded),
          degradedStatus: model.configsStatus ?? null,
        }),
      }),
      panel({
        title: '评委席',
        desc: '派评委 = 选人 + 选席；撤评委是逆向路径，会连带解除该评委在本赛段签署的利益冲突声明。',
        body: judgeSeatHtml({
          judges: model.judges ?? [],
          candidates: model.candidates ?? [],
          draft: drafts.assign ?? {},
          pending: model.pending ?? null,
          stageName: stage?.name ?? '',
        }),
      }),
      panel({
        title: '名册',
        desc: '名册里的队伍才会出现在本赛段的评审与名次里；退名册是逆向路径。',
        body: rosterHtml({
          teams: model.teams ?? [],
          rosterTeamIds: model.rosterTeamIds ?? [],
          pending: model.pending ?? null,
          stageName: stage?.name ?? '',
        }),
      }),
    ].join(''),
  });
}

// ══════════════════════════════════════════════════════════════════
// 七、DOM 接线（renderStageConfig）
// ══════════════════════════════════════════════════════════════════

/**
 * 赛段配置页。
 *
 * ⚠️ **交互纪律**（照抄 web/views/tiebreak.js / web/views/publish.js）：
 *   ① 提交一律「本地校验 → 发请求 → 就地反馈」；
 *   ② 提交成功后**重新拉一次**（不是本地改状态）⇒ 页面显示的永远是服务端口径；
 *   ③ 重绘时**回填草稿** ⇒ 用户已填的内容不会被冲掉（DP-81）；
 *   ④ 加载 / 错误 / 空态全部用 web/ui.js 的现成组件（不自己造）；
 *   ⑤ 所有 DOM 读取都用可选链 —— 最小 DOM 桩上不许抛；
 *   ⑥ 事件**全部委托**在 wrap 上（局部重绘不丢监听）。
 */
export async function renderStageConfig(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'stack stagecfg-view';

  const state = {
    loading: true,
    error: null,
    errorStatus: null,
    editions: [],
    editionId: '',
    stages: [],
    stageId: '',
    stage: null,
    judges: [],
    candidates: [],
    teams: [],
    rosterTeamIds: [],
    configs: [],
    configsDegraded: false,
    configsStatus: null,
    feedback: null,
    pending: null,
    // ⚠️ 脏标记：只有用户**动过**的字段才提交（防止「只改名字」顺手清空冻结时间 / 换掉权重表）。
    dirty: { freezeAt: false, scoringConfigKey: false },
    // ⚠️ 写端点返回过完整字段按赛段 id 记下来 ——
    //    列表端点只给摘要（没有 freezeAt / scoringConfigKey）⇒ 不记就会在每次刷新后丢失。
    known: {},
    drafts: {
      create: { key: '', name: '', kind: 'initial', scoringConfigKey: 'initial', startsAt: '', endsAt: '', freezeAt: '' },
      edit: { name: '', startsAt: '', endsAt: '', freezeAt: '', scoringConfigKey: '' },
      assign: { userId: '', seat: 'judge' },
    },
  };

  /** 重绘整页。 */
  const render = () => {
    wrap.innerHTML = stageConfigPageHtml(state);
  };

  /** 读输入框的值（读不到就当空串 —— 最小 DOM 桩上不许抛）。 */
  const value = (id) => {
    const el = wrap.querySelector(`#${id}`);
    return el && typeof el.value === 'string' ? el.value : '';
  };

  /** 读复选框里勾中的队伍 id。 */
  const pickedTeamIds = () => {
    const boxes = Array.from(wrap.querySelectorAll('[data-stage="roster-pick"]') ?? []);
    const out = [];
    for (const box of boxes) {
      if (!box?.checked) continue;
      const id = String(box?.dataset?.teamId ?? box?.value ?? '').trim();
      if (id) out.push(id);
    }
    return out;
  };

  /** 归一化「列表里的一条」与「写端点返回的完整赛段」⇒ 统一的 stage 形状。 */
  const normalizeStage = (raw) => {
    if (!raw) return null;
    // ⚠️ **known 标记**：列表端点只给摘要（没有 freezeAt / scoringConfigKey），
    //    写端点返回的是完整行 ⇒ 用「字段在不在」区分「没有这个值」与「不知道这个值」。
    const hasFreeze = raw.freezeAt !== undefined || raw.freeze_at !== undefined;
    const hasKey = raw.scoringConfigKey !== undefined || raw.scoring_config_key !== undefined;
    return {
      id: raw.id,
      editionId: raw.editionId ?? raw.edition_id ?? state.editionId,
      key: raw.key,
      name: raw.name,
      kind: raw.kind,
      status: raw.status,
      startsAt: raw.startsAt ?? raw.starts_at ?? '',
      endsAt: raw.endsAt ?? raw.ends_at ?? '',
      freezeAt: raw.freezeAt ?? raw.freeze_at ?? '',
      scoringConfigKey: raw.scoringConfigKey ?? raw.scoring_config_key ?? '',
      freezeAtKnown: hasFreeze,
      scoringConfigKeyKnown: hasKey,
    };
  };

  /** 换赛段时重置「编辑」草稿（否则会把上一个赛段的名字带过来）。 */
  const resetEditDraft = (stage) => {
    state.drafts.edit = {
      name: stage?.name ?? '',
      startsAt: toLocalInput(stage?.startsAt),
      endsAt: toLocalInput(stage?.endsAt),
      freezeAt: toLocalInput(stage?.freezeAt),
      // ⚠️ 权重表键**不知道**时留空 ⇒ 保存时这一项不提交（服务端保留原值）。
      scoringConfigKey: stage?.scoringConfigKeyKnown === false ? '' : (stage?.scoringConfigKey ?? ''),
    };
    // ⚠️ 脏标记重置：没被用户动过的字段一律不提交。
    state.dirty = { freezeAt: false, scoringConfigKey: false };
  };

  /** 拉届期列表（公开端点）。 */
  const loadEditions = async () => {
    const data = await ctx.api.get('/api/editions');
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    state.editions = Array.isArray(items) ? items : [];
    const wanted = String(ctx?.params?.editionId ?? ctx?.query?.editionId ?? '');
    const known = state.editions.find((e) => String(e?.id ?? '') === wanted);
    state.editionId = known ? wanted : (pickCurrentEdition(state.editions)?.id ?? '');
  };

  /** 拉赛段列表（公开端点）。 */
  const loadStages = async () => {
    if (!state.editionId) {
      state.stages = [];
      return;
    }
    const data = await ctx.api.get(`/api/stages?editionId=${encodeURIComponent(state.editionId)}`);
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    state.stages = (Array.isArray(items) ? items : []).map((s) => normalizeStage(s) ?? s);
    // ⚠️ 把写端点返回过的完整字段补回列表项（列表端点只给摘要）。
    for (const s of state.stages) {
      const extra = state.known[String(s?.id ?? '')];
      if (!extra) continue;
      if (s.scoringConfigKeyKnown === false && extra.scoringConfigKey) {
        s.scoringConfigKey = extra.scoringConfigKey;
        s.scoringConfigKeyKnown = true;
      }
      if (s.freezeAtKnown === false) {
        s.freezeAt = extra.freezeAt ?? '';
        s.freezeAtKnown = true;
      }
    }
  };

  /**
   * 拉权重表（**尽力而为**：拿不到只降级这一块，不阻断其余面板）。
   * ⚠️ 端点是**届期作用域**的：`/api/editions/:editionId/scoring-configs`
   *    （与建段 / 改配置 / 派评委的写端点同域 ⇒ 不会出现「能改赛段、却读不到权重表」）。
   */
  const loadConfigs = async () => {
    if (!state.editionId) {
      state.configs = [];
      state.configsDegraded = false;
      state.configsStatus = null;
      return;
    }
    try {
      const data = await ctx.api.get(`/api/editions/${encodeURIComponent(state.editionId)}/scoring-configs`);
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      state.configs = Array.isArray(items) ? items : [];
      state.configsDegraded = false;
      state.configsStatus = null;
    } catch (e) {
      state.configs = [];
      state.configsDegraded = true;
      state.configsStatus = e?.status ?? null;
    }
  };

  /** 拉某个赛段的详情（评委席 / 名册 / 候选池）。 */
  const loadStageDetail = async (stageId) => {
    if (!stageId) {
      state.judges = [];
      state.candidates = [];
      state.teams = [];
      state.rosterTeamIds = [];
      state.stage = null;
      return;
    }
    const base = `/api/stages/${encodeURIComponent(stageId)}`;
    // ⛔ 这几个端点都要组委会能力：403 ⇒ 整页没有意义（页面级错误，显示「没有权限」）。
    const judgesData = await ctx.api.get(`${base}/judges`);
    const rosterData = await ctx.api.get(`${base}/teams`);
    const [teamsData, candidatesData] = await Promise.all([
      ctx.api.get(`/api/editions/${encodeURIComponent(state.editionId)}/teams`),
      ctx.api.get(`/api/editions/${encodeURIComponent(state.editionId)}/judge-candidates`),
    ]);
    state.judges = Array.isArray(judgesData?.judges) ? judgesData.judges : [];
    state.rosterTeamIds = Array.isArray(rosterData?.teamIds) ? rosterData.teamIds : [];
    state.teams = Array.isArray(teamsData?.items) ? teamsData.items : [];
    state.candidates = Array.isArray(candidatesData?.items) ? candidatesData.items : [];
  };

  /** 首屏 / 重试：一次把页面需要的数据拉齐。 */
  const loadAll = async (keepStage = false) => {
    state.loading = true;
    state.error = null;
    state.errorStatus = null;
    render();
    try {
      await loadEditions();
      await loadStages();
      await loadConfigs();
      if (!keepStage) {
        const wanted = String(ctx?.params?.stageId ?? ctx?.query?.stageId ?? '');
        const known = state.stages.find((s) => String(s?.id ?? '') === wanted);
        state.stageId = known ? wanted : (state.stages[0]?.id ? String(state.stages[0].id) : '');
      }
      const picked = state.stages.find((s) => String(s?.id ?? '') === String(state.stageId ?? '')) ?? null;
      state.stage = picked ? normalizeStage(picked) : null;
      resetEditDraft(state.stage);
      if (state.stageId) await loadStageDetail(state.stageId);
    } catch (e) {
      state.error = e?.message ?? '加载失败';
      state.errorStatus = e?.status ?? null;
    } finally {
      state.loading = false;
      render();
    }
  };

  /** 成功反馈（noticeState 的参数是 items —— 不是 text）。 */
  const ok = (title, items) => {
    state.feedback = { tone: 'success', title, items: Array.isArray(items) ? items : [items] };
  };

  /** 失败反馈（服务端的中文原因原样透出）。 */
  const fail = (title, e) => {
    state.feedback = { tone: 'danger', title, items: [e?.message ?? '操作失败'] };
  };

  /** 写完之后重新拉一次（页面显示的永远是服务端口径）。 */
  const reload = async (keepStage = true) => {
    await loadAll(keepStage);
  };

  // ── 建赛段 ────────────────────────────────────────────────────────
  const createStage = async () => {
    const body = {
      key: value('stage-new-key').trim(),
      name: value('stage-new-name').trim(),
      kind: value('stage-new-kind') || 'initial',
      scoringConfigKey: value('stage-new-config') || 'initial',
      // ⚠️ datetime-local 给的是本地时间 ⇒ 统一转 ISO 再发（同一个时刻，格式与其它端点一致）。
      startsAt: toIso(value('stage-new-starts')),
      endsAt: toIso(value('stage-new-ends')),
      freezeAt: value('stage-new-freeze') ? toIso(value('stage-new-freeze')) : null,
    };
    if (!body.key || !body.name || !body.startsAt || !body.endsAt) {
      state.feedback = { tone: 'warn', title: '还差一点', items: ['赛段代号、名称、开始时间与结束时间都要填。'] };
      render();
      return;
    }
    try {
      const res = await ctx.api.post(`/api/editions/${encodeURIComponent(state.editionId)}/stages`, body);
      const created = normalizeStage(res?.stage);
      if (created?.id) {
        state.known[String(created.id)] = {
          freezeAt: created.freezeAt ?? '',
          scoringConfigKey: created.scoringConfigKey ?? '',
        };
      }
      state.drafts.create = { key: '', name: '', kind: 'initial', scoringConfigKey: 'initial', startsAt: '', endsAt: '', freezeAt: '' };
      state.stageId = created?.id ? String(created.id) : state.stageId;
      ok('赛段已创建', [
        created ? `赛段「${created.name}（${created.key}）」已建好。` : '赛段已建好。',
        '新赛段是草稿状态：开闸是另一个动作。',
      ]);
      await reload();
    } catch (e) {
      fail('创建赛段失败', e);
      render();
    }
  };

  // ── 改赛段配置 ────────────────────────────────────────────────────
  const updateStage = async () => {
    if (!state.stageId) {
      state.feedback = { tone: 'warn', title: '还没选赛段', items: ['先在上方列表点「进入配置」。'] };
      render();
      return;
    }
    const body = {
      name: value('stage-cfg-name').trim(),
      startsAt: toIso(value('stage-cfg-starts')),
      endsAt: toIso(value('stage-cfg-ends')),
    };
    // ⛔ **只提交用户动过的字段**：服务端的 PATCH 语义是「不传 = 不改」
    //    ⇒ 没动过 freezeAt / scoringConfigKey 就不传它们，
    //    否则「只改个名字」会把冻结时间清空、把权重表换成下拉框里的第一项。
    if (state.dirty.freezeAt) body.freezeAt = value('stage-cfg-freeze') ? toIso(value('stage-cfg-freeze')) : null;
    if (state.dirty.scoringConfigKey && value('stage-cfg-config')) body.scoringConfigKey = value('stage-cfg-config');
    if (!body.name || !body.startsAt || !body.endsAt) {
      state.feedback = { tone: 'warn', title: '还差一点', items: ['赛段名称、开始时间与结束时间都要填。'] };
      render();
      return;
    }
    try {
      const res = await ctx.api.patch(`/api/stages/${encodeURIComponent(state.stageId)}`, body);
      const updated = normalizeStage(res?.stage);
      if (updated) {
        const idx = state.stages.findIndex((s) => String(s?.id ?? '') === String(updated.id));
        if (idx >= 0) state.stages[idx] = updated;
        state.stage = updated;
        state.known[String(updated.id)] = {
          freezeAt: updated.freezeAt ?? '',
          scoringConfigKey: updated.scoringConfigKey ?? '',
        };
      }
      ok('赛段配置已保存', ['名称、时间窗、冻结时间与权重表已更新（已留审计）。']);
      await reload();
    } catch (e) {
      fail('保存赛段配置失败', e);
      render();
    }
  };

  // ── 派评委 ────────────────────────────────────────────────────────
  const assignJudge = async () => {
    if (!state.stageId) {
      state.feedback = { tone: 'warn', title: '还没选赛段', items: ['先在上方列表点「进入配置」。'] };
      render();
      return;
    }
    const body = {
      userId: value('stage-judge-user'),
      seat: value('stage-judge-seat') || 'judge',
      scopeType: 'global',
      scopeId: null,
    };
    if (!body.userId) {
      state.feedback = { tone: 'warn', title: '还没选评委', items: ['先在候选池里选一个人。'] };
      render();
      return;
    }
    try {
      await ctx.api.post(`/api/stages/${encodeURIComponent(state.stageId)}/judges`, body);
      state.drafts.assign = { userId: '', seat: body.seat };
      ok('已派评委', [
        `席位 ${judgeSeatLabel(body.seat).label} 已派出。`,
        '席位与利益冲突声明同一次写入（已留审计）。',
      ]);
      await reload();
    } catch (e) {
      fail('派评委失败', e);
      render();
    }
  };

  // ── 撤评委（逆向路径）────────────────────────────────────────────
  const removeJudge = async (userId) => {
    try {
      await ctx.api.del(`/api/stages/${encodeURIComponent(state.stageId)}/judges/${encodeURIComponent(userId)}`);
      state.pending = null;
      ok('已撤回该评委', [
        '该评委在本赛段的席位已失效，其在本赛段签署的利益冲突声明一并解除（声明记录作为历史事实保留）。',
      ]);
      await reload();
    } catch (e) {
      fail('撤评委失败', e);
      render();
    }
  };

  // ── 登记名册 ──────────────────────────────────────────────────────
  const registerTeams = async () => {
    if (!state.stageId) {
      state.feedback = { tone: 'warn', title: '还没选赛段', items: ['先在上方列表点「进入配置」。'] };
      render();
      return;
    }
    const teamIds = pickedTeamIds();
    if (!teamIds.length) {
      state.feedback = { tone: 'warn', title: '还没勾队伍', items: ['先勾选要登记到本赛段的队伍。'] };
      render();
      return;
    }
    try {
      const res = await ctx.api.post(`/api/stages/${encodeURIComponent(state.stageId)}/teams`, { teamIds });
      const registered = Number(res?.registered ?? 0);
      const skipped = Number(res?.skipped ?? 0);
      ok('名册已更新', [
        `新登记 ${registered} 支队伍。`,
        skipped ? `${skipped} 支此前已在名册里（重复登记是幂等的，不会报错）。` : '重复登记是幂等的，不会报错。',
      ]);
      await reload();
    } catch (e) {
      fail('登记名册失败', e);
      render();
    }
  };

  // ── 退名册（逆向路径）────────────────────────────────────────────
  const removeTeam = async (teamId) => {
    try {
      await ctx.api.del(`/api/stages/${encodeURIComponent(state.stageId)}/teams/${encodeURIComponent(teamId)}`);
      state.pending = null;
      ok('已把该队伍退名册', ['该队在本赛段的评分与确认随之失效。']);
      await reload();
    } catch (e) {
      fail('退名册失败', e);
      render();
    }
  };

  await loadAll();

  // ⚠️ **事件绑定在 wrap 上（委托）**：局部重绘不会丢监听。
  wrap.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset?.action;

    if (action === 'retry') {
      await loadAll();
      return;
    }
    if (action === 'stage-select') {
      const id = String(btn.dataset?.stageId ?? '');
      if (!id || id === String(state.stageId)) return;
      state.stageId = id;
      state.pending = null;
      state.feedback = null;
      state.loading = true;
      render();
      try {
        const picked = state.stages.find((s) => String(s?.id ?? '') === id) ?? null;
        state.stage = picked ? normalizeStage(picked) : null;
        resetEditDraft(state.stage);
        await loadStageDetail(id);
      } catch (e) {
        state.error = e?.message ?? '加载失败';
        state.errorStatus = e?.status ?? null;
      } finally {
        state.loading = false;
        render();
      }
      return;
    }
    if (action === 'stage-create-submit') {
      await createStage();
      return;
    }
    if (action === 'stage-update-submit') {
      await updateStage();
      return;
    }
    if (action === 'judge-assign-submit') {
      await assignJudge();
      return;
    }
    if (action === 'judge-remove-request') {
      state.pending = { type: 'judge', userId: String(btn.dataset?.userId ?? '') };
      render();
      return;
    }
    if (action === 'judge-remove-cancel') {
      state.pending = null;
      render();
      return;
    }
    if (action === 'judge-remove-confirm') {
      await removeJudge(String(btn.dataset?.userId ?? ''));
      return;
    }
    if (action === 'roster-register-submit') {
      await registerTeams();
      return;
    }
    if (action === 'roster-remove-request') {
      state.pending = { type: 'team', teamId: String(btn.dataset?.teamId ?? '') };
      render();
      return;
    }
    if (action === 'roster-remove-cancel') {
      state.pending = null;
      render();
      return;
    }
    if (action === 'roster-remove-confirm') {
      await removeTeam(String(btn.dataset?.teamId ?? ''));
      return;
    }
  });

  // 草稿回填：记住用户填了什么 ⇒ 重绘时不冲掉（DP-81）。
  wrap.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.stage;
    if (!kind) return;
    if (kind === 'new-key') state.drafts.create.key = el.value;
    if (kind === 'new-name') state.drafts.create.name = el.value;
    if (kind === 'new-starts') state.drafts.create.startsAt = el.value;
    if (kind === 'new-ends') state.drafts.create.endsAt = el.value;
    if (kind === 'new-freeze') state.drafts.create.freezeAt = el.value;
    if (kind === 'cfg-name') state.drafts.edit.name = el.value;
    if (kind === 'cfg-starts') state.drafts.edit.startsAt = el.value;
    if (kind === 'cfg-ends') state.drafts.edit.endsAt = el.value;
    if (kind === 'cfg-freeze') {
      state.drafts.edit.freezeAt = el.value;
      state.dirty.freezeAt = true;
    }
  });

  // 换届期 / 改下拉：只改数据，不整页刷新输入框。
  wrap.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const kind = el.dataset?.stage;
    if (kind === 'edition') {
      state.editionId = el.value;
      state.stageId = '';
      state.stage = null;
      state.judges = [];
      state.candidates = [];
      state.teams = [];
      state.rosterTeamIds = [];
      state.pending = null;
      state.feedback = null;
      state.loading = true;
      render();
      try {
        await loadStages();
        // ⚠️ 权重表端点是**届期作用域**的 ⇒ 换届期必须重拉（否则显示的是上一届的表）。
        await loadConfigs();
        state.stageId = state.stages[0]?.id ? String(state.stages[0].id) : '';
        const picked = state.stages.find((s) => String(s?.id ?? '') === String(state.stageId)) ?? null;
        state.stage = picked ? normalizeStage(picked) : null;
        resetEditDraft(state.stage);
        if (state.stageId) await loadStageDetail(state.stageId);
      } catch (e) {
        state.error = e?.message ?? '加载失败';
        state.errorStatus = e?.status ?? null;
      } finally {
        state.loading = false;
        render();
      }
      return;
    }
    if (kind === 'new-kind') state.drafts.create.kind = el.value;
    if (kind === 'new-config') state.drafts.create.scoringConfigKey = el.value;
    if (kind === 'cfg-config') {
      state.drafts.edit.scoringConfigKey = el.value;
      state.dirty.scoringConfigKey = true;
    }
    if (kind === 'judge-user') state.drafts.assign.userId = el.value;
    if (kind === 'judge-seat') state.drafts.assign.seat = el.value;
  });

  return wrap;
}

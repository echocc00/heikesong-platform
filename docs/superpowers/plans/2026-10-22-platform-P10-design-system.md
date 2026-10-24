# P10 · 设计系统 2.0 + 功能缺口补界面（2026-10-22）

> 依据：P9 上线后的**真机复验收果** + 用户四项决定（视觉地基 / 范围 / 功能缺口 / 权限呈现）。
> 前置：`2026-10-22-platform-P9-ui-redesign.md`（P9 落地页与 token 层）、`docs/deployment.md` §19 台账 E125–E130。

---

## 0. 一句话

把「能跑」升级成「**像个产品**」：暗色为主的统一设计系统铺满落地页与全部内页，
并把 **31 个「只有接口没有界面」** 的功能点里用户选中的四组补上真实可点的界面。

---

## 1. 四个决定（用户已拍板）

| # | 决定 | 落地含义 |
|---|---|---|
| 1 | **暗色为主 + 弱化网格 + 加深度材质** | 暗色是**默认**（不再跟随系统亮色）；工程网格降到 3–4% 对比并用径向遮罩只在一角显影；卡片加 1px 高光边 + 极轻渐变面（**不是**堆阴影） |
| 2 | **落地页 + 全部内页统一设计系统** | token 层为唯一出处；内页逐页套用，共享组件（顶栏/按钮/卡片/表单/表格/指标/提示条）全部升级 |
| 3 | **功能缺口全选四组** | 任务卡分级审批 / 企业双签 + 里程碑签字 / 申诉提交与裁决 / 评委前置（回避 + 互评自评校准） |
| 4 | **前端直接按角色拦路** | ⛔ 与 DP-77「前端不按角色拦路」正面冲突 —— 用户知情选择。**实现按「角色 → 能力点」映射**（不是硬编码角色键），API 仍是最终裁决者 |

---

## 2. 设计契约（P10 · midnight / Rules-as-Graphics 2.0）

### 2.1 底色与材质

| 层 | 值 | 说明 |
|---|---|---|
| `--bg` | `#08090d` | 比 P9 的 `#0b0d12` 更深一档：让卡片面浮起来 |
| `--surface` | `#101319` | 卡片面 |
| `--surface-raised` | `#161a23` | 浮起面（弹层、hover） |
| `--hairline` | `rgba(255,255,255,.07)` | 1px 高光边（**顶边**）—— 材质的来源 |
| `--sheen` | `linear-gradient(180deg, rgba(255,255,255,.035), transparent 42%)` | 卡片顶面极轻渐变 |

⛔ 卡片**仍然零外阴影**（P9 签名动作①保留）；深度只靠「底色差 + 顶边高光 + 顶面渐变」三件套。

### 2.2 底纹（P10 改签名）

| 项 | P9 | P10 |
|---|---|---|
| 网格线对比 | `--brand-line`（rgba .32） | `rgba(124,156,255,.055)`（**约 1/6**） |
| 显影方式 | 满铺等距 | **径向遮罩**：只在左下 60% 区域显影，向上向右淡出 |
| 线距 | 48px | 64px（更疏） |
| 叠加 | 无 | 一层 `radial-gradient` 冷光（左上）+ 极淡噪点（SVG feTurbulence，data URI） |

⛔ 不引网络字体、零依赖：噪点用内联 SVG data URI（`feTurbulence` + `feColorMatrix`），不引入图片文件。

### 2.3 签名元素：「规则即图形」2.0

P9 的四种载体（条=权重 / 脊=赛程 / 阶=段位 / 流=漏斗）**保留语法**，但每一处升级为**有状态的图形**：

1. **赛程脊 → 贯通进度线**：一条贯通的竖线 + 5 个节点三态（已过 / 当前 / 未开始），
   当前节点放大 + 发光；详情卡**贴脊**而不是漂浮；移动端仍可用（不是 hover-only）。
2. **权重条 → 双轨对照**：初赛/决赛同一维度**共用一条轴**（上下两轨），联动高亮时两端一起亮，
   中间标出 Δ（如 `+15pp`）——「权重怎么随赛段变化」一眼可见。
3. **段位阶 → 真阶梯**：D→S 五级台阶（高度递增），当前段位高亮，权益挂在台阶右侧。
4. **漏斗 → 真梯形**：每段宽度按比例，段间标注流失率与目标人数。

### 2.4 节奏与信息

- 首屏补**关键事实条**：赛事日期 / 城市 / 报名截止 / 决赛名额 —— 数据来自 `rules/schedule.json` + 届期（**不许硬编码**）。
- 章节交替底色（每 2–3 屏换一次 `--bg-subtle`），CTA 带做成整宽深色块。
- 标题层级拉开：`eyebrow`（等宽字距）→ `H2`（≤ 26px）→ 导语（`--fg-muted`）；**hero 标题仍是全页唯一 oversized moment**。

### 2.5 可复算阈值（M1–M12）

| # | 阈值 |
|---|---|
| M1 | 首屏（1440×900）必须同时可见：标题、CTA、赛程脊**当前节点**、关键事实条 |
| M2 | 网格线与底色对比度 ≤ 1.35:1（不喧宾夺主）；正文 ≥ 7:1；弱文 ≥ 4.5:1 |
| M3 | 每屏强调色元素 ≤ 3（主 CTA + 焦点环 + 活动节点） |
| M4 | 卡片顶边高光可见（ΔL ≥ 0.04 OKLCH），但**不得**出现外阴影 |
| M5 | 六视口（360/390/768/1024/1440/1920）无横向滚动、无文字裁切 |
| M6 | 所有颜色只经 token；`styles.css` 里 **0 处**字面色值出现在组件规则中 |
| M7 | 暗色为默认：`html[data-theme]` 缺省时渲染为暗色（不跟随系统） |
| M8 | 段位阶 5 级台阶高度**递增**且当前段位高亮 |
| M9 | 漏斗每段宽度与比例偏差 ≤ 2% |
| M10 | 权重双轨同一维度上下对齐，联动高亮时**两端同时**带 `is-active` |
| M11 | 每个可点元素有 `:focus-visible` 焦点环（对比 ≥ 3:1） |
| M12 | 关键事实条的日期/名额与 `rules/*.json` **逐字一致**（机器闸） |

---

## 3. 权限模型（DP-105 · 用户决定 4）

### DP-105 · 前端按「能力点」拦路，API 仍是最终裁决

- `/api/me` 增加 `capabilities: string[]`（**能力点键**，不是角色键）——
  来源：角色能力（`role_capabilities` ⨝ `user_roles`）∪ 资源级授权（`assignments`，仅取 `scope_type='global'`）。
- 前端路由守卫：`nav.js` 给**分区级**页面声明 `requiredCapability`：
  | 路径 | 需要能力点 |
  |---|---|
  | `/admin/registration` | `registration:review` |
  | `/flags` | `audit:read` |
  | `/publish` | `stage:compute` |
  | `/admin/task-packages`（新） | `task_package:approve` |
  | `/admin/appeals`（新） | `audit:read` |
- **只拦分区级页面**（它们的 API 也要求**全局**能力点 ⇒ 前后端口径一致）；
  赛段级页面（`/review/:stageId` 等）**不拦** —— 评委的能力点是赛段级授权，前端无从判断。
- 超管直通。守卫页文案：**说明这个功能属于谁 + 下一步能去哪**，不给白屏。
- ⛔ DP-77 修订：从「前端**绝不**按角色拦路」改为「前端**绝不**按角色**硬编码**拦路；按能力点声明，且只声明 API 同样要求全局能力点的页面」。

### DP-106 · 申诉是**两件事**，但**同一条队列**

- W4-c 的前端做好了，**后端接不住**：`fileAppeal` 无条件按赛段结果校验
  （要求 `stage_result` 已 `FINALIZED` + 队伍档位在 `appealAllowedTiers`），
  选手拿报名 id 去提交必然 409 ⇒ 「选手点提交申诉」永远失败。
- **决定**：报名类申诉（`subjectType='registration'`）与赛段结果类申诉
  **写进同一张 `appeals` 表、走同一个裁决界面**，但**校验口径不同**：
  - 报名类：记录存在 + 是本人（或组委会代提）+ **当前无终态裁定** + 无未裁决的重复申诉；
  - 赛段结果类：**原逻辑一字不改**。
- 裁决：报名类 `accepted` ⇒ 撤销分级裁定（`level_final` 清空、状态回「待复核」），
  **不触发赛段重算**（`recomputeRequired=false`）；`rejected` ⇒ 报名不动，只留痕。
- ⛔ `listAppeals` 仍然**只对有 `audit:read` 的人可见**（放宽 = 回归）。

### DP-107 · 告警分「人话」与「内部明细」两层

- 真机取证：公开的滚动总榜把内部规则键摊给了每一个访客
  （`[normalization_fallback]`、`j1:partial:judge_sample_too_small`、`t_epsilon`、
  `15.200000000000003 分`）。
- **决定**：告警对象统一成 `{ code, message, detail? }` ——
  `message` **只给人读**（中文维度名、无评委 id、无内部原因码、分数四舍五入）；
  `detail` 是**内部明细**，**由 API 层按可见性裁剪**（只有 `audit:read` 的人拿得到）。
- ⛔ 「降级必须显式展示，不静默」（S-5 / C-05）是硬契约 ⇒ **一条告警都不许少**，
  只改**分层**，不藏。

### DP-108 · 赛制规格一律走**服务端投影**

- W4-a 的六维评估表原本只能读站点里的 `rules/solvability.json`，
  而生产部署**默认不挂 `/rules/`**（只有 `DEMO_MODE=1` 才挂）⇒ 生产冷启动画不出表。
- **决定**：`buildEventInfo`（`src/domain/event-info.js`）增加 `solvability` 投影
  （逐字段白名单：维度 / 档位 / 否决项；**不投影**判定条件与内部备注）。
  ⇒ **演示站与正式站同源**（演示适配器 import 的是同一个函数）⇒ 形状与数值天然对齐。
  静态规则文件只作**兜底**。

---

## 4. 任务清单

| 波 | 任务 | 文件 | 归属 |
|---|---|---|---|
| W1-a | token 层 2.0（暗色默认 / 材质 / 噪点 / 弱化网格） | `web/styles.css` | P0 owns ⇒ 同步回 P0 |
| W1-b | `/api/me` 带能力点 + 前端按能力点拦路 | `src/db/repo/assignments.js`、`src/server.js`、`web/nav.js`、`web/app.js`、`web/views/login.js` | P0/P7 ⇒ 同步回 |
| W2 | 落地页重做（首屏事实条 / 赛程脊 2.0 / 权重双轨 / 段位阶梯 / 真漏斗 / CTA 带） | `web/views/landing.js`、`web/styles.css` | P9 owns ⇒ 同步回 P9 |
| W3 | 内页统一设计系统 | `web/ui.js` + 各 `web/views/*.js` | 按最早建立者 |
| W4-a | 任务卡分级 / 审批界面 | 新 `web/views/admin-task-packages.js` | **P10 新建** |
| W4-b | 企业双签 + 里程碑签字（含撤回） | `web/views/review.js`、`web/views/card.js`、`web/views/publish.js` | P8/P3 ⇒ 同步回 |
| W4-c | 申诉提交（选手）+ 裁决（组委会） | `web/views/registration.js`、新 `web/views/admin-appeals.js` | P1/P10 |
| W4-d | 评委前置：回避 + 互评 / 自评 / 校准 | 新 `web/views/review-prep.js` | **P10 新建** |

### 4.1 验收交付物

| 文件 | 内容 |
|---|---|
| `docs/design-system-p10.md` | 设计系统 2.0 的**唯一事实源**（token / 材质 / 深度 / 强调色预算） |
| `docs/p10-role-route-matrix.md` | **角色 × 路由 × 端点 × 可触发性**矩阵（回答用户「用户账号与管理员页面是否一致」「有没有只做展示、点不动的接口」两个问题；每行判据可复算） |
| `platform/test/route-capability-guard.test.js` | 能力点拦路的回归闸（18 例） |
| `platform/test/demo-api-parity.test.js` | 端点覆盖闸（扩到 P10 全部端点 ⇒ 以后新增页面漏端点会立刻红） |
| `platform/test/demo-admin-write-flows.test.js` | 演示站组委会写流程的行为闸（9 例：六维评估 / 签级 / 里程碑签字 / 撤回 / 企业双签） |
| `platform/test/warning-wording.test.js` | 降级告警的「人话 / 内部明细」两层（12 例） |

---

## 5. 纪律（沿用 P0–P9）

1. **计划是规格**：本计划的代码块必须与最终实现逐字一致（`plan-block-sync.mjs --verify`）。
2. **零依赖 / 零构建 / 可移植**（不引网络字体、不引图片文件、不引 npm 包）。
3. **规则只从 `rules/*.json` 来**（前端一个赛制数字都不许硬编码 —— 机器闸）。
4. **可见性在 API 层过滤**（前端只负责呈现）。
5. 每波交付都要：全量 `node --test` + 三个机器闸 + 漂移审计（`C-RW` 必须 0）+ 变异检验 + 六视口读图 + 真机复验。
6. 台账编号不重号：`E131+` / `DP-105+`。

---

## 6. 规格块（P10 新建文件 · 逐字）

> 本节是 P10 **新建文件**的规格块（`plan-block-sync.mjs --verify` 逐字核验）。
> 新建文件没有「最早建立者」⇒ 规格落在本计划（P10）。

### 企业签字台视图（里程碑签字 + 企业双签）

`platform/web/views/signoff.js` —— 企业签字台视图（里程碑签字 + 企业双签）

```javascript
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
```

### 任务卡分级 / 审批界面

`platform/web/views/admin-task-packages.js` —— 任务卡分级 / 审批界面

```javascript
// web/views/admin-task-packages.js — 任务卡分级 / 审批界面
//
// 依据：P10 计划 §4 W4-a（docs/superpowers/plans/2026-10-22-platform-P10-design-system.md）
// 视觉：docs/design-system-p10.md（token / 组件 / 材质三件套 —— 本文件只复用 web/ui.js 的组件，不写字面色值）
// 溯源需求：R-ENT-06（六维可解性准入）/ R-ENT-07（一票否决）/ R-ENT-08（分级签约与协议）
//           R-ENT-09（任务池配比）/ R-ENT-10（自由命题不签企业协议）
//
// ⚠️ **后端契约（以源码为准，不凭猜写前端）**：
//   platform/src/http/routes/taskPackage.js ＋ platform/src/services/taskPackage.js
//   · GET  /api/task-packages?editionId=…      → { items, mix }（无权限 ⇒ 200 + 空集）
//   · POST /api/task-packages/:id/solvability   → body { answers: { <维度键>: 0..max 整数, vetoes?: [否决项键] } }
//   · POST /api/task-packages/:id/approve       → body { grade: 档位键 }
//   权限：评估要 task_package:write；签级要 task_package:approve。
//   状态机（服务层 ASSESSABLE / APPROVABLE）：
//     submitted / assessed / returned 可评估；assessed / returned 可签级；published 两者都不行。
//
// ⚠️ **六维规格从哪来（前端一个字都不许硬编码）**：
//   服务端**没有**「返回评估表规格」的端点 ⇒ 规格有两个来源，按可靠性取：
//   ① 服务端投影：已评估过的卡，meta.solvability.explain 里带着每一维的
//      key / label / weight / max（领域层算分时写进去的）⇒ 列表接口顺带就给了；
//   ② 规则投影：同源的规则文件（rules/solvability.json）—— 演示站把它放在站点里
//      （web/api.demo.js 的 RULES_BASE 就是同一个约定），前端按同一相对路径取。
//   两个都取不到时，页面**不编造维度**，只给一条能照做的提示（见 solvabilityFormHtml）。
//   ⚠️ 生产部署默认**不挂** /rules/（只有 DEMO_MODE=1 才挂）⇒ 生产环境的冷启动
//      （一张卡都没评估过）拿不到规格 ⇒ 需要后端补一个规格投影端点（见交付说明）。
//
// ⛔ 前端**不做可见性过滤**（全局约束）：API 返回什么就渲染什么，一个都不许丢。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, kvList, loadingState, noticeState,
  pageHead, panel, statRow, tableWrap,
} from '../ui.js';

// ── 任务卡状态（**API 契约值**，不是规则值）────────────────────────────
// ⚠️ 与后端 platform/src/services/taskPackage.js 的状态机一一对应：
//    写错一个拼写 ⇒ 该卡永远进不了评估/签级流程，而且**不报任何错**。
const ASSESSABLE = new Set(['submitted', 'assessed', 'returned']);
const APPROVABLE = new Set(['assessed', 'returned']);

const STATUS_LABELS = {
  submitted: '已提交',
  assessed: '已评估',
  returned: '已退回',
  published: '已发布',
};

const STATUS_TONES = {
  submitted: 'info',
  assessed: 'brand',
  returned: 'warn',
  published: 'success',
};

/** 规则投影文件的地址（与 web/api.demo.js 的 RULES_BASE 同一约定：相对**文档**）。 */
const RULES_URL = './rules/solvability.json';

// ══════════════════════════════════════════════════════════════════
// 一、规格投影（纯函数）
// ══════════════════════════════════════════════════════════════════

/**
 * 从规则文件（rules/solvability.json 的形状）投影出评估表规格（纯函数）。
 *
 * ⚠️ 为什么要**投影**而不是直接把配置丢给前端：
 *    配置里有「内部工作备注」这类字段（见 src/domain/event-info.js 的同一纪律），
 *    前端只需要「维度 / 档位 / 否决项」三样 ⇒ 这里逐字段挑出来。
 *
 * @param {object|null} rules 规则配置（rules/solvability.json）
 * @returns {object|null} 规格；配置形状不对 ⇒ null（调用方据此降级）
 */
export function solvabilitySpecFromRules(rules) {
  if (!rules || typeof rules !== 'object') return null;
  const dims = Array.isArray(rules.dimensions) ? rules.dimensions : [];
  if (!dims.length) return null;
  return {
    source: 'rules',
    dimensions: dims
      .filter((d) => d && typeof d.key === 'string')
      .map((d) => ({
        key: d.key,
        label: String(d.label ?? d.key),
        weight: Number(d.weight) || 0,
        max: Number(d.max) || 0,
      })),
    grades: (Array.isArray(rules.grades) ? rules.grades : [])
      .filter((g) => g && typeof g.key === 'string')
      .map((g) => ({
        key: g.key,
        minScore: Number(g.minScore),
        maxScore: Number(g.maxScore),
        commitment: String(g.commitment ?? ''),
        agreement: String(g.agreement ?? ''),
      })),
    vetoes: (Array.isArray(rules.vetoes) ? rules.vetoes : [])
      .filter((v) => v && typeof v.key === 'string')
      .map((v) => ({
        key: v.key,
        label: String(v.label ?? v.key),
        // auto = 由某一维的取值自动命中（服务端推导）⇒ 前端不自报，只让委员会自报其余的
        auto: Boolean(v.auto),
      })),
  };
}

/**
 * 从服务端返回的任务卡列表里投影出评估表规格（纯函数）。
 *
 * ⚠️ 服务端把每一维的 key / label / weight / max 写进了 meta.solvability.explain
 *    （领域层算分时的产物）⇒ 已评估过的卡，列表接口就顺带把规格给全了。
 *    这是**服务端投影**（不是前端编的）⇒ 委员会改了 rules，页面跟着变。
 *
 * @param {object[]} packages 任务卡列表（presented 形状）
 * @returns {object|null} 规格；一张都没评估过 ⇒ null
 */
export function solvabilitySpecFromPackages(packages) {
  const list = Array.isArray(packages) ? packages : [];
  for (const pkg of list) {
    const solvability = pkg?.meta?.solvability;
    const explain = solvability?.explain;
    if (!Array.isArray(explain) || !explain.length) continue;
    // ⚛️ F16（Critical）：档位定义（minScore/maxScore）**不完整就不算规格**。
    //    原来这里只从卡片反推**档位键**（`grades: observedGrades(list).map(k => ({key:k}))`）
    //    ⇒ `gradeTiers()` 因「没有一条带 minScore」判「档位未就绪」
    //    ⇒ **只要有任意一张卡被评估过，签级控件就整片消失**（自锁：再评估也修不好）。
    //    投影不出完整档位 ⇒ **返回 null**，让调用方降级（`??` 走规则投影）
    //    —— 半份规格比没有规格更坏：它会让页面显示「档位未就绪」而看不出真因。
    //    服务端现在也会把完整档位定义带进 meta.solvability（见 services/taskPackage.js）。
    const grades = (Array.isArray(solvability.grades) ? solvability.grades : [])
      .filter((g) => g && typeof g.key === 'string')
      .map((g) => ({
        key: g.key,
        minScore: Number(g.minScore),
        maxScore: Number(g.maxScore),
        commitment: String(g.commitment ?? ''),
        agreement: String(g.agreement ?? ''),
      }));
    return {
      source: 'api',
      dimensions: explain
        .filter((d) => d && typeof d.dimension === 'string')
        .map((d) => ({
          key: d.dimension,
          label: String(d.label ?? d.dimension),
          weight: Number(d.weight) || 0,
          max: Number(d.max) || 0,
        })),
      // ⚛️ F16（Critical）：档位定义（minScore/maxScore）**必须完整**，否则这份规格是残的。
      //    残规格会让 `gradeTiers()` 判「档位未就绪」⇒ 签级控件整片消失（自锁）。
      //    服务端现在把完整档位定义投影进 meta.solvability（见 services/taskPackage.js）
      //    ⇒ 这里优先读它；读不到（**旧数据**：本项修复之前评估过的卡）才退回
      //    「从已观察到的取值反推」（只有键，没有分数区间）。
      grades: grades.length ? grades : observedGrades(list).map((key) => ({ key })),
      // 否决项：优先用服务端带来的**完整定义**（含 label / auto）；
      // 没有就退回「从已命中的反推」（只有键）。
      vetoes: (Array.isArray(solvability.vetoesSpec) && solvability.vetoesSpec.length
        ? solvability.vetoesSpec
        : observedVetoes(list)).map((v) => (typeof v === 'string' ? { key: v } : v)),
    };
  }
  return null;
}

/** 规格里出现过的档位键（从卡片的已签 / 已算档位反推）。 */
function observedGrades(packages) {
  const keys = new Set();
  for (const pkg of packages) {
    const solvability = pkg?.meta?.solvability ?? {};
    for (const key of [pkg?.grade, pkg?.solvabilityGrade, solvability.grade, solvability.computedGrade]) {
      if (typeof key === 'string' && key) keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * 定规格（纯函数）：规则投影更完整（六维 + 档位区间 + 否决项说明）⇒ 有它就用它；
 * 没有就退回服务端投影（维度齐、档位只有键）。
 *
 * @param {{ packages?: object[], rules?: object|null }} input
 * @returns {object|null}
 */
export function resolveSolvabilitySpec({ packages = [], rules = null } = {}) {
  return solvabilitySpecFromRules(rules) ?? solvabilitySpecFromPackages(packages);
}

/** 规格里出现过的否决项键（从卡片已命中的否决项反推）。 */
function observedVetoes(packages) {
  const keys = new Set();
  for (const pkg of packages) {
    const list = pkg?.meta?.solvability?.vetoes;
    if (!Array.isArray(list)) continue;
    for (const key of list) if (typeof key === 'string' && key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * 档位划分（纯函数）：**最低一档是退回档**，其余是通过档。
 *
 * ⚠️ 为什么「最低一档 = 退回档」而不是写死某个键：
 *    档位键属于规则（rules/solvability.json 的 grades），前端不许硬编码；
 *    而服务端对「命中否决项」的处置也是「强制落到最低档并退回」——
 *    两者口径一致 ⇒ 用**分数区间最低**这个结构特征来认退回档，规则改了也跟着改。
 *
 * @param {object|null} spec
 * @returns {{ approve: object[], return: object|null, complete: boolean }}
 */
export function gradeTiers(spec) {
  const scored = (spec?.grades ?? [])
    .filter((g) => g && typeof g.key === 'string' && Number.isFinite(Number(g.minScore)));
  if (!scored.length) return { approve: [], return: null, complete: false };
  const sorted = [...scored].sort((a, b) => Number(b.minScore) - Number(a.minScore));
  return { approve: sorted.slice(0, -1), return: sorted.at(-1), complete: true };
}

/** 委员会**自报**的否决项（规则里没有 auto 的那些 ⇒ 不是由维度取值推导的）。 */
export function selfReportedVetoes(spec) {
  return (spec?.vetoes ?? []).filter((v) => v && typeof v.key === 'string' && !v.auto);
}

// ══════════════════════════════════════════════════════════════════
// 二、任务卡的展示模型（纯函数）
// ══════════════════════════════════════════════════════════════════

/**
 * 一张任务卡的展示模型（纯函数）。
 * ⚠️ 状态能不能评估 / 能不能签级，按**服务层的状态机**判定（见文件头）——
 *    前端提前说不行，服务端仍然最终裁决（DP-77）。
 */
export function packageView(pkg = null) {
  const solvability = pkg?.meta?.solvability ?? {};
  const explain = Array.isArray(solvability.explain) ? solvability.explain : [];
  const values = {};
  for (const d of explain) {
    if (!d || typeof d.dimension !== 'string') continue;
    values[d.dimension] = Number(d.value ?? 0);
  }
  const status = String(pkg?.status ?? '');
  return {
    id: String(pkg?.id ?? ''),
    title: String(pkg?.title ?? ''),
    enterpriseName: String(pkg?.enterpriseName ?? ''),
    isFreeBrief: pkg?.isFreeBrief === true,
    status,
    statusLabel: STATUS_LABELS[status] ?? (status || '—'),
    statusTone: STATUS_TONES[status] ?? 'neutral',
    grade: pkg?.grade ?? null,
    solvabilityGrade: pkg?.solvabilityGrade ?? solvability.grade ?? null,
    solvabilityScore: pkg?.solvabilityScore ?? solvability.score ?? null,
    commitment: String(pkg?.commitment ?? ''),
    agreement: String(pkg?.agreement ?? ''),
    painPoint: String(pkg?.painPoint ?? ''),
    expectedDelivery: String(pkg?.expectedDelivery ?? ''),
    acceptanceCriteria: String(pkg?.acceptanceCriteria ?? ''),
    values,
    vetoes: Array.isArray(solvability.vetoes)
      ? solvability.vetoes.filter((k) => typeof k === 'string')
      : [],
    canAssess: ASSESSABLE.has(status),
    canSign: APPROVABLE.has(status),
  };
}

// ══════════════════════════════════════════════════════════════════
// 三、渲染（纯函数）
// ══════════════════════════════════════════════════════════════════

/** 百分比文案（纯函数）：0.3 → 30%。 */
function pctText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

/**
 * 每张卡的六维评估表（纯函数）。
 *
 * ⚠️ 维度名、权重、量表上限**全部来自规格**，本文件不写一个字面量。
 * ⚠️ 规格取不到时**不编造维度**：只给一条能照做的提示（宁可少一个功能，
 *    也不能让委员会对着编出来的维度打分 —— 那是拿规则开玩笑）。
 */
export function solvabilityFormHtml({ pkg = null, spec = null } = {}) {
  const view = packageView(pkg);
  const dims = spec?.dimensions ?? [];
  if (!dims.length) {
    return noticeState({
      tone: 'warn',
      title: '六维评估表尚未就绪',
      items: [
        '服务端没有返回六维评估规格（维度 / 权重 / 量表），本页渲染不出评分表。',
        '规格缺位时不会用编出来的维度顶替 —— 请让后端补一个规格投影端点后再评估。',
      ],
    });
  }
  const id = escapeHtml(view.id);
  const rows = dims.map((d) => {
    const key = escapeHtml(d.key);
    const current = view.values[d.key];
    const options = [];
    for (let v = 0; v <= d.max; v += 1) {
      const selected = Number(current) === v ? ' selected' : '';
      options.push(`<option value="${v}"${selected}>${v} / ${d.max}</option>`);
    }
    const hasValue = current !== undefined;
    return `
            <tr>
              <td>${escapeHtml(d.label)}</td>
              <td class="td-num">${escapeHtml(pctText(d.weight))}</td>
              <td>
                <select class="select" id="dim-${id}-${key}" data-role="dimension" data-dimension="${key}"${view.canAssess ? '' : ' disabled'}>
                  <option value=""${hasValue ? '' : ' selected'}>— 未评 —</option>
                  ${options.join('')}
                </select>
              </td>
            </tr>`;
  }).join('');

  const vetoes = selfReportedVetoes(spec);
  const vetoRows = vetoes.map((v) => `
            <label class="checkbox">
              <input type="checkbox" data-role="veto" data-veto="${escapeHtml(v.key)}"${view.vetoes.includes(v.key) ? ' checked' : ''}${view.canAssess ? '' : ' disabled'} />
              <span>${escapeHtml(v.label || v.key)}</span>
            </label>`).join('');

  return `
        <div class="stack">
          ${tableWrap(`
            <thead><tr><th>可解性维度</th><th class="td-num">权重</th><th>评分</th></tr></thead>
            <tbody>${rows}</tbody>`, { caption: '六维可解性评估表', className: 'table table--compact' })}
          ${vetoRows ? `<div class="radio-group">${vetoRows}</div>` : ''}
          <div class="row">
            <button type="button" class="btn btn--primary btn--sm" data-action="assess" data-id="${id}"${view.canAssess ? '' : ' disabled'}>提交六维评估</button>
            ${view.canAssess ? '' : noticeState({ tone: 'info', items: [`该卡当前为「${view.statusLabel}」，不能重新评估（下方控件已锁）。`] })}
          </div>
        </div>`;
}

/**
 * 每张卡的签级区（纯函数）：通过（选档位）/ 退回（必填理由）。
 *
 * ⚠️ 退回档由档位区间最低的那一档决定（见 gradeTiers）⇒ 不写死键名。
 */
export function signoffFormHtml({ pkg = null, spec = null } = {}) {
  const view = packageView(pkg);
  const tiers = gradeTiers(spec);
  if (!tiers.complete) {
    return noticeState({
      tone: 'warn',
      title: '签级档位尚未就绪',
      items: ['服务端没有返回档位规格（分数区间 / 承诺 / 协议），本页无法签级。'],
    });
  }
  const id = escapeHtml(view.id);
  const options = tiers.approve.map((g) => `
            <option value="${escapeHtml(g.key)}">${escapeHtml(g.key)}（${g.minScore}–${g.maxScore} 分）· ${escapeHtml(g.commitment)}</option>`).join('');
  const ret = tiers.return;
  return `
        <div class="stack">
          <div class="row">
            <label class="field" for="grade-${id}">
              <span class="field__label">签级</span>
              <select class="select" id="grade-${id}" data-role="grade"${view.canSign ? '' : ' disabled'}>${options}</select>
            </label>
            <button type="button" class="btn btn--primary btn--sm" data-action="approve" data-id="${id}"${view.canSign ? '' : ' disabled'}>签级通过</button>
          </div>
          <label class="field field--required" for="reason-${id}">
            <span class="field__label">退回理由（退回时必填）</span>
            <textarea class="textarea" id="reason-${id}" data-role="reason" placeholder="写清缺什么、怎么补；补齐后可重新提交六维评估"${view.canSign ? '' : ' disabled'}></textarea>
          </label>
          <div class="row">
            <button type="button" class="btn btn--danger btn--sm" data-action="return" data-id="${id}"${view.canSign ? '' : ' disabled'}>退回出题方</button>
            <span class="small muted">退回档：${escapeHtml(ret.key)}（${ret.minScore}–${ret.maxScore} 分）· ${escapeHtml(ret.agreement)}</span>
          </div>
          ${view.canSign ? '' : noticeState({ tone: 'info', items: [`该卡当前为「${view.statusLabel}」，不能签级（下方控件已锁）。`] })}
        </div>`;
}

/** 一张任务卡的完整卡片（纯函数）。 */
export function taskPackageCardHtml({ pkg = null, spec = null } = {}) {
  const view = packageView(pkg);
  const id = escapeHtml(view.id);
  const badges = [
    badge(view.statusLabel, view.statusTone),
    view.isFreeBrief ? badge('自由命题', 'brand') : badge('企业命题', 'info'),
    view.grade
      ? badge(`已签 ${view.grade}`, 'success')
      : (view.solvabilityGrade ? badge(`评估 ${view.solvabilityGrade}`, 'warn') : badge('未分级', 'warn')),
  ].join('');
  const details = [
    ['出题方', view.enterpriseName || (view.isFreeBrief ? '自由命题' : '')],
    ['痛点', view.painPoint],
    ['期望交付', view.expectedDelivery],
    ['验收标准', view.acceptanceCriteria],
    ['可解性得分', view.solvabilityScore === null || view.solvabilityScore === undefined ? '' : String(view.solvabilityScore)],
    ['企业承诺', view.commitment],
    ['对应协议', view.agreement],
  ];
  return `
      <article class="card" data-card="${id}">
        <div class="row row--between">
          <h3>${escapeHtml(view.title)}</h3>
          <div class="row">${badges}</div>
        </div>
        ${kvList(details)}
        <div class="divider"></div>
        <h4>六维可解性评估</h4>
        ${solvabilityFormHtml({ pkg, spec })}
        <div class="divider"></div>
        <h4>分级签约</h4>
        ${signoffFormHtml({ pkg, spec })}
        <div class="form-feedback" data-feedback="${id}"></div>
      </article>`;
}

/**
 * 任务卡列表（纯函数）。
 * ⚠️ 空态必须给**可点的下一步**（设计系统 §4）。
 */
export function taskPackagesHtml({ packages = [], spec = null } = {}) {
  const list = Array.isArray(packages) ? packages : [];
  if (!list.length) {
    return emptyState({
      title: '还没有任务卡',
      hint: '企业或组委会提交任务卡后，这里会逐张列出：先做六维可解性评估，再分级签级。',
    });
  }
  return `<div class="stack">${list.map((pkg) => taskPackageCardHtml({ pkg, spec })).join('')}</div>`;
}

/**
 * 提交结果反馈（纯函数）：成功用提示条，失败用错误态（**必须带真能点的「重试」**）。
 *
 * ⚠️ 失败不给重试 = 死路一条（DP-80）⇒ 错误态一律 retry: true，
 *    「重试」按钮由视图侧绑到同一次提交（重跑，不是刷新页面）。
 */
export function feedbackHtml({ tone: t = 'info', title = '', message = '' } = {}) {
  if (t === 'danger' || t === 'error') {
    return errorState({
      message,
      retry: true,
      hint: '点「重试」重跑刚才那一次提交（不会刷新页面，也不会冲掉别的卡已填的内容）。',
    });
  }
  return noticeState({ tone: t, title, items: message ? [message] : [] });
}

// ══════════════════════════════════════════════════════════════════
// 四、提交计划（纯函数）：先把校验做完，再发请求
// ══════════════════════════════════════════════════════════════════

/**
 * 六维评估的提交计划（纯函数）。
 *
 * ⚠️ 服务端对每一维都做 0..max 的整数校验（INVALID_SOLVABILITY_ANSWERS）⇒
 *    前端先拦一道：没打分的维度**不许**发出去（发出去也是 400，白跑一趟）。
 *
 * @returns {{ ok: true, url: string, body: object } | { ok: false, message: string }}
 */
export function planSolvabilitySubmit({ pkg = null, values = {}, vetoes = [], spec = null } = {}) {
  const dims = spec?.dimensions ?? [];
  if (!dims.length) return { ok: false, message: '六维评估规格未就绪，无法提交评估。' };
  const answers = {};
  const missing = [];
  for (const d of dims) {
    const raw = values[d.key];
    const v = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isInteger(v) || v < 0 || v > d.max) {
      missing.push(d.label || d.key);
      continue;
    }
    answers[d.key] = v;
  }
  if (missing.length) return { ok: false, message: `还有维度没打分：${missing.join('、')}。` };
  const declared = (Array.isArray(vetoes) ? vetoes : []).filter((k) => typeof k === 'string' && k);
  const body = { answers: declared.length ? { ...answers, vetoes: declared } : { ...answers } };
  return {
    ok: true,
    url: `/api/task-packages/${encodeURIComponent(pkg?.id ?? '')}/solvability`,
    body,
  };
}

/**
 * 签级 / 退回的提交计划（纯函数）。
 *
 * ⚠️ **退回必须写理由**（本地强制）：理由是退回时唯一能传给企业的信息 ——
 *    服务端在 D 级退回时会出《问题可解性诊断报告》，但「为什么退、怎么补」得有人说。
 * ⚠️ 当前后端的 approve 端点**只读 grade**（不收也不校验理由）⇒ 理由先在前端强制，
 *    并随请求带上（后端补上 reason 字段后即可生效）。
 *
 * @returns {{ ok: true, url: string, body: object } | { ok: false, message: string }}
 */
export function planSignoffSubmit({ pkg = null, action = 'approve', grade = '', reason = '', spec = null } = {}) {
  const tiers = gradeTiers(spec);
  if (!tiers.complete) return { ok: false, message: '档位规格未就绪，无法签级。' };
  const url = `/api/task-packages/${encodeURIComponent(pkg?.id ?? '')}/approve`;
  if (action === 'return') {
    const why = String(reason ?? '').trim();
    if (!why) {
      return { ok: false, message: '退回必须写理由：写清缺什么、怎么补，补齐后可重新提交六维评估。' };
    }
    return { ok: true, url, body: { grade: tiers.return.key, reason: why } };
  }
  const key = String(grade ?? '').trim();
  const hit = tiers.approve.find((g) => g.key === key);
  if (!hit) return { ok: false, message: '请先选择要签的档位。' };
  return { ok: true, url, body: { grade: hit.key } };
}

// ══════════════════════════════════════════════════════════════════
// 五、视图
// ══════════════════════════════════════════════════════════════════

/**
 * 取规则投影（失败一律降级为 null，不抛）。
 * ⚠️ 生产部署默认不挂 /rules/ ⇒ 取不到是**正常**情况，不能让整页因此报错。
 *
 * ⚠️ **P10：优先走服务端投影**（`GET /api/event-info` 的 `solvability` 字段）——
 *    `/rules/` 只有 DEMO_MODE=1 才挂 ⇒ 生产环境这条路是**断的**，
 *    冷启动（一张卡都没评估过）时页面会画不出六维表。
 *    服务端投影由 `src/domain/event-info.js` 的 `buildEventInfo` 产出，
 *    **演示站与正式站同源**（演示适配器 import 的是同一个函数）⇒ 形状与数值天然对齐。
 *    静态规则文件只作为**兜底**（服务端还没上这个投影时的降级路径）。
 */
async function fetchSolvabilityRules(api) {
  try {
    const info = await api.get('/api/event-info');
    const spec = solvabilitySpecFromRules(info?.solvability);
    if (spec) return { rules: info.solvability, source: 'api' };
  } catch {
    // 取不到就退到静态规则文件（下面）
  }
  try {
    const res = await fetch(RULES_URL, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return { rules: await res.json(), source: 'rules' };
  } catch {
    return null;
  }
}

/** 当届届期（公开端点；取不到就不过滤届期）。 */
async function loadEditionId(api) {
  try {
    const criteria = await api.get('/api/registration-criteria');
    return criteria?.editionId ?? '';
  } catch {
    return '';
  }
}

/** 顶部指标（纯函数）。 */
export function statCards(packages) {
  const list = Array.isArray(packages) ? packages : [];
  const count = (status) => list.filter((p) => p?.status === status).length;
  return [
    { label: '任务卡总数', value: list.length, tone: 'brand' },
    { label: '待评估', value: count('submitted') },
    { label: '待签级', value: count('assessed') },
    { label: '已退回', value: count('returned'), tone: 'warn' },
    { label: '已发布', value: count('published'), tone: 'success' },
  ];
}

/** 任务池配比体检（纯函数；数据来自 API 的 mix 字段，不自己算比例）。 */
export function mixPanelHtml(mix) {
  if (!mix) {
    return panel({
      title: '任务池配比体检',
      desc: '体检对象是已发布（进池）的任务卡。',
      body: '<p class="muted">暂无配比体检数据（需要组委会权限且任务卡已发布）。</p>',
    });
  }
  return panel({
    title: '任务池配比体检',
    desc: '体检对象是已发布（进池）的任务卡。',
    body: `${kvList([
      ['任务池卡片', String(mix.total ?? 0)],
      ['自由命题', `${mix.free ?? 0}（${pctText(mix.actualFree)}）`],
      ['企业命题', `${mix.enterprise ?? 0}（${pctText(mix.actualEnterprise)}）`],
      ['结论', mix.ok ? '配比达标' : '配比未达标'],
    ])}
      ${mix.ok ? '' : noticeState({ tone: 'danger', title: '配比未达标', items: mix.errors ?? [], list: true })}`,
  });
}

/**
 * 任务卡分级 / 审批页。
 *
 * @param {object} ctx  { api, navigate, setState, getState }
 * @returns {HTMLElement}
 */
export function renderAdminTaskPackages(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-task-packages';
  const { api } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '任务卡审批',
      sub: '组委会工作台：先做六维可解性评估，再分级签级。评估与签级都即时反馈，失败可重试。',
    })}
    <div id="tp-body">${loadingState({ rows: 3, label: '正在加载任务卡…' })}</div>`;

  const body = wrap.querySelector('#tp-body');
  let packages = [];
  let mix = null;
  let spec = null;

  /** 加载任务卡；错误态的「重试」按钮复用它（真的重跑一次）。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 3, label: '正在加载任务卡…' });
    try {
      const editionId = await loadEditionId(api);
      const query = editionId ? `?editionId=${encodeURIComponent(editionId)}` : '';
      const res = await api.get(`/api/task-packages${query}`);
      packages = res?.items ?? res?.rows ?? [];
      mix = res?.mix ?? null;
      // ⚛️ F16（Critical）：规格**规则投影优先**。
      //    原来这里是「服务端投影优先」⇒ 一旦有任意一张卡被评估过，
      //    **残缺**的包投影（只有档位键、没有分数区间）就盖掉了完整规则
      //    ⇒ `gradeTiers()` 判「档位未就绪」⇒ **签级控件整片消失**
      //    （自锁：评估更多卡也修不好，只有改代码才能恢复）。
      //    两个投影的优先级由 `resolveSolvabilitySpec()` 统一定义（规则投影更完整 ⇒ 有它就用它），
      //    本文件另有一处同名解析器，两者曾**相反** ⇒ 现在只有这一个入口。
      //    生产环境不挂 /rules/（只有 DEMO_MODE=1）⇒ 那时靠服务端投影 ——
      //    服务端现在也把完整档位定义带进 meta.solvability（见 services/taskPackage.js）。
      const fetched = await fetchSolvabilityRules(api);
      spec = resolveSolvabilitySpec({ packages, rules: fetched?.rules ?? null });
    } catch (e) {
      body.innerHTML = errorState({
        message: '任务卡加载失败',
        hint: `接口返回：${e.message}。点「重试」重新加载；若持续失败，请确认服务端已启动且你的账号有组委会权限。`,
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
      return;
    }
    render();
  }

  function render() {
    const source = spec?.source === 'api' ? '服务端投影' : (spec?.source === 'rules' ? '规则文件投影' : '未取得');
    body.innerHTML = `
      <div class="stack">
        <div data-stat-row>${statRow(statCards(packages))}</div>
        <div data-mix>${mixPanelHtml(mix)}</div>
        ${panel({
          title: '任务卡',
          desc: `逐张评估与签级（六维评估表规格来源：${source}）。`,
          body: taskPackagesHtml({ packages, spec }),
        })}
      </div>`;
    for (const card of body.querySelectorAll('[data-card]')) {
      bindCard(card, packages.find((p) => p.id === card.dataset.card));
    }
  }

  /** 绑一张卡的交互。 */
  function bindCard(card, pkg) {
    card.querySelector('[data-action="assess"]')?.addEventListener('click', () => submitAssess(card, pkg));
    card.querySelector('[data-action="approve"]')?.addEventListener('click', () => submitSignoff(card, pkg, 'approve'));
    card.querySelector('[data-action="return"]')?.addEventListener('click', () => submitSignoff(card, pkg, 'return'));
  }

  /** 提交六维评估。 */
  async function submitAssess(card, pkg) {
    const values = {};
    for (const el of card.querySelectorAll('[data-role="dimension"]')) {
      values[el.dataset.dimension] = el.value;
    }
    const vetoes = [];
    for (const el of card.querySelectorAll('[data-role="veto"]')) {
      if (el.checked) vetoes.push(el.dataset.veto);
    }
    const plan = planSolvabilitySubmit({ pkg, values, vetoes, spec });
    if (!plan.ok) {
      setFeedback(card, { tone: 'danger', message: plan.message });
      return;
    }
    await runSubmit(card, pkg, plan, '已提交六维可解性评估');
  }

  /** 提交签级 / 退回。 */
  async function submitSignoff(card, pkg, action) {
    const grade = card.querySelector('[data-role="grade"]')?.value ?? '';
    const reason = card.querySelector('[data-role="reason"]')?.value ?? '';
    const plan = planSignoffSubmit({ pkg, action, grade, reason, spec });
    if (!plan.ok) {
      setFeedback(card, { tone: 'danger', message: plan.message });
      return;
    }
    await runSubmit(card, pkg, plan, action === 'return' ? '已退回出题方' : '已签级');
  }

  /**
   * 真的发一次请求。
   * ⚠️ 成功后**只换掉这一张卡**（不整页刷新）—— 整页刷新会冲掉别的卡已填的评分。
   * ⚠️ 失败必须留下**真能点的重试**：重试的是同一次提交（不是刷新页面）。
   */
  async function runSubmit(card, pkg, plan, successTitle) {
    const feedback = card.querySelector('[data-feedback]');
    const buttons = [...card.querySelectorAll('button[data-action]')];
    for (const b of buttons) b.disabled = true;
    if (feedback) feedback.innerHTML = loadingState({ rows: 1, label: '正在提交…' });
    try {
      const updated = await api.post(plan.url, plan.body);
      const fresh = replaceCard(updated ?? pkg);
      setFeedback(fresh ?? card, { tone: 'success', title: successTitle, message: successMessage(updated ?? pkg) });
      // ⚠️ **提交成功后必须刷新顶部统计与配比体检**：
      //    只换卡片 ⇒ 「待评估 / 待签级 / 已发布」三个计数还停在提交前 ⇒
      //    页面上写着「1 待评估」，而那张卡已经评完了 —— **页面在骗人**。
      //    ⛔ 只刷统计与体检，**不重画卡片列表**（重画会把别的卡已填的评分冲掉）。
      await refreshSummary();
    } catch (e) {
      setFeedback(card, { tone: 'danger', message: `提交失败：${e.message}` });
      card.querySelector('[data-action="retry"]')?.addEventListener('click', () => runSubmit(card, pkg, plan, successTitle));
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  /**
   * 刷新顶部统计与配比体检（提交成功后调用）。
   * ⚠️ 重新拉一次列表是**为了拿服务端口径**（配比体检的对象是已发布的卡，
   *    本地数组算不出它）⇒ 取不到就退回本地状态，**不让一次刷新失败把整页弄坏**。
   */
  async function refreshSummary() {
    try {
      const editionId = await loadEditionId(api);
      const query = editionId ? `?editionId=${encodeURIComponent(editionId)}` : '';
      const res = await api.get(`/api/task-packages${query}`);
      const fresh = res?.items ?? res?.rows ?? [];
      if (fresh.length) packages = fresh;
      mix = res?.mix ?? mix;
    } catch {
      // 保留本地状态，只刷新统计
    }
    const row = body.querySelector('[data-stat-row]');
    if (row) row.innerHTML = statRow(statCards(packages));
    const mixHost = body.querySelector('[data-mix]');
    if (mixHost) mixHost.innerHTML = mixPanelHtml(mix);
  }

  /** 成功提示的正文（数据来自服务端返回值，不自己编口径）。 */
  function successMessage(pkg) {
    const view = packageView(pkg);
    if (view.grade) {
      return `当前档位 ${view.grade}；企业承诺：${view.commitment || '—'}；对应协议：${view.agreement || '—'}。`;
    }
    if (view.solvabilityScore !== null && view.solvabilityScore !== undefined) {
      return `可解性得分 ${view.solvabilityScore}，评估档位 ${view.solvabilityGrade ?? '—'}。`;
    }
    return '已更新。';
  }

  /** 就地把一张卡换成服务端返回的最新状态（其它卡不动）。 */
  function replaceCard(pkg) {
    if (!pkg?.id) return null;
    const idx = packages.findIndex((p) => p.id === pkg.id);
    if (idx >= 0) packages[idx] = pkg;
    else packages = [...packages, pkg];
    let old = null;
    for (const card of body.querySelectorAll('[data-card]')) {
      if (card.dataset.card === pkg.id) { old = card; break; }
    }
    if (!old) return null;
    const holder = document.createElement('div');
    holder.innerHTML = taskPackageCardHtml({ pkg, spec });
    const fresh = holder.firstElementChild;
    if (!fresh) return null;
    old.replaceWith(fresh);
    bindCard(fresh, pkg);
    return fresh;
  }

  /** 就地反馈（成功 / 失败都看得见）。 */
  function setFeedback(card, { tone: t = 'info', title = '', message = '' } = {}) {
    const feedback = card?.querySelector('[data-feedback]');
    if (!feedback) return;
    feedback.innerHTML = feedbackHtml({ tone: t, title, message });
  }

  load();
  return wrap;
}
```

### 申诉裁决界面（组委会侧）

`platform/web/views/admin-appeals.js` —— 申诉裁决界面（组委会侧）

```javascript
// web/views/admin-appeals.js — 组委会：申诉裁决队列
// 依据：设计文档 §9「组委会视角 → 复核/申诉/改级」、§11.2（人工复核与申诉状态机）
//   + R-REG-08（C 级不接收 ⇒ 选手可向组委会提交申诉）
//
// ⚠️ **端点契约一律以源码为准**（src/http/routes/audit.js + src/services/review-state.js）：
//   GET  /api/appeals              → { rows: [{ id, subjectType, subjectId, filedBy, reason,
//                                              status, decidedBy, decidedAt, decisionNote, createdAt }],
//                                      total }
//   POST /api/appeals/:id/decide    body = { decision: 'accepted' | 'rejected', note }
//     · note **必填**：decideAppeal 对空说明抛 400「裁决必须写说明（无说明的裁决无法复盘）」；
//     · 状态机：只有 status ∈ { submitted, reviewing } 的申诉可裁决；
//       裁决后 status 落到 accepted / rejected（终态，再裁决会 409）；
//     · accepted = 申诉成立 ⇒ 撤销终稿（FINALIZED → REJECTED → PENDING_REVIEW）并要求重算。
//   列表需要 audit:read、裁决需要 audit:write（前端只按能力点拦**分区级页面**，API 才是最终裁决者）。
//
// ⛔ **视觉参考 web/views/flags.js（复核队列）**：同样的「列表 + 就地裁决」模式 ——
//    裁决成功后这一条**就地变成已裁决**（徽章换色 + 表单换成结果面板 + 计数与筛选同步），
//    不是只改一行提示（用户必须看得见「这条已经处理掉了」）。
//
// ⛔ 前端**不做可见性过滤**（全局约束）：API 返回什么就渲染什么，一个都不许丢。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, statRow,
} from '../ui.js';

/** 申诉状态 → 中文标签。 */
const STATUS_LABELS = {
  submitted: '待裁决',
  reviewing: '复核中',
  accepted: '申诉成立',
  rejected: '申诉驳回',
};

/** 申诉状态 → 徽章色调。 */
const STATUS_TONES = {
  submitted: 'warn',
  reviewing: 'info',
  accepted: 'success',
  rejected: 'danger',
};

/** 状态 → 中文标签（未知状态原样透出，不猜）。 */
export function appealStatusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? '未知');
}

/** 状态 → 徽章色调（未知状态走中性）。 */
export function appealStatusTone(status) {
  return STATUS_TONES[status] ?? 'neutral';
}

/**
 * 这条申诉现在能不能裁决。
 * ⚠️ 口径以服务端状态机为准（decideAppeal）：只有 submitted / reviewing 可裁决，
 *    已裁决的（accepted / rejected）再裁决会 409。
 */
export function canDecide(status) {
  return status === 'submitted' || status === 'reviewing';
}

/**
 * 裁决校验（纯函数）：结论只能是 accepted / rejected，说明**必填**。
 * @returns {{ok: boolean, decision?: string, note?: string, message?: string}}
 */
export function validateDecision({ decision, note } = {}) {
  if (!['accepted', 'rejected'].includes(decision)) {
    return { ok: false, message: '裁决结论只能是「申诉成立」或「申诉驳回」。' };
  }
  const text = String(note ?? '').trim();
  if (!text) return { ok: false, message: '裁决说明必填：无说明的裁决无法复盘。' };
  return { ok: true, decision, note: text };
}

/**
 * 申诉卡片正文（纯函数）：徽章 + 申诉对象 + 理由。
 * ⚠️ 裁决前后用**同一套结构**重建（重建时卡片不会跳版）。
 */
export function buildAppealCard(appeal, extra = '') {
  const status = appeal?.status ?? 'submitted';
  const decided = !canDecide(status);
  const meta = [
    `对象 ${appeal?.subjectId ?? '—'}`,
    `提交人 ${appeal?.filedBy ?? '—'}`,
    `提交于 ${appeal?.createdAt ?? '—'}`,
  ];
  // ⚠️ 已裁决的条目要把「谁裁的、什么时候裁的、说明是什么」留在卡片上 ——
  //    申诉是留痕件，复盘时只看得到「已裁决」三个字是不够的。
  if (decided) {
    meta.push(`裁决人 ${appeal?.decidedBy ?? '—'}`);
    meta.push(`裁决于 ${appeal?.decidedAt ?? '—'}`);
  }
  return `
    <div class="row row--between">
      <div class="row">
        <strong>${escapeHtml(appeal?.subjectType ?? '申诉')}</strong>
        ${badge(appealStatusLabel(status), appealStatusTone(status))}
      </div>
      <span class="muted small">${escapeHtml(appeal?.id ?? '')}</span>
    </div>
    <p class="muted small">${meta.map((m) => escapeHtml(m)).join(' ｜ ')}</p>
    <p>${escapeHtml(appeal?.reason ?? '')}</p>
    ${decided && appeal?.decisionNote ? `<p class="muted small">裁决说明：${escapeHtml(appeal.decisionNote)}</p>` : ''}
    ${extra}`;
}

/**
 * 裁决表单（纯函数）：结论 + 说明 + 提交按钮。
 * ⚠️ 表单里的 id 是**契约**（#ap-decision / #ap-note / #ap-submit / #ap-error）。
 */
export function buildDecisionForm() {
  return `
      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">人工裁决</h2>
          <p class="panel__desc">裁决只留痕：成立 = 撤销终稿并转入重新复核（需重算），驳回 = 维持原判</p>
        </div>
        <div class="panel__body">
          <div class="field">
            <label class="field__label" for="ap-decision">裁决结论</label>
            <select class="select" id="ap-decision">
              <option value="accepted">申诉成立（撤销终稿，重新复核）</option>
              <option value="rejected">申诉驳回（维持原判）</option>
            </select>
          </div>
          <div class="field field--required">
            <label class="field__label" for="ap-note">裁决说明</label>
            <textarea class="textarea" id="ap-note" placeholder="写明裁决依据（必填）"></textarea>
            <p class="field__hint">无说明的裁决无法复盘 —— 必填。</p>
          </div>
          <div class="row">
            <button type="button" class="btn btn--primary" id="ap-submit">提交裁决</button>
          </div>
          <p class="field__error" id="ap-error"></p>
        </div>
      </div>`;
}

/** 裁决完成后的结果面板（纯函数）：徽章之外再把结论与「是否需要重算」讲清。 */
export function buildDecisionResult(decision, note, recomputeRequired) {
  return noticeState({
    tone: decision === 'accepted' ? 'success' : 'info',
    title: decision === 'accepted' ? '申诉成立' : '申诉驳回',
    items: [
      `裁决说明：${note}`,
      recomputeRequired
        ? '终稿已撤销、条目转入重新复核 —— 需要按 revision + 1 重算（旧记录保留，不覆盖历史）。'
        : '维持原判；裁决说明与结论已写入审计日志。',
    ],
    list: true,
  });
}

export function renderAdminAppeals(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-appeals';

  const head = document.createElement('div');
  head.innerHTML = `
    ${pageHead({
      title: '申诉裁决',
      sub: '组委会工作台：逐条看选手的申诉理由，给结论并留下说明。成立 = 撤销终稿、转入重新复核。',
    })}
    <div id="ap-stats">${loadingState({ rows: 1, label: '正在统计申诉队列…' })}</div>
    <div class="row" id="ap-filters">
      <button type="button" class="btn btn--primary btn--sm" id="ap-filter-all">全部</button>
      <button type="button" class="btn btn--ghost btn--sm" id="ap-filter-pending">待裁决</button>
      <button type="button" class="btn btn--ghost btn--sm" id="ap-filter-done">已裁决</button>
    </div>
    <p class="muted small" id="ap-msg">正在加载申诉队列…</p>
    <div id="ap-state"></div>`;
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.id = 'ap-list';
  wrap.appendChild(list);

  const msg = wrap.querySelector('#ap-msg');
  const statsBox = head.querySelector('#ap-stats');
  const stateBox = head.querySelector('#ap-state');

  /** 队列条目（含裁决后的状态），筛选与计数都从这里算。 */
  const items = [];
  let filter = 'all';

  // ⚠️ 重试用事件委托：errorState() 的重试按钮没有固定 id，委托到容器更稳。
  stateBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void load();
  });

  for (const [sel, value] of [['#ap-filter-all', 'all'], ['#ap-filter-pending', 'pending'], ['#ap-filter-done', 'done']]) {
    head.querySelector(sel)?.addEventListener('click', () => {
      filter = value;
      applyFilter();
      paintFilterButtons();
    });
  }

  async function load() {
    msg.textContent = '正在加载申诉队列…';
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载申诉队列…' });
    let data;
    try {
      data = await ctx.api.get('/api/appeals');
    } catch (e) {
      msg.textContent = '申诉队列加载失败';
      statsBox.innerHTML = '';
      stateBox.innerHTML = errorState({
        message: e.message,
        hint: '队列没拉到。可以重试；若持续失败，检查账号是否还有 audit:read 权限。',
      });
      return;
    }
    stateBox.innerHTML = '';
    const rows = data?.rows ?? [];
    renderRows(rows);
    updateStats();
    msg.textContent = `共 ${data?.total ?? rows.length} 条申诉（裁决只留痕，不直接改分）`;
  }

  function renderRows(rows) {
    list.replaceChildren();
    items.length = 0;
    if (!rows.length) {
      // ⚠️ 空态必须给**下一步**（不能是白屏）：告诉组委会队列为什么空、什么时候会有内容。
      list.innerHTML = emptyState({
        title: '申诉队列是空的',
        hint: '目前没有选手提交申诉。选手在报名被拒（C 级不接收）后可以在报名页提交申诉，'
          + '理由一到，这里就会出现待裁决的条目。',
      });
      return;
    }
    for (const appeal of rows) {
      const card = document.createElement('div');
      card.className = 'card appeal-row';
      card.innerHTML = buildAppealCard(appeal);
      if (canDecide(appeal.status)) card.appendChild(buildForm(appeal, onDecided));
      items.push({ appeal, card, status: appeal.status });
      list.appendChild(card);
    }
    applyFilter();
  }

  /**
   * 裁决表单。
   * ⚠️ 说明为空**就地拒绝**（不发请求）：服务端也会拒收空说明，
   *    前端先拦一道，用户少一次往返。
   */
  function buildForm(appeal, onResolved) {
    const form = document.createElement('div');
    form.innerHTML = buildDecisionForm();

    const err = form.querySelector('#ap-error');
    form.querySelector('#ap-submit').addEventListener('click', async () => {
      const decision = form.querySelector('#ap-decision').value;
      const note = form.querySelector('#ap-note').value.trim();
      const check = validateDecision({ decision, note });
      if (!check.ok) {
        err.textContent = check.message;
        return;
      }
      err.textContent = '';
      try {
        const out = await ctx.api.post(
          `/api/appeals/${encodeURIComponent(appeal.id)}/decide`,
          { decision: check.decision, note: check.note },
        );
        onResolved(appeal, {
          status: out?.appeal?.status ?? out?.status ?? check.decision,
          note: out?.appeal?.decision_note ?? out?.appeal?.decisionNote ?? check.note,
          recomputeRequired: out?.recomputeRequired === true,
        });
      } catch (e) {
        err.textContent = `裁决失败：${e.message}`;
      }
    });
    return form;
  }

  /**
   * 裁决成功：这一条**就地变成已裁决**（徽章换色 + 表单换成结果面板 + 计数与筛选同步）。
   */
  function onDecided(appeal, result) {
    const rec = items.find((it) => it.appeal.id === appeal.id);
    if (!rec) return;
    rec.status = result.status;
    rec.appeal = { ...rec.appeal, status: result.status };
    rec.card.innerHTML = buildAppealCard(
      rec.appeal,
      buildDecisionResult(result.status, result.note, result.recomputeRequired),
    );
    updateStats();
    applyFilter();
  }

  function updateStats() {
    const pending = items.filter((it) => canDecide(it.status)).length;
    const done = items.filter((it) => !canDecide(it.status)).length;
    statsBox.innerHTML = statRow([
      { label: '待裁决', value: pending, tone: 'warn' },
      { label: '已裁决', value: done, tone: 'success' },
      // ⚠️ 总数取**本页已加载的条数**：这样「待裁决 + 已裁决 = 总数」自洽；
      //    接口返回的 total（含分页）在页头 #ap-msg 里单独说明。
      { label: '总数', value: items.length, tone: 'neutral' },
    ]);
  }

  function applyFilter() {
    for (const it of items) {
      const show = filter === 'all'
        || (filter === 'pending' && canDecide(it.status))
        || (filter === 'done' && !canDecide(it.status));
      it.card.hidden = !show;
    }
  }

  /** 当前筛选用主色按钮，其余用幽灵按钮（用户一眼知道在看哪一段）。 */
  function paintFilterButtons() {
    for (const [sel, value] of [['#ap-filter-all', 'all'], ['#ap-filter-pending', 'pending'], ['#ap-filter-done', 'done']]) {
      const btn = head.querySelector(sel);
      if (btn) btn.className = `btn btn--sm ${value === filter ? 'btn--primary' : 'btn--ghost'}`;
    }
  }

  void load();
  return wrap;
}
```

### 评委前置界面（回避 / 互评 / 自评 / 校准）

`platform/web/views/review-prep.js` —— 评委前置界面（回避 / 互评 / 自评 / 校准）

```javascript
// web/views/review-prep.js — 评委前置页：回避申报 / 互评 / 自评 / 校准（P10 · W4-d 新建）
//
// 规则溯源（口径与形状一律以源码为准）：
//   - 「评委为供应方 / 投资方 / 前雇主必须回避，回避记录留档」→ R-JDG-09
//   - 「评委须签署声明」→ R-JDG-18
//   - 「用同一组样例作品校准宽严尺度，校准结果不计入评分」→ R-JDG-12
//   - 「自评测只触发解释与提问，不加分」→ R-JDG-13 + src/domain/self-eval.js
//   - 「互评：队 → 队，提交者必须是发起队的在册成员」→ src/services/review.js submitPeerReviews
//   - 「分值 0–100」→ src/services/review.js assertScoreInRange
//
// ⚠️ **四个端点的请求体形状互不相同，抄错就是 400**（照 src/http/routes/review.js 摘出来的）：
//   ① 回避  POST /api/stages/:stageId/recusals
//      { teamId?: string|null, reason: string }
//      ⚠️ **不传 judgeId = 给自己申报**（路由明写：非组委会不能代他人申报回避）。
//   ② 互评  POST /api/stages/:stageId/peer-reviews
//      { items: [{ fromTeamId, toTeamId, score }], requestId?: string }
//      ⚠️ 字段叫 **`score`**（**不是** rawScore）—— 与自评 / 校准不同。
//   ③ 自评  POST /api/stages/:stageId/self-review
//      { teamId: string, items: [{ dimension, rawScore }], requestId?: string }
//   ④ 校准  POST /api/stages/:stageId/calibration
//      { items: [{ dimension, rawScore }] }   ← **无 requestId**
//
// ⚠️ **P10：回避台账已有读端点**：
//   `GET /api/stages/:stageId/recusals`（评委只见自己的，组委会看全部）⇒
//   「已回避清单」显示的是**台账**，不再是「本页面本次会话内申报成功」的记录。
//   台账是追加式的（申报 → 撤销 → 再申报）⇒ 前端用 `currentRecusals` 折叠成当前状态。
//
// ⚠️ **维度一律从 API 取**（⛔ 不许硬编码维度名与权重）：
//   评委席维度取 `GET /api/stages/:stageId/review-board` 的 `judgeDimensions`，
//   自评测维度取同一份返回的 `dimensions` 里 seat='self' 的那些 ——
//   初赛权重表本来就没有自评测维度（只有决赛有），所以那一步必须**按数据算**，不能写死。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel, statRow,
} from '../ui.js';

const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** 「整个赛段」回避的哨兵值（请求体里 teamId 传 null）。 */
const STAGE_SCOPE = '__stage__';

/** 四个区块的键 —— 与页面里反馈区的 data-feedback / data-retry-kind 一一对应。 */
export const PREP_SECTIONS = Object.freeze(['recusal', 'peer', 'self', 'calibration']);

// ══════════════════════════════════════════════════════════════════
// 一、纯函数：解析与本地校验
// ══════════════════════════════════════════════════════════════════

/**
 * 分值解析（纯函数）。
 * @param {unknown} raw 输入框原始值
 * @returns {{value: number|null}|{error: string}} 空值 = 未打分（**不是** 0 分）
 */
export function parseScore(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: '必须是数字' };
  if (n < MIN_SCORE || n > MAX_SCORE) return { error: `必须在 ${MIN_SCORE}–${MAX_SCORE} 之间` };
  return { value: n };
}

/**
 * 回避申报：本地校验 + 组装请求体（纯函数）。
 * ⚠️ 后端会拒的理由只有两种（src/services/review.js declareRecusal）：
 *    ① 理由为空 → 400 RECUSAL_REASON_REQUIRED；
 *    ② 队伍不在本赛段名册 → 404 TEAM_NOT_IN_STAGE。
 *   前端先把这两种拦下来，不发无谓请求。
 *
 * @param {object} input { teamId, reason, teams }
 * @returns {{payload: object|null, errors: Array<{field:string,message:string}>}}
 */
export function buildRecusalRequest({ teamId = null, reason = '', teams = [] } = {}) {
  const errors = [];
  const text = String(reason ?? '').trim();
  if (!text) {
    errors.push({ field: 'reason', message: '回避必须填写原因（供应方 / 投资方 / 前雇主）' });
  }
  const scope = teamId === STAGE_SCOPE ? null : (teamId || null);
  if (scope && !(teams ?? []).some((t) => t.id === scope)) {
    errors.push({ field: 'teamId', message: '所选队伍不在本赛段名册内' });
  }
  if (errors.length) return { payload: null, errors };
  return { payload: { teamId: scope, reason: text }, errors };
}

/**
 * 互评：给别的队伍打分（纯函数）。
 * ⚠️ 请求体里的分数字段是 **`score`**（不是 rawScore）—— 抄错就是 400。
 * @param {Record<string,string>} values key = `${fromTeamId}::${toTeamId}`
 * @param {object} ctx { fromTeamId, toTeams }
 */
export function buildPeerReviewItems(values, { fromTeamId = null, toTeams = [] } = {}) {
  const items = [];
  const errors = [];
  if (!fromTeamId) {
    errors.push({ field: 'fromTeamId', message: '还没选发起互评的队伍' });
    return { items, errors };
  }
  for (const team of toTeams ?? []) {
    const raw = (values ?? {})[`${fromTeamId}::${team.id}`];
    const parsed = parseScore(raw);
    if (parsed.error) {
      errors.push({ teamId: team.id, message: parsed.error });
      continue;
    }
    if (parsed.value === null) {
      errors.push({ teamId: team.id, message: '还没打分' });
      continue;
    }
    items.push({ fromTeamId, toTeamId: team.id, score: parsed.value });
  }
  if (!items.length && !errors.length) {
    errors.push({ field: 'toTeams', message: '这个赛段没有可互评的队伍' });
  }
  return { items, errors };
}

/**
 * 按维度打分（自评 / 校准共用同一形状：{ dimension, rawScore }）（纯函数）。
 * @param {Record<string,string>} values key = 维度 key
 * @param {Array<{key:string}>} dimensions 维度（**从 API 来**，不许硬编码）
 */
export function buildDimensionItems(values, dimensions = []) {
  const items = [];
  const errors = [];
  for (const dim of dimensions ?? []) {
    const raw = (values ?? {})[dim.key];
    const parsed = parseScore(raw);
    if (parsed.error) {
      errors.push({ dimension: dim.key, message: parsed.error });
      continue;
    }
    if (parsed.value === null) {
      errors.push({ dimension: dim.key, message: '还没打分' });
      continue;
    }
    items.push({ dimension: dim.key, rawScore: parsed.value });
  }
  return { items, errors };
}

/** 自评 items（纯函数）。 */
export function buildSelfReviewItems(values, dimensions = []) {
  return buildDimensionItems(values, dimensions);
}

/** 校准 items（纯函数）。 */
export function buildCalibrationItems(values, dimensions = []) {
  return buildDimensionItems(values, dimensions);
}

// ══════════════════════════════════════════════════════════════════
// 二、纯函数：维度与队伍（⛔ 全部从 API 返回里推导）
// ══════════════════════════════════════════════════════════════════

/** 按 seat 拆维度（⛔ 维度名与权重都来自 review-board）。 */
export function dimensionsBySeat(board) {
  const dims = Array.isArray(board?.dimensions) ? board.dimensions : [];
  return {
    judge: dims.filter((d) => d.seat === 'judge'),
    self: dims.filter((d) => d.seat === 'self'),
    enterprise: dims.filter((d) => d.seat === 'enterprise'),
  };
}

/** 评委席维度：优先用 review-board 自带的 judgeDimensions（与写入口同一口径）。 */
export function judgeDimensionsOf(board) {
  if (Array.isArray(board?.judgeDimensions) && board.judgeDimensions.length) {
    return board.judgeDimensions;
  }
  return dimensionsBySeat(board).judge;
}

/** 自评测维度：seat='self' 的那些（初赛权重表里没有 ⇒ 空数组，不是写死一个）。 */
export function selfDimensionsOf(board) {
  return dimensionsBySeat(board).self;
}

/**
 * 发起队 / 被评队（纯函数）。
 * ⚠️ 我参与哪些队伍来自 `GET /api/teams`（前端手里只有这个来源）；
 *    读不到时退回到赛段名册，并把 `uncertain` 置真 ⇒ 页面要说清「提交可能被服务端拒」。
 */
export function resolvePeerTeams({ board, myTeams = [], myTeamsKnown = true } = {}) {
  const roster = Array.isArray(board?.teams) ? board.teams : [];
  const mine = (myTeams ?? []).filter((t) => roster.some((r) => r.id === t.id));
  const fromTeams = mine.length ? mine : roster;
  const uncertain = !mine.length;
  const myIds = new Set(mine.map((t) => t.id));
  const toTeams = roster.filter((t) => !myIds.has(t.id));
  return { fromTeams, toTeams, uncertain, roster };
}

// ══════════════════════════════════════════════════════════════════
// 三、纯函数：指标
// ══════════════════════════════════════════════════════════════════

export function reviewPrepStats(board) {
  const progress = board?.progress ?? {};
  const teams = Array.isArray(board?.teams) ? board.teams.length : 0;
  const judgeDims = judgeDimensionsOf(board).length;
  const selfDims = selfDimensionsOf(board).length;
  const submitted = Number(progress.submitted ?? 0);
  const total = Number(progress.total ?? 0);
  return [
    { label: '赛段队伍', value: teams, tone: 'neutral', hint: `${judgeDims} 个评委席维度` },
    { label: '自评维度', value: selfDims, tone: 'neutral', hint: '自评测只在有该维度的赛段开放' },
    { label: '我的已交', value: submitted, tone: 'brand', hint: `应交 ${total} 格` },
    {
      label: '完成度',
      value: total > 0 ? `${Math.round((submitted / total) * 100)}%` : '—',
      tone: total > 0 && submitted >= total ? 'success' : 'warn',
    },
  ];
}

// ══════════════════════════════════════════════════════════════════
// 四、纯函数：区块渲染
// ══════════════════════════════════════════════════════════════════

/** 一行「维度 + 0–100 数字输入」。 */
function scoreField({ id, label, hint = '', value = '', attrs = '' }) {
  return `
      <div class="field">
        <label class="field__label" for="${escapeHtml(id)}">
          ${escapeHtml(label)}${hint ? ` <span class="muted small">${escapeHtml(hint)}</span>` : ''}
        </label>
        <input class="input" type="number" id="${escapeHtml(id)}" ${attrs}
               min="${MIN_SCORE}" max="${MAX_SCORE}" step="1"
               value="${escapeHtml(value)}" placeholder="${MIN_SCORE}–${MAX_SCORE}" />
      </div>`;
}

/** 队伍单选组（发起队 / 回避对象共用）。 */
function teamRadioGroup({ name, options, checkedId = null, attr = '' }) {
  if (!options.length) return '<p class="muted">没有可选项。</p>';
  return `<div class="radio-group">${options.map((o) => `
    <label class="radio">
      <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(o.id)}"${attr}
             ${o.id === checkedId ? 'checked' : ''} />
      <span>${escapeHtml(o.name)}</span>
    </label>`).join('')}</div>`;
}

/**
 * 已申报的回避清单（纯函数）。
 * ⚠️ **P10：读端点已补齐**（`GET /api/stages/:stageId/recusals`）⇒
 *    这里列的是**台账**（不再只是本次会话内刚提交的那一条）。
 *    台账是**追加式**的：同一 (评委, 队伍) 申报过又被撤销 ⇒ 两行都在
 *    ⇒ 用 `currentRecusals` 先折叠成「当前状态」。
 */
export function recusalListHtml({ recusals = [] } = {}) {
  if (!recusals.length) {
    return emptyState({
      title: '还没有申报过回避',
      hint: '没有利益冲突就什么都不用填 —— 回避只在「供应方 / 投资方 / 前雇主」这些情形下才需要申报。',
    });
  }
  return `<ul class="list-divided">${recusals.map((r) => {
    const revoked = r?.status === 'reinstated';
    return `<li class="row row--between">
      <span>${escapeHtml(r.teamName ?? '整个赛段')}<span class="muted small"> · ${escapeHtml(r.reason ?? '')}</span></span>
      ${badge(revoked ? '已撤销' : '已回避', revoked ? 'neutral' : 'warn')}
    </li>`;
  }).join('')}</ul>`;
}

/**
 * 把追加式台账折叠成「当前状态」（纯函数）。
 * ⚠️ 台账里同一 (评委, 队伍) 可能有多行（申报 → 又撤销 → 再申报），
 *    **最后一行**才是当前状态 ⇒ 按 (judgeId, teamId) 取最后一条。
 *    保持台账原序（按申报时间升序）⇒ 折叠后仍是时间序。
 *
 * @param {Array<object>} items GET /api/stages/:stageId/recusals 的 items
 * @returns {Array<object>}
 */
export function currentRecusals(items) {
  const list = Array.isArray(items) ? items : [];
  const last = new Map();
  for (const r of list) {
    const key = `${r?.judgeId ?? ''}::${r?.teamId ?? ''}`;
    last.set(key, r);
  }
  return [...last.values()];
}

/**
 * 回避申报区（纯函数）。
 * @param {object} o { teams, recusals }
 */
export function recusalSectionHtml({ teams = [], recusals = [] } = {}) {
  const options = [
    { id: STAGE_SCOPE, name: '整个赛段（不评任何队）' },
    ...teams.map((t) => ({ id: t.id, name: t.name })),
  ];
  const list = recusalListHtml({ recusals });
  const body = `
    <div class="field">
      <label class="field__label">回避对象</label>
      ${teamRadioGroup({ name: 'recusal-scope', options, checkedId: STAGE_SCOPE, attr: 'data-recusal-scope' })}
    </div>
    <div class="field field--required">
      <label class="field__label" for="recusal-reason">回避原因</label>
      <textarea class="textarea" id="recusal-reason" data-recusal="reason"
                placeholder="例：我是该队的供应方 / 投资方 / 前雇主"></textarea>
    </div>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-recusal">提交回避申报</button>
    </div>
    <div class="form-feedback" data-feedback="recusal" data-retry-kind="recusal"></div>
    <div data-recusal-list>${list}</div>`;
  return panel({
    title: '回避申报',
    desc: '有利益冲突就先申报回避：申报后你对该队的打分会被剔除，记录留档（赛后 6 个月可查）。',
    body,
  });
}

/**
 * 互评区（纯函数）。
 * @param {object} o { fromTeams, toTeams, uncertain }
 */
export function peerSectionHtml({ fromTeams = [], toTeams = [], uncertain = false } = {}) {
  if (!fromTeams.length) {
    return panel({
      title: '互评',
      desc: '以队对队的方式给其他队伍打分（0–100）。',
      body: emptyState({
        title: '这个赛段还没有可互评的队伍',
        hint: '队伍组建完成后，互评入口会自动出现；互评只对本赛段名册内的队伍开放。',
      }),
    });
  }
  const uncertainNotice = uncertain
    ? noticeState({
      tone: 'warn',
      title: '平台没有读到你参与的队伍',
      items: ['下面的发起队是赛段名册里的全部队伍 —— 只有你是其中某支队伍的成员时提交才会被接受。'],
    })
    : '';
  const targets = toTeams.length
    ? toTeams.map((t) => scoreField({
      id: `peer-${t.id}`,
      label: t.name,
      hint: t.taskPackageTitle ? `任务包：${t.taskPackageTitle}` : '',
      attrs: `data-peer-to="${escapeHtml(t.id)}"`,
    })).join('')
    : emptyState({
      title: '没有可互评的队伍',
      hint: '你参与的所有队伍都在这个赛段里 —— 没有别的队伍可以评。',
    });
  const body = `
    ${uncertainNotice}
    <div class="field">
      <label class="field__label">代表哪支队伍发起</label>
      ${teamRadioGroup({
    name: 'peer-from',
    options: fromTeams.map((t) => ({ id: t.id, name: t.name })),
    checkedId: fromTeams[0]?.id ?? null,
    attr: 'data-peer-from',
  })}
    </div>
    <div class="field">
      <label class="field__label">被评队伍与分值</label>
      ${targets}
    </div>
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-peer">提交互评</button>
    </div>
    <div class="form-feedback" data-feedback="peer" data-retry-kind="peer"></div>`;
  return panel({
    title: '互评',
    desc: '以队对队的方式给其他队伍打分（0–100）。只有本队成员能代表本队提交；不能给自己互评。',
    body,
  });
}

/**
 * 自评区（纯函数）。
 * @param {object} o { fromTeams, dimensions, uncertain }
 */
export function selfSectionHtml({ fromTeams = [], dimensions = [], uncertain = false } = {}) {
  if (!dimensions.length) {
    return panel({
      title: '自评',
      desc: '为本队提交自评测（0–100）。',
      body: emptyState({
        title: '这个赛段没有自评维度',
        hint: '自评测只出现在决赛权重表里 —— 当前赛段的权重表没有这一项，所以这里不需要填写。',
      }),
    });
  }
  if (!fromTeams.length) {
    return panel({
      title: '自评',
      desc: '为本队提交自评测（0–100）。',
      body: emptyState({
        title: '没有找到你参与的队伍',
        hint: '自评只能由本队成员提交 —— 队伍组建完成后这里会出现可提交的队伍。',
      }),
    });
  }
  const uncertainNotice = uncertain
    ? noticeState({
      tone: 'warn',
      title: '平台没有读到你参与的队伍',
      items: ['下面的队伍是赛段名册里的全部队伍 —— 只有你是其中某支队伍的成员时提交才会被接受。'],
    })
    : '';
  const fields = dimensions.map((d) => scoreField({
    id: `self-${d.key}`,
    label: d.name ?? d.key,
    hint: `权重 ${Math.round((d.weight ?? 0) * 100)}%`,
    attrs: `data-self-dimension="${escapeHtml(d.key)}"`,
  })).join('');
  const body = `
    ${uncertainNotice}
    <div class="field">
      <label class="field__label">为哪支队伍自评</label>
      ${teamRadioGroup({
    name: 'self-team',
    options: fromTeams.map((t) => ({ id: t.id, name: t.name })),
    checkedId: fromTeams[0]?.id ?? null,
    attr: 'data-self-team',
  })}
    </div>
    ${fields}
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-self">提交自评</button>
    </div>
    <div class="form-feedback" data-feedback="self" data-retry-kind="self"></div>`;
  return panel({
    title: '自评',
    desc: '为本队提交自评测（0–100）。自评不加分：它只用来触发「书面说明」或「评委提问」。',
    body,
  });
}

/**
 * 校准区（纯函数）。
 * ⚠️ 这一区必须**明确写出「不计入评分」** —— 否则评委会把校准分当成打分，
 *    而校准分的唯一作用是把宽严尺度对齐（R-JDG-12）。
 * @param {object} o { dimensions }
 */
export function calibrationSectionHtml({ dimensions = [] } = {}) {
  if (!dimensions.length) {
    return panel({
      title: '校准',
      desc: '用同一组样例作品对齐宽严尺度。',
      body: emptyState({
        title: '这个赛段没有可校准的维度',
        hint: '校准按评委席维度逐个对齐 —— 当前赛段没有评委席维度，所以不需要校准。',
      }),
    });
  }
  const fields = dimensions.map((d) => scoreField({
    id: `calibration-${d.key}`,
    label: d.name ?? d.key,
    hint: `权重 ${Math.round((d.weight ?? 0) * 100)}%`,
    attrs: `data-calibration-dimension="${escapeHtml(d.key)}"`,
  })).join('');
  const body = `
    <div class="notice notice--info" role="alert">
      <p class="notice__title">校准分不计入评分</p>
      <p class="notice__text">校准分只用来对齐你的宽严尺度，不会进入任何队伍的得分，也不会出现在榜单里。</p>
    </div>
    ${fields}
    <div class="btn-group">
      <button type="button" class="btn btn--primary" data-action="submit-calibration">提交校准分</button>
    </div>
    <div class="form-feedback" data-feedback="calibration" data-retry-kind="calibration"></div>`;
  return panel({
    title: '校准',
    desc: '用同一组样例作品对齐宽严尺度。',
    body,
  });
}

// ══════════════════════════════════════════════════════════════════
// 五、纯函数：整页渲染
// ══════════════════════════════════════════════════════════════════

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, stages, stageId, board, myTeams, myTeamsKnown, recusals }
 */
export function reviewPrepHtml(model) {
  const m = model ?? {};
  const head = pageHead({
    title: m.board?.stage?.name ? `评委前置 · ${m.board.stage.name}` : '评委前置',
    sub: '回避申报 · 互评 · 自评 · 校准 —— 正式打分之前要先走完的前置四件事。',
    actions: m.stageId
      ? [
        { label: '去评审打分', href: `#/review/${m.stageId}` },
        { label: '换个赛段', href: '#/review/prep' },
      ]
      : [],
  });
  if (m.loading) {
    return head + loadingState({ rows: 4, label: '正在加载评审工作台…' });
  }
  if (m.error) {
    return head + `<div data-retry-kind="page">${errorState({
      message: m.error,
      hint: '需要本赛段评委身份，或 score:read 能力。点「重试」重新拉一次。',
    })}</div>`;
  }
  // ⚠️ 没有赛段 ⇒ 给选择器（导航入口 `#/review/prep` 落到这里）
  if (!m.board) {
    const stages = Array.isArray(m.stages) ? m.stages : [];
    const list = stages.length
      ? `<ul class="list-divided">${stages.map((s) => `<li class="row row--between">
          <span>${escapeHtml(s.name)} <span class="muted small">${escapeHtml(s.key ?? '')}</span></span>
          <a class="btn btn--ghost btn--sm" href="#/review/prep/${escapeHtml(s.id)}">进入</a>
        </li>`).join('')}</ul>`
      : emptyState({
        title: '还没有赛段',
        hint: '组委会创建赛段后，这里会出现可以申报回避、互评、自评与校准的赛段。',
      });
    return head + panel({
      title: '赛段',
      desc: '评委前置的四个动作都发生在某一个赛段里 —— 先选一个赛段。',
      body: list,
    });
  }

  const board = m.board;
  const teams = Array.isArray(board.teams) ? board.teams : [];
  const judgeDims = judgeDimensionsOf(board);
  const selfDims = selfDimensionsOf(board);
  const { fromTeams, toTeams, uncertain } = resolvePeerTeams({
    board,
    myTeams: m.myTeams,
    myTeamsKnown: m.myTeamsKnown !== false,
  });

  return head
    + statRow(reviewPrepStats(board))
    + recusalSectionHtml({ teams, recusals: m.recusals ?? [] })
    + peerSectionHtml({ fromTeams, toTeams, uncertain })
    + selfSectionHtml({ fromTeams, dimensions: selfDims, uncertain })
    + calibrationSectionHtml({ dimensions: judgeDims });
}

/**
 * 提交反馈（纯函数）。
 * ⚠️ 成功走 noticeState，失败走 errorState —— 而 errorState **自带一个真能点的重试按钮**
 *    （`data-action="retry"`，DP-80）：不许出现「点了没反应」的死路。
 */
export function submitFeedbackHtml({ ok = false, title = '', items = [], message = '', hint = '' } = {}) {
  if (ok) return noticeState({ tone: 'success', title, items });
  return errorState({ message: message || '提交失败', hint });
}

// ══════════════════════════════════════════════════════════════════
// 六、挂载（DOM 接线）
// ══════════════════════════════════════════════════════════════════

/** 幂等键：每次提交生成一个（换内容再提交必须换键，否则服务端会 409）。 */
function newRequestId() {
  const g = globalThis.crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 评委前置页。
 *
 * ⚠️ **提交一律「本地校验 → 发请求 → 就地反馈」**（DP-80 / DP-81）：
 *    不整页刷新（冲掉已填内容 = 生产级事故），成功与失败都写在对应区块的反馈位上，
 *    失败时带一个**真能点的重试**（重试会重新读当前输入框的值）。
 */
export async function renderReviewPrep(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'review-prep-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';

  /** 页面状态（只放视图自己需要的；⛔ 不引入前端状态机）。 */
  const state = {
    stageId,
    board: null,
    myTeams: [],
    myTeamsKnown: false,
    recusals: [],
  };

  /** 读某个赛段的全部前置数据并整页重绘。 */
  const load = async () => {
    if (!state.stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = reviewPrepHtml({
        stages: Array.isArray(stages) ? stages : (stages?.items ?? []),
      });
      return;
    }
    wrap.innerHTML = reviewPrepHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/review-board`);
      state.board = board;
      // ⚠️ 我参与的队伍来自 `GET /api/teams`；读不到不是致命错误 ——
      //    页面退回「名册里的队伍」，并把「可能是别支队伍」说清楚（服务端会裁决）。
      const mine = await ctx.api.get('/api/teams').catch(() => null);
      const items = Array.isArray(mine) ? mine : (mine?.items ?? []);
      state.myTeams = Array.isArray(items) ? items : [];
      state.myTeamsKnown = Array.isArray(items);
      // ⚠️ P10：回避台账有读端点了 ⇒ 「已回避清单」显示的是**台账**，不是本次会话。
      //    读不到不是致命错误（清单为空即可，申报本身仍可用）。
      const ledger = await ctx.api.get(`/api/stages/${encodeURIComponent(state.stageId)}/recusals`)
        .catch(() => null);
      const rows = Array.isArray(ledger) ? ledger : (ledger?.items ?? []);
      state.recusals = currentRecusals(rows);
      wrap.innerHTML = reviewPrepHtml({
        stageId: state.stageId,
        board,
        myTeams: state.myTeams,
        myTeamsKnown: state.myTeamsKnown,
        recusals: state.recusals,
      });
    } catch (e) {
      wrap.innerHTML = reviewPrepHtml({ stageId: state.stageId, error: e.message });
    }
  };

  /** 反馈位（就地写，不整页刷新）。 */
  const feedback = (kind) => wrap.querySelector(`[data-feedback="${kind}"]`);

  /** 读某个单选组选中的值。 */
  const picked = (name) => {
    const el = wrap.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  };

  /** 收集一组输入框的值。 */
  const collect = (selector, keyOf) => {
    const values = {};
    for (const el of wrap.querySelectorAll(selector)) values[keyOf(el)] = el.value;
    return values;
  };

  /** 四个区块的提交：本地校验 → 发请求 → 就地反馈。 */
  const submit = async (kind) => {
    const slot = feedback(kind);
    if (!slot) return;
    const stage = encodeURIComponent(state.stageId);
    let url = '';
    let body = null;
    let errors = [];
    let payload = null;

    if (kind === 'recusal') {
      const teamId = picked('recusal-scope');
      const reason = wrap.querySelector('[data-recusal="reason"]')?.value ?? '';
      const teams = Array.isArray(state.board?.teams) ? state.board.teams : [];
      const built = buildRecusalRequest({ teamId, reason, teams });
      errors = built.errors;
      payload = built.payload;
      url = `/api/stages/${stage}/recusals`;
      body = payload;
    } else if (kind === 'peer') {
      const fromTeamId = picked('peer-from');
      const { toTeams } = resolvePeerTeams({
        board: state.board,
        myTeams: state.myTeams,
        myTeamsKnown: state.myTeamsKnown,
      });
      const values = collect('input[data-peer-to]', (el) => `${fromTeamId}::${el.dataset.peerTo}`);
      const built = buildPeerReviewItems(values, { fromTeamId, toTeams });
      errors = built.errors;
      payload = built;
      url = `/api/stages/${stage}/peer-reviews`;
      body = { items: built.items, requestId: newRequestId() };
    } else if (kind === 'self') {
      const teamId = picked('self-team');
      const dimensions = selfDimensionsOf(state.board);
      const values = collect('input[data-self-dimension]', (el) => el.dataset.selfDimension);
      const built = buildSelfReviewItems(values, dimensions);
      errors = built.errors;
      payload = built;
      if (!teamId) errors = [{ field: 'teamId', message: '还没选要自评的队伍' }, ...errors];
      url = `/api/stages/${stage}/self-review`;
      body = { teamId, items: built.items, requestId: newRequestId() };
    } else if (kind === 'calibration') {
      const dimensions = judgeDimensionsOf(state.board);
      const values = collect('input[data-calibration-dimension]', (el) => el.dataset.calibrationDimension);
      const built = buildCalibrationItems(values, dimensions);
      errors = built.errors;
      payload = built;
      url = `/api/stages/${stage}/calibration`;
      body = { items: built.items };
    }

    if (errors.length) {
      slot.innerHTML = submitFeedbackHtml({
        ok: false,
        message: `还有 ${errors.length} 处没填好`,
        hint: errors.map((x) => x.message).join('；'),
      });
      return;
    }

    try {
      const res = await ctx.api.post(url, body);
      if (kind === 'recusal') {
        // ⚠️ P10：回避台账**有读端点**了 ⇒ 提交成功后**重读台账**，
        //    而不是把服务端返回的那一行本地追加（本地追加会把「整段回避」与
        //    「某一队回避」记成两条，也让台账与页面长期不一致）。
        const ledger = await ctx.api.get(`/api/stages/${encodeURIComponent(stage)}/recusals`)
          .catch(() => null);
        const rows = Array.isArray(ledger) ? ledger : (ledger?.items ?? []);
        state.recusals = rows.length ? currentRecusals(rows) : state.recusals;
        const list = wrap.querySelector('[data-recusal-list]');
        if (list) list.innerHTML = recusalListHtml({ recusals: state.recusals });
      }
      slot.innerHTML = submitFeedbackHtml({
        ok: true,
        title: '已提交',
        items: [
          kind === 'recusal'
            ? '回避已留档 —— 你对该队的打分会被剔除。'
            : kind === 'peer'
              ? `互评 ${payload.items.length} 条已记入（同一支队伍再评一次会覆盖）。`
              : kind === 'self'
                ? `自评 ${payload.items.length} 项已记入（自评不加分，只触发解释与提问）。`
                : `校准分 ${payload.items.length} 项已记入（不计入评分）。`,
        ],
      });
    } catch (e) {
      slot.innerHTML = submitFeedbackHtml({
        ok: false,
        message: e.message,
        hint: '点「重试」会按当前填写的内容重新提交一次。',
      });
    }
  };

  await load();

  // ⚠️ **事件绑定在 wrap 上（委托）**：反馈位被整体重写也不会丢重试逻辑。
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      const host = btn.closest('[data-retry-kind]');
      const kind = host?.dataset?.retryKind;
      if (!kind) return;
      if (kind === 'page') { load(); return; }
      submit(kind);
      return;
    }
    if (action === 'submit-recusal') submit('recusal');
    else if (action === 'submit-peer') submit('peer');
    else if (action === 'submit-self') submit('self');
    else if (action === 'submit-calibration') submit('calibration');
  });

  return wrap;
}
```

### 签字台仓储层（新 SQL）

`platform/src/db/repo/signoff-board.js` —— 签字台仓储层（新 SQL）

```javascript
// src/db/repo/signoff-board.js — 企业签字台 / 企业双签清单的读端点 SQL
//
// ⚠️ **为什么这个文件存在（P10 · W4-b）**：
//   P9 真机取证发现 31 个「只有接口没有界面」的功能点。企业签字这条线上：
//     · 里程碑签字 `POST /api/milestones/:id/signoff` —— **有写端点，无读端点**；
//     · 撤回签字 `POST /api/milestones/:id/signoff/withdraw` —— **有写端点，无读端点**；
//     · 企业双签 `POST /api/stages/:stageId/enterprise-confirmations` —— **有写端点，
//       「谁来签第二签（跨领域评委）」这一关键信息没有任何读出口**。
//   而前端要调这两个写端点，**必须**先拿到两个 id：
//     · `milestoneId`（写端点的路径参数）；
//     · `signoffId`（撤回请求体的字段）。
//   现有的读端点一个都不给：
//     · `GET /api/teams/:id/performance-card` → items 只有 key/label/achieved/signed（**无 id**）；
//     · `GET /api/teams/:id` → milestones 来自 `teams.milestones_json`（**只有 key/label/countsTowardTier**）；
//     · `GET /api/stages/:stageId/review-board` → 只有 stage/dimensions/teams/myScores/progress（**无评委名单**）。
//   ⇒ 「只有接口没有界面」不是「少一个按钮」，是**连点都点不出来**。
//   ⇒ 这里补**读口**：可见性过滤全部落在 SQL 的 WHERE 里（不是查全量再在 JS 里 filter ——
//     见 src/auth/permissions.js 顶部的「权限过滤必须在 SQL 的 WHERE 里」约束）。
//
// ⛔ **SQL 只放这一层**（全局约束「所有 SQL 字符串必须收在 platform/src/db/repo/ 下」，
//    机器闸：platform/test/sql-boundary.test.js）。
//
// ⚠️ **确定性排序是全局约束**：所有 ORDER BY 都必须带兜底键。
//   本文件的 id 全部是 `crypto.randomUUID()`（**随机 UUID**）⇒ 拿 id 排序 = 每次刷新顺序都可能变
//   （与 src/db/repo/teams.js 里那条注释同一个教训）。
//   ⇒ 兜底键统一用 SQLite 的隐式 `rowid`（插入顺序，单调递增）。

/**
 * 企业出题的队伍（含届期）—— 用来判「这个企业席能签哪些队的里程碑」。
 *
 * ⚠️ 口径与 `listSignoffWorklist` 里的 `tp.enterprise_id = ?` **必须一致**：
 *    两个口径一旦分叉，服务端就会返回「我能签的队」与「实际列出来的队」不是同一批
 *    （最典型的「榜单里凭空少一支队」类 bug）。
 *
 * @param {string} enterpriseId 出题企业的 user id
 * @returns {Array<{teamId:string, editionId:string, teamName:string}>}
 */
export function listEnterprisesTeams(db, enterpriseId) {
  return db
    .prepare(
      `SELECT t.id AS team_id, t.edition_id, t.name AS team_name
         FROM teams t
         JOIN task_packages tp ON tp.id = t.task_package_id
        WHERE tp.enterprise_id = ? AND t.deleted_at IS NULL
        ORDER BY t.created_at, t.rowid`,
    )
    .all(enterpriseId)
    .map((r) => ({ teamId: r.team_id, editionId: r.edition_id, teamName: r.team_name }));
}

/**
 * 里程碑签字台清单（⛔ 可见性在 SQL 里过滤）。
 *
 * ⚠️ **「有效签字」的口径**：一个里程碑可能被签过多次（签 → 撤回 → 再签），
 *   所以「当前有效的那一条」必须**按规则挑**，不能随便取一条：
 *     ① 还有没被撤回的（revoked_at IS NULL）⇒ 取其中**最新**的；
 *     ② 全被撤回了 ⇒ 取**最近**被撤回的那一条（前端据此显示「已撤回」）。
 *   实现：CTE 里用 `ROW_NUMBER() OVER (PARTITION BY s.milestone_id
 *                      ORDER BY (s.revoked_at IS NULL) DESC, s.signed_at DESC, s.rowid DESC)`
 *   —— 未撤回的排前面，组内按签字时间倒序，最后用 rowid 兜底（确定性）。
 *
 * ⚠️ **签字人不公开**（R-ENT-04「签字不公开」）：
 *   这里**只回传签字内容（department / content）**，不回传签字人姓名。
 *   「是不是我签的」用布尔位 `signoff_enterprise_id === viewer.id` 在服务层判断。
 *
 * @param {object} o
 * @param {string} o.enterpriseId       当前用户 id
 * @param {string[]|null} o.editionIds  届期白名单（null = 不按届期过滤）
 * @param {boolean} o.includeAllTeams   true = 组委会视角（不过滤「谁出的题」）
 * @param {boolean} o.includeAllSignoffs true = 组委会视角（看**任何人**的签字）
 * @param {boolean} o.requireStageEdition true = 只看「有赛段」的届期（组委会视角）
 */
export function listSignoffWorklist(db, {
  enterpriseId,
  editionIds = null,
  includeAllTeams = false,
  includeAllSignoffs = false,
  requireStageEdition = false,
}) {
  const ids = (Array.isArray(editionIds) ? editionIds : []).filter(Boolean);
  const editionSql = ids.length
    ? `AND t.edition_id IN (${ids.map(() => '?').join(',')})`
    : '';
  const rows = db
    .prepare(
      `WITH eff AS (
         SELECT s.id, s.milestone_id, s.enterprise_id, s.department, s.content, s.signed_at, s.revoked_at,
                ROW_NUMBER() OVER (
                  PARTITION BY s.milestone_id
                  ORDER BY (s.revoked_at IS NULL) DESC, s.signed_at DESC, s.rowid DESC
                ) AS rn
           FROM milestone_signoffs s
          WHERE (? = 1 OR s.enterprise_id = ?)
       )
       SELECT m.id AS milestone_id,
              m.team_id,
              m.key,
              m.label,
              m.counts_toward_tier,
              t.name AS team_name,
              t.edition_id,
              e.id AS signoff_id,
              e.enterprise_id AS signoff_enterprise_id,
              e.department,
              e.content,
              e.signed_at,
              e.revoked_at
         FROM milestones m
         JOIN teams t ON t.id = m.team_id
         LEFT JOIN task_packages tp ON tp.id = t.task_package_id
         LEFT JOIN eff e ON e.milestone_id = m.id AND e.rn = 1
        WHERE t.deleted_at IS NULL
          AND (? = 1 OR tp.enterprise_id = ?)
          AND (? = 0 OR EXISTS (SELECT 1 FROM stages st WHERE st.edition_id = t.edition_id))
          ${editionSql}
        ORDER BY t.created_at, t.rowid, m.fixed_at, m.key, m.rowid`,
    )
    .all(
      includeAllSignoffs ? 1 : 0,
      enterpriseId,
      includeAllTeams ? 1 : 0,
      enterpriseId,
      requireStageEdition ? 1 : 0,
      ...ids,
    );
  return rows.map((r) => ({
    milestoneId: r.milestone_id,
    teamId: r.team_id,
    teamName: r.team_name,
    editionId: r.edition_id,
    key: r.key,
    label: r.label,
    countsTowardTier: r.counts_toward_tier === 1,
    signoffId: r.signoff_id ?? null,
    signoffEnterpriseId: r.signoff_enterprise_id ?? null,
    department: r.department ?? null,
    content: r.content ?? null,
    signedAt: r.signed_at ?? null,
    revokedAt: r.revoked_at ?? null,
  }));
}

/**
 * 某赛段的企业确认记录（⛔ 可见性在 SQL 里过滤）。
 *
 * ⚠️ **为什么不用 `listEnterpriseConfirmations`**（src/db/repo/enterprise-confirmations.js）：
 *   那个函数按 stage_id 取**全部**企业的确认记录。企业席用它 ⇒ 会看到别家企业的签字
 *   （R-ENT-04「签字不公开」+ R-JDG-06 的 R1「非本赛道签字把该队企业项权重归零」——
 *    看到「别家企业给我们的队签了」对出题企业没有任何可操作性，只会制造混乱）。
 *   ⇒ 这里多一个 enterpriseId 参数，把过滤放进 WHERE。
 *
 * ⚠️ **排序兜底**：ORDER BY created_at, rowid（created_at 常相等 ⇒ rowid 兜底）。
 */
export function listEnterpriseConfirmationRows(db, { stageId, enterpriseId = null }) {
  const base = `SELECT id, stage_id, team_id, enterprise_id, dimension, raw_score,
                       cross_judge_id, signatory_user_id, content, created_at
                  FROM enterprise_confirmations
                 WHERE stage_id = ? AND deleted_at IS NULL`;
  if (enterpriseId) {
    return db
      .prepare(`${base} AND enterprise_id = ? ORDER BY created_at, rowid`)
      .all(stageId, enterpriseId);
  }
  return db.prepare(`${base} ORDER BY created_at, rowid`).all(stageId);
}

/**
 * 某赛段的**跨领域评委候选**（⛔ 排除当前用户自己）。
 *
 * ⚠️ **为什么必须排除「我自己」**：
 *   后端 `POST /api/stages/:stageId/enterprise-confirmations` 明确拒绝
 *   `crossJudgeId === enterpriseId`（400 CROSS_JUDGE_SAME_AS_SIGNATORY，
 *   见 src/http/routes/review.js）。⇒ 前端如果把「我」放进候选里，
 *   用户选了就是一次必失败的请求（真实用户会以为是页面坏了）。
 *   ⇒ 排除在**服务端**做（前端不做可见性判断）。
 *
 * ⚠️ **口径与写端点一致**：写端点只要求 `getStageJudge(stageId, crossJudgeId)` 存在
 *   （**不校验席别**）⇒ 候选表也**不按席别过滤**，否则会出现
 *   「候选表是空的、但后端其实接受」这种前后端口径不一致。
 *   席别（seat）照实回传给前端，由前端**展示**（不拿它做授权判断）。
 *
 * ⚠️ `users.active = 1`：停用的用户不该再当签字人（与 src/db/repo/users.js 的
 *   getUserById 口径一致 —— 那个函数也过滤 active）。
 *
 * ⚠️ 排序：ORDER BY u.name, sj.rowid（name 可能重复 ⇒ rowid 兜底；id 是随机 UUID 不能用来排序）。
 */
export function listStageJudgeCandidates(db, { stageId, excludeUserId = null }) {
  const params = [stageId];
  let excludeSql = '';
  if (excludeUserId) {
    excludeSql = 'AND sj.user_id <> ?';
    params.push(excludeUserId);
  }
  return db
    .prepare(
      `SELECT sj.user_id AS user_id, u.name AS name, sj.seat AS seat
         FROM stage_judges sj
         JOIN users u ON u.id = sj.user_id AND u.active = 1
        WHERE sj.stage_id = ? ${excludeSql}
        ORDER BY u.name, sj.rowid`,
    )
    .all(...params)
    .map((r) => ({ userId: r.user_id, name: r.name, seat: r.seat }));
}

// ⚠️ **登记在案的后端缺口（本任务不改，写在这里免得下一个人再查一遍）**：
//   「企业确认」**没有撤回 / 改签路径** —— 仓储层有 softDeleteEnterpriseConfirmation，
//   但全仓扫描**没有任何调用方**（没有对外端点）；而唯一索引
//   `idx_enterprise_confirmations_cell (stage_id, team_id, dimension, enterprise_id)
//    WHERE deleted_at IS NULL` 又让「同格重复签」直接撞库。
//   ⇒ 一条**缺双签**的企业确认（cross_judge_id 为 NULL）落库后，
//     按 R2（src/domain/enterprise-seat.js）**该项按 0 分计**，且无法从产品内修复。
//   ⇒ 本任务的界面**如实显示**这个状态并指出需要组委会处理（不假装有办法修）。
//   ⇒ 真正的前端流程是「一次提交就带齐双签」（本界面强制选跨领域评委），
//     从源头避免产生「半条确认」。
```

### 签字台服务层（可见性 + 组装）

`platform/src/services/signoff-board.js` —— 签字台服务层（可见性 + 组装）

```javascript
// src/services/signoff-board.js — 企业签字台 / 企业双签清单（读端点的业务组装）
//
// ⚠️ **为什么要有这一层（P10 · W4-b）**：
//   「可见性在 API 层过滤，前端只负责呈现」（全局约束 / 设计文档 §6.6）。
//   「API 层」= HTTP 路由 + 服务层；**不是**前端。
//   ⇒ 本模块负责两件事：
//     ① 判定「这个人是谁、能看到什么」（can() 是全项目唯一的授权入口）；
//     ② 把仓储层的行整形成前端要的形状（并且**不把不该给的东西给出去**）。
//
// ⛔ **本模块不改任何既有文件**：只读 src/db/repo/*（现有函数）与 src/db/repo/signoff-board.js（新文件）。
//
// ⚠️ **三态状态码**（设计文档 §7.3，全局约束）：
//   列表 200 + 空集 ｜ 单条 404 ｜ 禁用 403。
//   ⇒ 「列表」永远返回 200 + items（哪怕空）；「单条」（赛段不存在）返回 404；
//     「禁用」（没有能力点）返回 403。
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getStage, listStageTeamRows } from '../db/repo/stages.js';
import {
  listEnterprisesTeams,
  listSignoffWorklist,
  listEnterpriseConfirmationRows,
  listStageJudgeCandidates,
} from '../db/repo/signoff-board.js';

/**
 * 里程碑签字台（"我要签的东西"）。
 *
 * ⚠️ **口径（写在前面，免得下一个人以为这是 bug）**：
 *   ① **企业席**：只看**自己出题**的队伍的里程碑（`task_packages.enterprise_id = 我`）。
 *      理由：里程碑签字是「客观事实确认」（R-PTS-02 / R-ENT-02），
 *      由出题企业确认「这件事到底发生了没有」⇒ 别的企业没资格替它确认。
 *   ② **组委会**：看全部（`stage:compute`）—— 组委会要能核查「哪支队还没人签」，
 *      且仓储层 `milestone_signoffs.enterprise_id` 记的是签字的企业席账号
 *      （src/services/milestone.js 的 insertSignoff）⇒ 组委会视角的「有效签字」
 *      取**任何人**的最新一条有效签字。
 *   ③ **权限判定跟写端点同口径**：
 *      写端点 `createSignoff` 判的是
 *      `can(actor, 'signoff:create', { scopeType: 'edition', scopeId: team.edition_id })`
 *      （src/services/milestone.js）⇒ 读端点也**按 edition 作用域**判，
 *      否则会出现「接口放行、列表 403」或反过来。
 *
 * @returns {{scope:'enterprise'|'committee', items:Array<object>}}
 */
export function getSignoffWorklist({ db, viewer }) {
  if (!viewer) throw new AppError(401, 'UNAUTHENTICATED', '未登录');

  // 组委会（stage:compute）⇒ 全量视角。
  // ⚠️ 超管在 can() 里直接返回 true（src/auth/permissions.js），所以超管自动进这一支。
  const committee = can(viewer, 'stage:compute', { scopeType: 'global' }, db);
  if (committee) {
    const rows = listSignoffWorklist(db, {
      enterpriseId: viewer.id,
      includeAllTeams: true,
      includeAllSignoffs: true,
      requireStageEdition: true,
    });
    return { scope: 'committee', items: rows.map((r) => shapeWorklistItem(r, viewer)) };
  }

  // 企业席：只看自己出题的队。
  const teams = listEnterprisesTeams(db, viewer.id);
  // 全局授权（角色授权在 can() 里对任何 scope 都成立）⇒ 不按届期再过滤一次。
  const globalSignoff = can(viewer, 'signoff:create', { scopeType: 'global' }, db);
  const editions = [...new Set(teams.map((t) => t.editionId).filter(Boolean))];
  const allowedEditions = editions.filter((editionId) =>
    can(viewer, 'signoff:create', { scopeType: 'edition', scopeId: editionId }, db));
  if (!globalSignoff && allowedEditions.length === 0) {
    throw new AppError(403, 'FORBIDDEN', '缺少能力：signoff:create');
  }
  const rows = listSignoffWorklist(db, {
    enterpriseId: viewer.id,
    editionIds: globalSignoff ? null : allowedEditions,
    includeAllTeams: false,
    includeAllSignoffs: false,
    requireStageEdition: false,
  });
  return { scope: 'enterprise', items: rows.map((r) => shapeWorklistItem(r, viewer)) };
}

/**
 * 把仓储层的行整形成前端要的形状（⛔ 字段恒定，不出现 undefined）。
 *
 * ⚠️ **不返回签字人姓名**（R-ENT-04「签字不公开」）：
 *   只回传签字内容（department / content）+ 「是不是我签的」布尔位。
 */
function shapeWorklistItem(row, viewer) {
  const signed = Boolean(row.signoffId) && !row.revokedAt;
  const signedByMe = row.signoffEnterpriseId != null && row.signoffEnterpriseId === viewer.id;
  const isSuper = viewer.is_superadmin === 1 || viewer.isSuperadmin === true;
  return {
    milestoneId: row.milestoneId,
    teamId: row.teamId,
    teamName: row.teamName ?? '',
    key: row.key ?? '',
    label: row.label ?? '',
    countsTowardTier: row.countsTowardTier === true,
    signed,
    signoffId: row.signoffId ?? null,
    signedAt: row.signedAt ?? null,
    department: row.department ?? null,
    content: row.content ?? null,
    revokedAt: row.revokedAt ?? null,
    signedByMe,
    // ⛔ 撤回闸门跟写端点一致（src/services/milestone.js withdrawSignoff）：
    //    非超管只能撤回**本企业自己**的签字 ⇒ 能不能撤由服务端说了算。
    canWithdraw: signed && (signedByMe || isSuper),
  };
}

/**
 * 企业双签待签清单（某赛段）。
 *
 * ⚠️ **权限闸门与写端点 `POST /api/stages/:stageId/enterprise-confirmations` 完全同口径**
 *    （src/http/routes/review.js）：
 *      ① `signoff:create`（赛段级或全局）**或** 组委会（`stage:compute`）；
 *      ② **且** `score:write`（赛段级或全局）—— 写端点里 `requireStageCapability(ctx,'score:write')`
 *         是**无条件**执行的（连组委会也要），所以读端点也必须一样。
 *    ⇒ 前端拿到的清单里出现的队，**一定能提交**（不会出现「看得到、提交就 403」）。
 *
 * @returns {{stage:object, scope:string, myEnterpriseId:string, dimensions:Array<object>,
 *            teams:Array<object>, confirmations:Array<object>, crossJudgeCandidates:Array<object>}}
 */
export function getEnterpriseConfirmationBoard({ db, stageId, viewer, rules = null }) {
  if (!viewer) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
  const stage = getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');

  const committee = can(viewer, 'stage:compute', { scopeType: 'stage', scopeId: stageId }, db)
    || can(viewer, 'stage:compute', { scopeType: 'global' }, db);
  const seat = can(viewer, 'signoff:create', { scopeType: 'stage', scopeId: stageId }, db)
    || can(viewer, 'signoff:create', { scopeType: 'global' }, db);
  if (!seat && !committee) {
    throw new AppError(403, 'FORBIDDEN', '只有出题企业（或组委会）可以查看企业确认待签清单');
  }
  const canScore = can(viewer, 'score:write', { scopeType: 'stage', scopeId: stageId }, db)
    || can(viewer, 'score:write', { scopeType: 'global' }, db);
  if (!canScore) {
    throw new AppError(403, 'FORBIDDEN', '缺少能力：score:write');
  }

  // 名册（与写端点 listStageTeams 同源：同一届期、同一软删除口径）。
  const roster = listStageTeamRows(db, stageId);
  // ⛔ **可见性在服务端过滤**：
  //    企业席只看**自己出题**的队（写端点也只允许为自己出题的队签 —— 见 review.js 的归属判定）；
  //    组委会看全部。
  const visibleTeams = committee ? roster : roster.filter((t) => t.enterpriseId === viewer.id);

  // 企业确认记录（⛔ 过滤也在 SQL 里 —— 见 repo 的 listEnterpriseConfirmationRows）。
  const rows = listEnterpriseConfirmationRows(db, {
    stageId,
    enterpriseId: committee ? null : viewer.id,
  });

  // 跨领域评委候选（⛔ 排除「我」—— 后端会拒绝 crossJudgeId === 出题企业签字人）。
  const candidates = listStageJudgeCandidates(db, { stageId, excludeUserId: viewer.id });

  // 企业确认维度：⛔ **从规则表来，不写死 'enterprise'**（赛制口径不许硬编码）。
  const dims = (rules?.scoring?.[stage.scoring_config_key]?.dimensions ?? [])
    .filter((d) => d.seat === 'enterprise')
    .map((d) => ({ key: d.key, name: d.name, weight: d.weight, seat: d.seat }));

  return {
    stage: {
      id: stage.id,
      key: stage.key,
      name: stage.name,
      kind: stage.kind,
      status: stage.status,
    },
    scope: committee ? 'committee' : 'enterprise',
    myEnterpriseId: viewer.id,
    dimensions: dims,
    teams: visibleTeams.map((t) => ({
      teamId: t.id,
      teamName: t.name ?? '',
      taskPackageTitle: t.taskPackageTitle ?? null,
      enterpriseId: t.enterpriseId ?? null,
      isFreeBrief: t.isFreeBrief === true,
      // 组委会可以代录（写端点允许 committee 代替企业签）；企业席只对自己出题的队有权限。
      canSign: true,
    })),
    confirmations: rows.map((c) => ({
      id: c.id,
      teamId: c.team_id,
      enterpriseId: c.enterprise_id,
      dimension: c.dimension,
      rawScore: c.raw_score,
      hasCrossJudge: Boolean(c.cross_judge_id),
      signedAt: c.created_at,
      content: c.content ?? '',
    })),
    crossJudgeCandidates: candidates,
  };
}
```

### 签字台读端点路由

`platform/src/http/routes/signoff.js` —— 签字台读端点路由

```javascript
// src/http/routes/signoff.js — 企业签字台（读端点）
//
// 依据：P10 · W4-b「企业双签界面 + 里程碑签字界面（含撤回）」
//   + db/migrations/003_review.sql 的 enterprise_confirmations 表注释
//   + src/services/milestone.js（里程碑签字 = 客观事实、单签、不进总分）
//   + src/http/routes/review.js（企业确认 = 主观评分、双签、进总分）
//
// ⚠️ **只新增读端点**：写端点（里程碑签字 / 撤回签字 / 企业确认）**早就存在**，
//   本文件**一个字都不改**它们 —— 缺的是「界面」与「读口」，不是「写口」。
//
// ⚠️ **为什么必须补读口**（P9 真机取证：31 个「只有接口没有界面」）：
//   前端要调 `POST /api/milestones/:id/signoff` 就必须先知道 **milestoneId**，
//   要调 `POST /api/milestones/:id/signoff/withdraw` 就必须先知道 **signoffId**，
//   要凑齐 R2 双签就必须知道**本赛段有哪些别的评委**（crossJudgeId）。
//   而现有的读端点一个都不给这三个值（详见 src/db/repo/signoff-board.js 的文件头）。
//
// ⚠️ **GET 与 POST 同路径不冲突**：路由表按 **method + path** 匹配
//   （src/http/router.js 的 match() 里 `route.method !== m` 直接跳过），
//   所以 `GET /api/stages/:stageId/enterprise-confirmations` 与
//   `POST /api/stages/:stageId/enterprise-confirmations` 可以并存。
//
// ⚠️ **三态状态码**（设计文档 §7.3）：
//   列表 200 + 空集 ｜ 单条 404（赛段不存在）｜ 禁用 403（没有能力点）。
import { AppError } from '../../errors.js';
import {
  getSignoffWorklist,
  getEnterpriseConfirmationBoard,
} from '../../services/signoff-board.js';

/**
 * 注册企业签字台的读端点。
 * @param {object} router createRouter() 的返回值
 */
export function registerSignoffRoutes(router) {
  // ── 我要签的里程碑（企业席签字台）────────────────────────────────
  router.add('GET', '/api/signoffs/mine', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return getSignoffWorklist({ db: ctx.db, viewer: ctx.user });
  });

  // ── 某赛段的企业双签待签清单 ────────────────────────────────────
  router.add('GET', '/api/stages/:stageId/enterprise-confirmations', async (ctx) => {
    if (!ctx.user) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
    return getEnterpriseConfirmationBoard({
      db: ctx.db,
      stageId: ctx.params.stageId,
      viewer: ctx.user,
      rules: ctx.rules,
    });
  });
}
```

### 签字台界面与端点测试

`platform/test/web-signoff.test.js`：签字台界面与端点测试

```javascript
// platform/test/web-signoff.test.js —— 企业签字台（里程碑签字 + 企业双签）的行为闸
//
// 规则溯源：
//   - 「企业确认 = 双签（出题企业签字 + ≥1 名跨领域评委签字），缺双签按 0 分计」
//     → R-JDG-06（R2）/ S7 §2.4 / src/domain/enterprise-seat.js applyEnterpriseRules
//   - 「企业确认的第二个签字人不能与出题企业签字人相同」
//     → src/http/routes/review.js 的 CROSS_JUDGE_SAME_AS_SIGNATORY（400）
//   - 「签字必须写清解决哪个环节 / 落地时间 / 我方角色」→ R-JDG-14
//   - 「签字不公开」→ R-ENT-04（API 与界面都不回传签字人姓名）
//   - 「撤回是软删除，撤回后回到未达成」→ src/services/milestone.js withdrawSignoff
//   - 「错误态必须带真能点的重试」→ DP-80；「不许整页刷新 / 不许冲掉已填内容」→ DP-81
//   - 「可见性在 API 层过滤，前端只判登录态」→ DP-77 / 全局约束
//   - 「noticeState 的参数叫 items，不叫 text」→ web/ui.js + 机器闸
//
// ⚠️ **全部是行为断言**：断言的是**纯函数的返回值**与**真实发出去的请求**
//   （路径 + 请求体），不是「源码里有没有某个字符串」——
//   字符串断言会被无关代码顶替（前面轮次吃过这个亏）。
//
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

import {
  signoffWorklistItems,
  signoffFormState,
  buildWithdrawPayload,
  enterpriseConfirmRows,
  crossJudgeCandidates,
  enterpriseConfirmFormState,
  enterpriseConfirmPayload,
  signoffWorklistHtml,
  enterpriseConfirmHtml,
  signoffPageHtml,
  renderSignoff,
  seatLabel,
} from '../web/views/signoff.js';

// ── 后端（两个新读端点）的真实装配：跑 app.handle → 路由 → 鉴权 ──────────
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { registerSignoffRoutes } from '../src/http/routes/signoff.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertMilestones } from '../src/db/repo/tiers.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { callJson } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW_JS = readFileSync(join(here, '..', 'web', 'views', 'signoff.js'), 'utf8');

// ══════════════════════════════════════════════════════════════════
// 零、DOM 桩（最小：没有真 DOM、没有 IntersectionObserver）
// ══════════════════════════════════════════════════════════════════

/** 造一个最小元素桩：只实现视图用到的那几个方法。 */
function makeEl(tag = 'div') {
  return {
    tagName: tag,
    className: '',
    innerHTML: '',
    value: '',
    dataset: {},
    hidden: false,
    _listeners: {},
    _nodes: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of this._listeners[type] || []) fn(event);
    },
    querySelector(sel) {
      return this._nodes[sel] ?? null;
    },
    querySelectorAll(sel) {
      const v = this._nodes[sel];
      return Array.isArray(v) ? v : (v ? [v] : []);
    },
    closest() {
      return null;
    },
    focus() {},
  };
}

/** 造一个假按钮（click 事件的目标）。 */
function fakeButton(dataset) {
  const btn = { dataset, closest: () => btn };
  return btn;
}

/** 让微任务/宏任务队列跑干净（视图里的提交是异步的）。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// ── 后端装配 ────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = join(here, '..', 'db', 'migrations');
const RULES_DIR = join(here, '..', 'rules');
const WEB_DIR = join(here, '..', 'web');
const API_NOW = '2026-10-20T12:00:00.000Z';

/**
 * 造一套「两家出题企业 + 两名跨领域评委 + 组委会 + 无权限者」的最小现场。
 *
 * ⚠️ 两家企业的任务包**必须分开**（enterpriseId 不同）：
 *    否则「企业席只看得到自己出题的队」这条可见性判据测不出来
 *    （一家企业出题 ⇒ 两支队都归它 ⇒ 过滤看起来「没生效」其实生效了）。
 */
function setupApi() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-signoff-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, MIGRATIONS_DIR);
  const { rules } = loadRules(RULES_DIR);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: API_NOW,
  });
  const enterprise = createUser(db, { name: '甲企业', phone: '13900000071', password: 'pw' });
  const enterprise2 = createUser(db, { name: '乙企业', phone: '13900000072', password: 'pw' });
  const judge1 = createUser(db, { name: '评委甲', phone: '13900000073', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000074', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000075', password: 'pw' });
  const outsider = createUser(db, { name: '无权限者', phone: '13900000076', password: 'pw' });

  for (const [key, desc] of [
    ['signoff:create', '企业签字'],
    ['score:write', '写入评分'],
    ['stage:compute', '触发计算发榜'],
  ]) insertCapability(db, key, desc);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(enterprise.id, 'signoff:create');
  grant(enterprise.id, 'score:write');
  grant(admin.id, 'signoff:create');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');

  const pkgMine = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '甲企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: API_NOW,
  });
  const pkgOther = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise2.id, enterpriseName: '乙企业',
    title: '门店选址', painPoint: '选址靠拍脑袋',
    expectedDelivery: '选址评分模型', acceptanceCriteria: '能给出选址命中率',
    submittedBy: admin.id, now: API_NOW,
  });
  const teamMine = insertTeam(db, {
    editionId: edition.id, name: '拾光队', captainId: judge1.id,
    taskPackageId: pkgMine.id, status: 'active', now: API_NOW,
  });
  const teamOther = insertTeam(db, {
    editionId: edition.id, name: '长风队', captainId: judge2.id,
    taskPackageId: pkgOther.id, status: 'active', now: API_NOW,
  });
  insertMilestones(db, {
    teamId: teamMine.id,
    items: [
      { key: 'problem_confirmed', label: '企业问题确认', countsTowardTier: true },
      { key: 'demo_ready', label: '可演示原型', countsTowardTier: true },
    ],
    now: API_NOW,
  });
  insertMilestones(db, {
    teamId: teamOther.id,
    items: [{ key: 'problem_confirmed', label: '企业问题确认', countsTowardTier: true }],
    now: API_NOW,
  });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: API_NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge1.id, seat: 'judge', now: API_NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: API_NOW });

  const app = createApp({ db, rules, webDir: WEB_DIR });
  // ⚠️ createApp 还没接本模块的路由（**路由接线由集成者做**）⇒ 这里手动挂上，
  //    免得「测试通过」只是因为「端点没注册」。
  registerSignoffRoutes(app.router);

  return {
    db, close, dataDir, app, rules, edition, stage,
    enterprise, enterprise2, judge1, judge2, admin, outsider,
    teamMine, teamOther,
    milestones: db.prepare('SELECT * FROM milestones WHERE team_id = ? ORDER BY rowid').all(teamMine.id),
    tokenEnterprise: createSession(db, enterprise.id).token,
    tokenEnterprise2: createSession(db, enterprise2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function teardownApi(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════
// 一、里程碑签字台：三态分组与字段恒定
// ══════════════════════════════════════════════════════════════════

const WORKLIST = {
  scope: 'enterprise',
  items: [
    {
      milestoneId: 'm_pending', teamId: 't_a', teamName: '拾光队',
      key: 'problem_confirmed', label: '企业问题确认', countsTowardTier: true,
      signed: false, signoffId: null, signedAt: null, department: null, content: null,
      revokedAt: null, signedByMe: false, canWithdraw: false,
    },
    {
      milestoneId: 'm_signed', teamId: 't_a', teamName: '拾光队',
      key: 'data_connected', label: '真实数据接入', countsTowardTier: true,
      signed: true, signoffId: 's_1', signedAt: '2026-10-20T04:00:00.000Z',
      department: '业务部', content: '已接入门店实时库存',
      revokedAt: null, signedByMe: true, canWithdraw: true,
    },
    {
      milestoneId: 'm_revoked', teamId: 't_b', teamName: '长风队',
      key: 'pilot_contract', label: '试点合同', countsTowardTier: true,
      signed: false, signoffId: 's_2', signedAt: '2026-10-19T04:00:00.000Z',
      department: '业务部', content: '试点合同已签',
      revokedAt: '2026-10-21T04:00:00.000Z', signedByMe: true, canWithdraw: false,
    },
  ],
};

test('★ 分组：待签 / 已签 / 已撤回 三组各归其位', () => {
  const groups = signoffWorklistItems(WORKLIST);
  assert.deepEqual(groups.pending.map((x) => x.milestoneId), ['m_pending']);
  assert.deepEqual(groups.signed.map((x) => x.milestoneId), ['m_signed']);
  assert.deepEqual(groups.revoked.map((x) => x.milestoneId), ['m_revoked']);
  assert.equal(groups.pending.length + groups.signed.length + groups.revoked.length, 3);
});

test('★ 字段恒定：每一项的字段集合一致，且不出现 undefined', () => {
  const groups = signoffWorklistItems(WORKLIST);
  const keys = [
    'milestoneId', 'teamId', 'teamName', 'key', 'label', 'countsTowardTier',
    'signed', 'signoffId', 'signedAt', 'department', 'content', 'revokedAt',
    'signedByMe', 'canWithdraw',
  ];
  for (const group of [groups.pending, groups.signed, groups.revoked]) {
    for (const row of group) {
      assert.deepEqual(Object.keys(row).sort(), [...keys].sort(), '字段集合必须恒定');
      for (const k of keys) {
        assert.notEqual(row[k], undefined, `${k} 不许是 undefined`);
      }
    }
  }
});

test('缺字段 / 空输入也不许抛，也不许出 undefined', () => {
  const empty = signoffWorklistItems(null);
  assert.deepEqual(empty, { pending: [], signed: [], revoked: [] });
  const partial = signoffWorklistItems({ items: [{ milestoneId: 'm_x' }] });
  assert.equal(partial.pending.length, 1);
  assert.equal(partial.pending[0].teamName, '');
  assert.equal(partial.pending[0].signoffId, null);
  assert.equal(partial.pending[0].canWithdraw, false);
});

// ══════════════════════════════════════════════════════════════════
// 二、提交载荷：字段名必须与后端 body 逐字一致
// ══════════════════════════════════════════════════════════════════

test('★ 里程碑签字载荷：字段名是 department / content（抄错就是 400）', () => {
  const built = signoffFormState({ values: { department: '业务部', content: '解决了库存周转' } });
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.payload, { department: '业务部', content: '解决了库存周转' });
  assert.deepEqual(Object.keys(built.payload).sort(), ['content', 'department']);
});

test('里程碑签字：部门或内容为空 ⇒ 不组装请求（payload 为 null），并给出字段级错误', () => {
  const noDept = signoffFormState({ values: { department: '  ', content: 'x' } });
  assert.equal(noDept.payload, null);
  assert.equal(noDept.errors.length, 1);
  assert.equal(noDept.errors[0].field, 'department');

  const noContent = signoffFormState({ values: { department: '业务部', content: '' } });
  assert.equal(noContent.payload, null);
  assert.equal(noContent.errors[0].field, 'content');
});

test('撤回载荷：字段名是 signoffId（后端读的是 ctx.body.signoffId）', () => {
  const built = buildWithdrawPayload({ signoffId: 's_1' });
  assert.deepEqual(built.payload, { signoffId: 's_1' });
  assert.deepEqual(Object.keys(built.payload), ['signoffId']);
  const bad = buildWithdrawPayload({ signoffId: '' });
  assert.equal(bad.payload, null);
  assert.equal(bad.errors[0].field, 'signoffId');
});

test('★ 企业双签载荷：teamId / dimension / rawScore / content / crossJudgeId', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a',
    dimension: 'enterprise',
    rawScore: '88',
    content: '解决了库存周转环节',
    crossJudgeId: 'u_judge1',
  });
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.payload, {
    teamId: 't_a',
    dimension: 'enterprise',
    rawScore: 88,
    content: '解决了库存周转环节',
    crossJudgeId: 'u_judge1',
  });
});

test('企业双签：不带 signatoryUserId（后端会把它设成 enterpriseId，前端多传反而 403）', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: 'u_judge1',
  });
  assert.equal('signatoryUserId' in built.payload, false);
});

test('★ 企业双签：没填分 ⇒ 报错（空串会被 Number 当成 0 分提交出去）', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '',
    content: 'x', crossJudgeId: 'u_judge1',
  });
  assert.equal(built.payload, null);
  assert.equal(built.errors[0].field, 'rawScore');
});

test('企业双签：分数越界 / 非数字 ⇒ 报错（0–100 百分制）', () => {
  for (const bad of ['101', '-1', 'abc']) {
    const built = enterpriseConfirmPayload({
      teamId: 't_a', dimension: 'enterprise', rawScore: bad,
      content: 'x', crossJudgeId: 'u_judge1',
    });
    assert.equal(built.payload, null, `${bad} 必须被拦`);
    assert.equal(built.errors.some((e) => e.field === 'rawScore'), true);
  }
});

test('★ 企业双签：没选跨领域评委 ⇒ 不许提交（双签制，缺第二签就是白签）', () => {
  const built = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: '',
  });
  assert.equal(built.payload, null);
  assert.equal(built.errors.some((e) => e.field === 'crossJudgeId'), true);
});

test('企业双签：组委会代录时才带 enterpriseId', () => {
  const withEnt = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: 'u_judge1', enterpriseId: 'u_enterprise1',
  });
  assert.equal(withEnt.payload.enterpriseId, 'u_enterprise1');
  const without = enterpriseConfirmPayload({
    teamId: 't_a', dimension: 'enterprise', rawScore: '70',
    content: 'x', crossJudgeId: 'u_judge1',
  });
  assert.equal('enterpriseId' in without.payload, false);
});

test('企业双签表单初值：字段恒定，不出现 undefined', () => {
  const state = enterpriseConfirmFormState(null);
  assert.deepEqual(state, {
    teamId: '', dimension: '', rawScore: '', content: '', crossJudgeId: '',
  });
  for (const v of Object.values(state)) assert.notEqual(v, undefined);
});

// ══════════════════════════════════════════════════════════════════
// 三、企业双签清单：「还缺哪一签」
// ══════════════════════════════════════════════════════════════════

const BOARD = {
  stage: { id: 'stage_final', key: 'final', name: '决赛赛段' },
  scope: 'enterprise',
  myEnterpriseId: 'u_enterprise1',
  dimensions: [{ key: 'enterprise', name: '企业确认', weight: 0.25, seat: 'enterprise' }],
  teams: [
    { teamId: 't_a', teamName: '拾光队', taskPackageTitle: '库存周转', enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true },
    { teamId: 't_b', teamName: '长风队', taskPackageTitle: '门店选址', enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true },
    { teamId: 't_c', teamName: '自由组', taskPackageTitle: '自由命题', enterpriseId: null, isFreeBrief: true, canSign: true },
  ],
  confirmations: [
    { id: 'c_1', teamId: 't_a', enterpriseId: 'u_enterprise1', dimension: 'enterprise', rawScore: 82, hasCrossJudge: true, signedAt: '2026-10-20T04:00:00.000Z', content: 'x' },
    { id: 'c_2', teamId: 't_b', enterpriseId: 'u_enterprise1', dimension: 'enterprise', rawScore: 70, hasCrossJudge: false, signedAt: '2026-10-20T05:00:00.000Z', content: 'y' },
  ],
  crossJudgeCandidates: [
    { userId: 'u_enterprise1', name: '我自己（企业席）', seat: 'enterprise' },
    { userId: 'u_judge1', name: '李评委', seat: 'judge' },
    { userId: 'u_judge2', name: '王评委', seat: 'judge' },
  ],
};

test('★ 双签缺口：已签但没带跨领域评委 ⇒ 判定缺 crossJudge 这一签', () => {
  const rows = enterpriseConfirmRows(BOARD);
  const rowB = rows.find((r) => r.teamId === 't_b');
  assert.equal(rowB.signed, true, 't_b 已确认');
  assert.equal(rowB.hasCrossJudge, false);
  assert.deepEqual(rowB.missing, ['crossJudge']);
});

test('双签缺口：双签齐全 ⇒ 不缺任何一签', () => {
  const rowA = enterpriseConfirmRows(BOARD).find((r) => r.teamId === 't_a');
  assert.deepEqual(rowA.missing, []);
  assert.equal(rowA.rawScore, 82);
  assert.equal(rowA.signedAt, '2026-10-20T04:00:00.000Z');
});

test('双签缺口：完全没确认 ⇒ 缺 enterprise 这一签', () => {
  const rowC = enterpriseConfirmRows(BOARD).find((r) => r.teamId === 't_c');
  assert.equal(rowC.signed, false);
  assert.deepEqual(rowC.missing, ['enterprise']);
});

test('双签缺口：别家企业签的不算这条队的确认（R1 口径：非本赛道签字不算数）', () => {
  const raw = {
    ...BOARD,
    confirmations: [
      { id: 'c_9', teamId: 't_a', enterpriseId: 'u_other', dimension: 'enterprise', rawScore: 99, hasCrossJudge: true, signedAt: 'x', content: 'x' },
    ],
  };
  const row = enterpriseConfirmRows(raw).find((r) => r.teamId === 't_a');
  assert.equal(row.signed, false, '别家企业签的不能算本赛道企业的确认');
  assert.deepEqual(row.missing, ['enterprise']);
});

test('双签清单行：字段恒定，不出现 undefined', () => {
  for (const row of enterpriseConfirmRows(BOARD)) {
    for (const v of Object.values(row)) assert.notEqual(v, undefined, `${row.teamId} 的字段不许是 undefined`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 四、跨领域评委候选：必须剔除「我自己」
// ══════════════════════════════════════════════════════════════════

test('★ 候选里没有我自己（选了就是 400 CROSS_JUDGE_SAME_AS_SIGNATORY）', () => {
  const candidates = crossJudgeCandidates(BOARD);
  assert.deepEqual(candidates.map((c) => c.userId), ['u_judge1', 'u_judge2']);
  assert.equal(candidates.some((c) => c.userId === 'u_enterprise1'), false);
});

test('候选剔除：组委会代录时还要剔除被代签的那家企业', () => {
  const candidates = crossJudgeCandidates(BOARD, { signatoryId: 'u_judge1' });
  assert.deepEqual(candidates.map((c) => c.userId), ['u_judge2']);
});

test('候选字段恒定', () => {
  for (const c of crossJudgeCandidates(BOARD)) {
    assert.deepEqual(Object.keys(c).sort(), ['name', 'seat', 'userId']);
  }
});

test('席别标签：认不出来的值原样透出（不猜、不吞）', () => {
  assert.equal(seatLabel('judge'), '专家席');
  assert.equal(seatLabel('weird'), 'weird');
  assert.equal(seatLabel(null), '');
});

// ══════════════════════════════════════════════════════════════════
// 五、转义闸：服务端数据里的 HTML 必须被转义
// ══════════════════════════════════════════════════════════════════

test('★ 转义闸：服务端数据里的 <script> 不得变成真标签', () => {
  const raw = {
    scope: 'enterprise',
    items: [{
      milestoneId: 'm_x', teamId: 't_x',
      teamName: '<script>alert(1)</script>',
      key: 'k', label: '<img src=x onerror=alert(2)>',
      countsTowardTier: true, signed: true, signoffId: 's_x',
      signedAt: '2026-10-20T04:00:00.000Z', department: '<b>业务部</b>',
      content: '</textarea><script>alert(3)</script>',
      revokedAt: null, signedByMe: true, canWithdraw: true,
    }],
  };
  const html = signoffWorklistHtml({ raw });
  assert.ok(!html.includes('<script>'), '服务端数据里的 <script> 不得原样进 HTML');
  assert.ok(!html.includes('<img src=x'), '服务端数据里的标签不得原样进 HTML');
  assert.ok(!html.includes('</textarea><script>'), '不得借 textarea 提前闭合');
  assert.ok(html.includes('&lt;script&gt;'), '必须转义成实体');
});

test('★ 转义闸：企业双签清单里的队名 / 任务包同样要转义', () => {
  const raw = {
    ...BOARD,
    teams: [{ teamId: 't_x', teamName: '<script>alert(1)</script>', taskPackageTitle: '"><b>x', enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true }],
  };
  const html = enterpriseConfirmHtml({ board: raw, stages: [], stageId: 'stage_final' });
  assert.ok(!html.includes('<script>'), '服务端数据里的 <script> 不得原样进 HTML');
  assert.ok(html.includes('&lt;script&gt;'));
});

// ══════════════════════════════════════════════════════════════════
// 六、渲染态：加载 / 错误（带重试）/ 空态（带下一步）
// ══════════════════════════════════════════════════════════════════

test('加载态：用 loadingState（有 aria-live，不是一片空白）', () => {
  const html = signoffWorklistHtml({ loading: true });
  assert.ok(html.includes('state--loading'));
  assert.ok(html.includes('aria-live="polite'));
});

test('★ 错误态必须带真能点的重试（DP-80），并标出重试的是哪一块', () => {
  const html = signoffWorklistHtml({ error: '缺少能力：signoff:create' });
  assert.ok(html.includes('state--error'));
  assert.ok(html.includes('data-action="retry"'), '错误态必须带重试按钮');
  assert.ok(html.includes('data-retry-kind="worklist"'), '必须标明重试的是签字清单');
  assert.ok(html.includes('缺少能力'));
});

test('★ 空态必须给可点的下一步（不是死路一条）', () => {
  const html = signoffWorklistHtml({ raw: { items: [] } });
  assert.ok(html.includes('state--empty'));
  assert.ok(html.includes('href="#/team"'), '空态必须给出可点的下一步');
});

test('企业双签区块：没有可用的跨领域评委 ⇒ 明确说清楚（双签凑不齐）并禁用提交', () => {
  const raw = { ...BOARD, crossJudgeCandidates: [{ userId: 'u_enterprise1', name: '我自己', seat: 'enterprise' }] };
  const html = enterpriseConfirmHtml({ board: raw, stages: [], stageId: 'stage_final' });
  assert.ok(html.includes('没有可用的跨领域评委'));
  assert.ok(html.includes('disabled'), '没有第二签字人时提交按钮必须禁用');
});

// ══════════════════════════════════════════════════════════════════
// 七、DOM 桩上的真实交互（路径 + 请求体都断言）
// ══════════════════════════════════════════════════════════════════

/** 造一个可记录调用的 api 桩。 */
function makeApi({ failGet = false, worklist = WORKLIST, board = BOARD, stages = [{ id: 'stage_final', name: '决赛赛段' }] } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      if (failGet) throw new Error('接口挂了');
      if (path === '/api/signoffs/mine') return worklist;
      if (path === '/api/stages') return { items: stages };
      if (path.endsWith('/enterprise-confirmations')) return board;
      throw new Error(`未预期的 GET：${path}`);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      return { ok: true };
    },
  };
}

/** 装上全局 document 桩，并返回「视图根元素」的取法。 */
function installDom() {
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
  };
  return created;
}

test('★ DOM 桩：视图在最小桩上不抛，且渲染出清单', async () => {
  const created = installDom();
  const api = makeApi();
  const view = await renderSignoff({ api, params: { stageId: 'stage_final' } });
  assert.ok(view, '必须返回元素');
  const html = created[0].innerHTML;
  assert.ok(html.includes('企业签字台'));
  assert.ok(html.includes('企业问题确认'), '待签项要渲染出来');
  assert.ok(html.includes('拾光队'));
  // 三组标题都在
  assert.ok(html.includes('待签') && html.includes('已签') && html.includes('已撤回'));
});

test('★ DOM 桩：接口失败 ⇒ 渲染带重试的错误态（不是白屏）', async () => {
  const created = installDom();
  const api = makeApi({ failGet: true });
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const html = created[0].innerHTML;
  assert.ok(html.includes('state--error'), '必须有错误态');
  assert.ok(html.includes('data-action="retry"'), '错误态必须带可点的重试');
  assert.ok(html.includes('企业签字台'), '页头还在（不是白屏）');
});

test('★ DOM 桩：提交成功后重新拉清单（断言真的又 GET 了一次）', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];
  const before = api.calls.filter((c) => c.method === 'GET' && c.path === '/api/signoffs/mine').length;

  root._nodes['[data-signoff="department"][data-milestone="m_pending"]'] = { value: '业务部' };
  root._nodes['[data-signoff="content"][data-milestone="m_pending"]'] = { value: '已确认门店需求' };
  root._nodes['[data-feedback="signoff:m_pending"]'] = { innerHTML: '' };

  root.dispatch('click', {
    target: fakeButton({ action: 'signoff-submit', milestone: 'm_pending' }),
  });
  await flush();

  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/milestones/m_pending/signoff');
  assert.ok(post, '必须真的发了签字请求');
  assert.deepEqual(post.body, { department: '业务部', content: '已确认门店需求' });
  const after = api.calls.filter((c) => c.method === 'GET' && c.path === '/api/signoffs/mine').length;
  assert.ok(after > before, '提交成功后必须重新拉清单');
});

test('★ DOM 桩：撤回请求的路径与请求体（signoffId）都对', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];
  root._nodes['[data-feedback="withdraw:m_signed"]'] = { innerHTML: '' };

  root.dispatch('click', {
    target: fakeButton({ action: 'withdraw-confirm', milestone: 'm_signed', signoff: 's_1' }),
  });
  await flush();

  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/milestones/m_signed/signoff/withdraw');
  assert.ok(post, '必须发撤回请求');
  assert.deepEqual(post.body, { signoffId: 's_1' });
});

test('★ DOM 桩：企业双签提交 —— 路径与请求体逐字对后端', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];

  root._nodes['[data-confirm="team"]'] = { value: 't_a' };
  root._nodes['[data-confirm="dimension"]'] = { value: 'enterprise' };
  root._nodes['[data-confirm="rawScore"]'] = { value: '88' };
  root._nodes['[data-confirm="content"]'] = { value: '解决了库存周转环节' };
  root._nodes['[data-confirm="crossJudge"]'] = { value: 'u_judge1' };
  root._nodes['[data-feedback="confirm"]'] = { innerHTML: '' };

  root.dispatch('click', { target: fakeButton({ action: 'confirm-submit' }) });
  await flush();

  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/stages/stage_final/enterprise-confirmations');
  assert.ok(post, '必须发企业确认请求');
  assert.deepEqual(post.body, {
    teamId: 't_a',
    dimension: 'enterprise',
    rawScore: 88,
    content: '解决了库存周转环节',
    crossJudgeId: 'u_judge1',
  });
});

test('★ DOM 桩：企业双签缺跨领域评委 ⇒ 不发请求（本地拦下）', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];

  root._nodes['[data-confirm="team"]'] = { value: 't_a' };
  root._nodes['[data-confirm="dimension"]'] = { value: 'enterprise' };
  root._nodes['[data-confirm="rawScore"]'] = { value: '88' };
  root._nodes['[data-confirm="content"]'] = { value: 'x' };
  root._nodes['[data-confirm="crossJudge"]'] = { value: '' };
  root._nodes['[data-feedback="confirm"]'] = { innerHTML: '' };

  root.dispatch('click', { target: fakeButton({ action: 'confirm-submit' }) });
  await flush();

  assert.equal(
    api.calls.some((c) => c.method === 'POST' && c.path.includes('enterprise-confirmations')),
    false,
    '缺第二签时不该发请求',
  );
});

// ══════════════════════════════════════════════════════════════════
// 八、撤回是破坏性动作：渲染出的 HTML 里必须有确认环节
// ══════════════════════════════════════════════════════════════════

test('★ 撤回是破坏性动作 ⇒ 渲染出的 HTML 里必须带二次确认', () => {
  const html = signoffWorklistHtml({ raw: WORKLIST });
  // 撤回入口
  assert.ok(html.includes('data-action="withdraw"'), '必须有撤回入口');
  // 二次确认环节（默认 hidden，点第一次才展开）
  assert.ok(html.includes('data-action="withdraw-confirm"'), '必须有确认撤回这一步');
  assert.ok(html.includes('data-action="withdraw-cancel"'), '必须能取消');
  assert.ok(html.includes('data-needs-confirm="true"'), '撤回入口必须标出需要二次确认');
  assert.ok(html.includes('hidden'), '确认区默认收起');
  // 后果说明
  assert.ok(html.includes('未达成'), '必须说清撤回的后果（回到未达成、段位重算降档）');
});

test('★ 撤回的二次确认区是「点了才展开」（默认 hidden）', async () => {
  const created = installDom();
  const api = makeApi();
  await renderSignoff({ api, params: { stageId: 'stage_final' } });
  const root = created[0];
  const box = { hidden: true, querySelector: () => null };
  root._nodes['[data-confirm="withdraw"][data-milestone="m_signed"]'] = box;

  root.dispatch('click', {
    target: fakeButton({ action: 'withdraw', milestone: 'm_signed', signoff: 's_1' }),
  });
  await flush();

  assert.equal(box.hidden, false, '点「撤回」必须展开确认区');
  assert.equal(
    api.calls.some((c) => c.method === 'POST'),
    false,
    '展开确认区不许发请求（破坏性动作不能一按就发）',
  );
});

// ══════════════════════════════════════════════════════════════════
// 九、纪律闸
// ══════════════════════════════════════════════════════════════════

test('机器闸：不给 noticeState 传 text（它只认 items / list）', () => {
  assert.ok(!/noticeState\(\{[^}]*\btext\s*:/.test(VIEW_JS), 'noticeState 的参数名必须叫 items');
});

test('机器闸：视图里不许出现字面色值（颜色只能走 token）', () => {
  const code = VIEW_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), '视图里不许写十六进制色值');
  assert.ok(!/rgba?\(/.test(code), '视图里不许写 rgb/rgba 色值');
});

test('机器闸：不许整页刷新（DP-81）', () => {
  assert.ok(!/location\.reload/.test(VIEW_JS), '不许整页刷新');
});

test('机器闸：整页渲染时服务端数据里的标签一律不得原样出现', () => {
  const hostile = {
    scope: 'enterprise',
    items: [{
      milestoneId: 'm_x', teamId: 't_x',
      teamName: '<script>alert(1)</script>',
      key: '<b>k</b>', label: '<img src=x onerror=alert(2)>',
      countsTowardTier: true, signed: true, signoffId: 's_x',
      signedAt: '2026-10-20T04:00:00.000Z', department: '<b>业务部</b>',
      content: '</textarea><script>alert(3)</script>',
      revokedAt: null, signedByMe: true, canWithdraw: true,
    }],
  };
  const html = signoffPageHtml({
    worklist: hostile,
    board: {
      ...BOARD,
      teams: [{
        teamId: 't_x', teamName: '<script>alert(4)</script>', taskPackageTitle: '"><b>x',
        enterpriseId: 'u_enterprise1', isFreeBrief: false, canSign: true,
      }],
    },
    stages: [{ id: 's_x', name: '<script>alert(5)</script>' }],
    stageId: 's_x',
  });
  assert.ok(!/<script/i.test(html), '整页里不许出现真 <script> 标签');
  assert.ok(!/<img\s/i.test(html), '整页里不许出现真 <img> 标签（转义后只剩文本）');
  // ⚠️ 「onerror=」这串**文本**仍会出现在输出里（它是数据的一部分，被转义成普通文本，
  //    不会成为属性）⇒ 断言的是「没有真标签」，不是「字符串消失」。
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), '数据必须被转义成文本节点');
});

test('机器闸：视图里不许出现硬编码的赛制数字（分值区间常量除外）', () => {
  const code = VIEW_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 25% / 10% 这类权重不许出现在前端（一切来自后端）。
  assert.ok(!/25%|10%/.test(code), '前端不许硬编码赛制权重');
});

// ══════════════════════════════════════════════════════════════════
// 十、两个新读端点（API 层）：可见性 / 三态状态码 / 字段形状
//
// ⚠️ 这两个端点是**前端能点得到**的前提：
//   - GET /api/signoffs/mine                    → 给 milestoneId + signoffId
//   - GET /api/stages/:stageId/enterprise-confirmations → 给 crossJudgeId 的候选
//   ⇒ 「界面有了但端点是坏的」= 假完成 ⇒ 这里跑真实的应用装配（app.handle → 路由 → 鉴权）。
// ══════════════════════════════════════════════════════════════════

test('API：未登录读签字台 → 401', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine');
  assert.equal(res.status, 401);
  teardownApi(s);
});

test('API：没有 signoff:create 的人读签字台 → 403（不是 200 空集）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenOutsider });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'FORBIDDEN');
  teardownApi(s);
});

test('★ API：企业席只看得到**自己出题**队伍的里程碑（可见性在 API 层过滤）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise });
  assert.equal(res.status, 200);
  assert.equal(res.json.scope, 'enterprise');
  const teams = [...new Set(res.json.items.map((x) => x.teamId))];
  assert.deepEqual(teams, [s.teamMine.id], '别家企业出题的队不许出现在企业席的清单里');
  assert.equal(res.json.items.length, s.milestones.length);
  // 字段恒定：前端要靠 milestoneId / signoffId 调写端点
  for (const item of res.json.items) {
    assert.ok(item.milestoneId, '必须给 milestoneId（写端点的路径参数）');
    assert.equal(item.signoffId, null, '还没签 ⇒ signoffId 必须是 null');
    assert.equal(item.signed, false);
    assert.equal('signatoryName' in item, false, '签字人不公开（R-ENT-04）');
  }
  teardownApi(s);
});

test('★ API：签完字之后，清单里能拿到 signoffId（撤回报文要用）', async () => {
  const s = setupApi();
  const mid = s.milestones[0].id;
  const sign = await callJson(s.app, 'POST', `/api/milestones/${mid}/signoff`, {
    token: s.tokenEnterprise,
    body: { department: '业务部', content: '已确认门店需求' },
  });
  assert.equal(sign.status, 200);
  const list = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise });
  const item = list.json.items.find((x) => x.milestoneId === mid);
  assert.equal(item.signed, true);
  assert.ok(item.signoffId, '签完必须有 signoffId');
  assert.equal(item.canWithdraw, true);
  assert.equal(item.department, '业务部');

  // 撤回（破坏性动作）→ 再读一次，状态变「已撤回」
  const wd = await callJson(s.app, 'POST', `/api/milestones/${mid}/signoff/withdraw`, {
    token: s.tokenEnterprise,
    body: { signoffId: item.signoffId },
  });
  assert.equal(wd.status, 200);
  const after = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise });
  const item2 = after.json.items.find((x) => x.milestoneId === mid);
  assert.equal(item2.signed, false, '撤回后不是「已签」');
  assert.ok(item2.revokedAt, '撤回后必须能看到撤回时间');
  teardownApi(s);
});

test('API：读企业双签清单 —— 未登录 401 / 赛段不存在 404 / 无权限 403', async () => {
  const s = setupApi();
  const path = `/api/stages/${s.stage.id}/enterprise-confirmations`;
  assert.equal((await callJson(s.app, 'GET', path)).status, 401);
  assert.equal((await callJson(s.app, 'GET', '/api/stages/no_such_stage/enterprise-confirmations', { token: s.tokenEnterprise })).status, 404);
  assert.equal((await callJson(s.app, 'GET', path, { token: s.tokenOutsider })).status, 403);
  teardownApi(s);
});

test('★ API：企业双签清单只含自己能签的队，且跨领域评委候选不含自己', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenEnterprise,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.teams.map((t) => t.teamId), [s.teamMine.id], '只含自己出题的队');
  assert.equal(res.json.myEnterpriseId, s.enterprise.id);
  assert.equal(
    res.json.crossJudgeCandidates.some((c) => c.userId === s.enterprise.id),
    false,
    '候选里不能有我自己（后端会 400 CROSS_JUDGE_SAME_AS_SIGNATORY）',
  );
  assert.ok(res.json.crossJudgeCandidates.length > 0, '必须能选出不是我的人，否则双签永远凑不齐');
  // 企业确认维度来自规则表（不写死）
  assert.ok(res.json.dimensions.length > 0, '必须给出企业确认维度（前端据此组装 dimension）');
  assert.equal(res.json.dimensions[0].seat, 'enterprise');
  teardownApi(s);
});

test('★ API：双签提交之后，清单里能看出「双签齐全」', async () => {
  const s = setupApi();
  const path = `/api/stages/${s.stage.id}/enterprise-confirmations`;
  const before = await callJson(s.app, 'GET', path, { token: s.tokenEnterprise });
  assert.equal(before.json.confirmations.length, 0);
  const candidate = before.json.crossJudgeCandidates[0];
  const post = await callJson(s.app, 'POST', path, {
    token: s.tokenEnterprise,
    body: {
      teamId: s.teamMine.id,
      dimension: before.json.dimensions[0].key,
      rawScore: 88,
      content: '解决了库存周转环节',
      crossJudgeId: candidate.userId,
    },
  });
  assert.equal(post.status, 200);
  const after = await callJson(s.app, 'GET', path, { token: s.tokenEnterprise });
  assert.equal(after.json.confirmations.length, 1);
  assert.equal(after.json.confirmations[0].hasCrossJudge, true, '必须能看出带了跨领域评委签字');
  assert.equal(after.json.confirmations[0].rawScore, 88);
  teardownApi(s);
});

test('★ API：组委会能看到全部队伍的清单（代录视角）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/enterprise-confirmations`, {
    token: s.tokenAdmin,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.scope, 'committee');
  const teams = res.json.teams.map((t) => t.teamId).sort();
  assert.deepEqual(teams, [s.teamMine.id, s.teamOther.id].sort(), '组委会看得到全部队伍');
  teardownApi(s);
});

test('★ API：授权在**届期作用域**上也放行（与写端点同一口径：scopeType=edition）', async () => {
  const s = setupApi();
  // ⚠️ 用**没有任何授权**的另一家企业来测（否则全局授权会把届期作用域的效果盖掉）：
  //   只给「signoff:create」且作用域是 edition（不是 global）。
  const before = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise2 });
  assert.equal(before.status, 403, '没有授权 ⇒ 403（不是 200 空集）');
  grantAssignment(s.db, {
    userId: s.enterprise2.id,
    capability: 'signoff:create',
    scopeType: 'edition',
    scopeId: s.edition.id,
    grantedBy: s.admin.id,
  });
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenEnterprise2 });
  assert.equal(res.status, 200, '届期作用域授权也要放行（否则出现「写端点能签、列表却 403」）');
  assert.deepEqual(
    [...new Set(res.json.items.map((x) => x.teamId))],
    [s.teamOther.id],
    '只看到自己出题的队',
  );
  teardownApi(s);
});

test('★ API：组委会读签字台 ⇒ 看得到全部队伍的里程碑（代录 / 核查视角）', async () => {
  const s = setupApi();
  const res = await callJson(s.app, 'GET', '/api/signoffs/mine', { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(res.json.scope, 'committee');
  const teams = [...new Set(res.json.items.map((x) => x.teamId))].sort();
  assert.deepEqual(teams, [s.teamMine.id, s.teamOther.id].sort(), '组委会看得到全部队伍');
  teardownApi(s);
});
```

### 任务卡审批界面测试

`platform/test/admin-task-packages.test.js`：任务卡审批界面测试

```javascript
// platform/test/admin-task-packages.test.js — 任务卡分级 / 审批界面的行为闸
//
// 依据：P10 计划 §4 W4-a（docs/superpowers/plans/2026-10-22-platform-P10-design-system.md）
// 视觉契约：docs/design-system-p10.md §4「外壳三件套 / 现有组件」§7「数据纪律」
// 溯源需求：R-ENT-06（六维可解性）/ R-ENT-07（一票否决）/ R-ENT-08（分级签约与协议）
//
// ⚠️ 本文件守的是三件**肉眼很难发现、但用户一定看得见**的事：
//   ① 六维评估表必须**六维都在**，且权重 / 量表上限 **来自 rules/solvability.json**
//      —— 前端写死任何一维 = 委员会改了配置、页面还在按旧口径打分；
//   ② 退回必须写理由 —— 没有理由的退回对出题方等于什么都没说；
//   ③ 失败必须留下**真能点的「重试」** —— 错误态是死路 = 生产级事故（DP-80）。
//
// ⚠️ 本文件还带一条**机器闸**：视图源码里不许出现 rules 里的字面量
//    （维度名 / 维度键 / 否决项 / 档位文案 / 权重）。
//    这条闸守的是全局约束「赛制只从 rules/*.json 来」——
//    写在测试里而不是靠自觉：改视图的人跑一次全量就知道自己踩了红线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTempDir } from '../test-helpers/tmp.js';

import {
  solvabilitySpecFromRules, solvabilitySpecFromPackages, resolveSolvabilitySpec,
  gradeTiers, selfReportedVetoes, packageView,
  solvabilityFormHtml, signoffFormHtml, taskPackageCardHtml, taskPackagesHtml, feedbackHtml,
  planSolvabilitySubmit, planSignoffSubmit, statCards, mixPanelHtml,
} from '../web/views/admin-task-packages.js';

// ⚠️ 隔离本进程临时目录（与其它测试同一口径）：进程退出时整体回收。
//    本文件本身不建临时目录，但统一口径 ⇒ 任何一行将来加的临时文件都自动被回收。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const RULES = JSON.parse(readFileSync(join(here, '..', 'rules', 'solvability.json'), 'utf8'));
const VIEW_JS = readFileSync(join(webDir, 'views', 'admin-task-packages.js'), 'utf8');

/** 一张「还没评估过」的任务卡（形状对齐后端 presentTaskPackage）。 */
function samplePkg(overrides = {}) {  return {
    id: 'tp_1',
    editionId: 'ed_1',
    enterpriseId: 'ent_1',
    enterpriseName: '演示企业',
    title: '门店缺货预测',
    painPoint: '缺货导致丢单',
    expectedDelivery: '每周补货建议',
    acceptanceCriteria: '建议采纳率可统计',
    grade: null,
    status: 'submitted',
    solvabilityScore: null,
    solvabilityGrade: null,
    commitment: '',
    agreement: '',
    isFreeBrief: false,
    meta: {},
    ...overrides,
  };
}

/** 取渲染结果里某个动作的按钮标签（用来断言「按钮在，但被锁住」）。 */
function buttonTag(html, action) {
  const m = String(html).match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`));
  return m ? m[0] : '';
}

// ══════════════════════════════════════════════════════════════════
// 一、六维评估表：维度 / 权重 / 量表全部来自规则
// ══════════════════════════════════════════════════════════════════

test('六维评估表：六维全在，权重与量表上限都来自规则', () => {
  const spec = solvabilitySpecFromRules(RULES);
  assert.equal(spec.dimensions.length, RULES.dimensions.length, '维度数必须与规则一致');

  const html = solvabilityFormHtml({ pkg: samplePkg(), spec });
  for (const d of RULES.dimensions) {
    assert.ok(html.includes(d.label), `维度「${d.label}」必须出现在评估表里`);
    assert.ok(
      html.includes(`${Math.round(d.weight * 100)}%`),
      `维度「${d.label}」的权重必须来自规则（${d.weight}）`,
    );
    assert.ok(
      html.includes(`>${d.max} / ${d.max}<`),
      `维度「${d.label}」的量表上限必须是 ${d.max}`,
    );
    assert.ok(
      html.includes(`data-dimension="${d.key}"`),
      `维度「${d.label}」必须带上规则里的键（提交时按键传 answers）`,
    );
  }
});

test('机器闸：视图源码里不许出现 rules 里的字面量（维度 / 否决项 / 档位文案 / 权重）', () => {
  const forbidden = [
    ...RULES.dimensions.map((d) => d.label),
    ...RULES.dimensions.map((d) => d.key),
    ...RULES.vetoes.map((v) => v.label),
    ...RULES.vetoes.map((v) => v.key),
    ...RULES.grades.map((g) => g.commitment),
    ...RULES.grades.map((g) => g.agreement),
    ...RULES.dimensions.map((d) => Number(d.weight).toFixed(2)),
  ]
    .filter((s) => typeof s === 'string' && s.trim().length >= 2)
    .map((s) => s.trim());

  assert.ok(forbidden.length >= 10, `禁用词条不该是空集（实际 ${forbidden.length} 条）`);
  for (const s of forbidden) {
    assert.ok(
      !VIEW_JS.includes(s),
      `视图源码里出现了规则字面量「${s}」—— 六维与档位只能来自 rules/solvability.json`,
    );
  }
});

test('规格来源：已评估过的卡能从服务端投影里拿到六维；没评估过就拿不到', () => {
  const explain = RULES.dimensions.map((d) => ({
    dimension: d.key, label: d.label, value: 1, max: d.max, weight: d.weight,
  }));
  const assessed = samplePkg({ status: 'assessed', meta: { solvability: { explain } } });

  const spec = solvabilitySpecFromPackages([assessed]);
  assert.equal(spec.source, 'api');
  assert.equal(spec.dimensions.length, RULES.dimensions.length);
  assert.equal(spec.dimensions[0].key, RULES.dimensions[0].key);
  assert.equal(spec.dimensions[0].label, RULES.dimensions[0].label);
  assert.equal(spec.dimensions[0].max, RULES.dimensions[0].max);

  assert.equal(solvabilitySpecFromPackages([samplePkg()]), null, '没评估过的卡没有规格');
  assert.equal(solvabilitySpecFromPackages(null), null, '入参为 null 不得抛错');
});

test('规格取舍：规则投影更完整 ⇒ 有它就用它；没有才退回服务端投影', () => {
  const explain = RULES.dimensions.map((d) => ({
    dimension: d.key, label: d.label, value: 1, max: d.max, weight: d.weight,
  }));
  const assessed = samplePkg({ status: 'assessed', meta: { solvability: { explain } } });

  const withRules = resolveSolvabilitySpec({ packages: [assessed], rules: RULES });
  assert.equal(withRules.source, 'rules');
  assert.equal(withRules.grades.length, RULES.grades.length, '档位必须来自规则（含分数区间）');

  const withoutRules = resolveSolvabilitySpec({ packages: [assessed], rules: null });
  assert.equal(withoutRules.source, 'api');
});

test('规格缺失：评估表不编造维度，只给一条能照做的提示', () => {
  const html = solvabilityFormHtml({ pkg: samplePkg(), spec: null });
  assert.ok(html.includes('六维评估表尚未就绪'), '必须说清为什么没有评估表');
  assert.ok(!html.includes('data-role="dimension"'), '没有规格就不许渲染评分控件');
});

// ══════════════════════════════════════════════════════════════════
// 二、签级 / 退回
// ══════════════════════════════════════════════════════════════════

test('签级：档位、承诺与协议都来自规则；最低一档是退回档', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const tiers = gradeTiers(spec);

  const lowest = [...RULES.grades].sort((a, b) => a.minScore - b.minScore)[0];
  assert.equal(tiers.return.key, lowest.key, '退回档必须是分数区间最低的那一档');
  assert.equal(tiers.approve.length, RULES.grades.length - 1, '其余档位是「通过」档');
  assert.ok(tiers.complete);

  const html = signoffFormHtml({ pkg: samplePkg(), spec });
  for (const g of tiers.approve) {
    assert.ok(html.includes(g.commitment), `档位「${g.key}」的企业承诺必须显示`);
    assert.ok(html.includes(`value="${g.key}"`), `档位「${g.key}」必须在可选项里`);
  }
  assert.ok(html.includes(tiers.return.agreement), '退回档的协议文案必须显示');
  assert.ok(!html.includes(`value="${tiers.return.key}"`), '退回档不该混进「通过」的可选项');
});

test('退回：理由为空时**不提交**（本地拦下），有理由才发请求', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const pkg = samplePkg({ status: 'assessed' });

  const empty = planSignoffSubmit({ pkg, action: 'return', reason: '   ', spec });
  assert.equal(empty.ok, false, '没有理由的退回不得发出去');
  assert.match(empty.message, /理由/, '必须说清缺的是理由');
  assert.equal(empty.url, undefined, '被拦下时不得产生请求地址');

  const ok = planSignoffSubmit({ pkg, action: 'return', reason: '缺数据授权说明', spec });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.grade, gradeTiers(spec).return.key, '退回必须落到退回档');
  assert.equal(ok.body.reason, '缺数据授权说明');
  assert.equal(ok.url, `/api/task-packages/${pkg.id}/approve`);
});

test('签级通过：必须选一个有效档位；body 只带 grade', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const pkg = samplePkg({ status: 'assessed' });
  const tiers = gradeTiers(spec);

  const bad = planSignoffSubmit({ pkg, action: 'approve', grade: '', spec });
  assert.equal(bad.ok, false, '没选档位不得发出去');

  const ok = planSignoffSubmit({ pkg, action: 'approve', grade: tiers.approve[0].key, spec });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.grade, tiers.approve[0].key);
  assert.equal(ok.url, `/api/task-packages/${pkg.id}/approve`);
});

test('退回理由的输入框在表单里（且标了必填）', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const html = signoffFormHtml({ pkg: samplePkg({ status: 'assessed' }), spec });
  assert.ok(html.includes('data-role="reason"'), '必须有理由输入框');
  assert.ok(html.includes('field--required'), '理由字段必须标必填');
  assert.ok(html.includes('data-action="return"'), '必须有退回按钮');
  assert.ok(html.includes('data-action="approve"'), '必须有签级通过按钮');
});

// ══════════════════════════════════════════════════════════════════
// 三、六维评估的提交计划
// ══════════════════════════════════════════════════════════════════

test('六维评估：漏打分的维度不许发出去；全打分才提交', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const pkg = samplePkg();
  const values = {};
  for (const d of RULES.dimensions) values[d.key] = d.max;

  const plan = planSolvabilitySubmit({ pkg, values, spec });
  assert.equal(plan.ok, true);
  assert.equal(plan.url, `/api/task-packages/${pkg.id}/solvability`);
  assert.equal(
    Object.keys(plan.body.answers).length,
    RULES.dimensions.length,
    'answers 必须六维齐全',
  );

  const partial = { ...values };
  delete partial[RULES.dimensions[0].key];
  const bad = planSolvabilitySubmit({ pkg, values: partial, spec });
  assert.equal(bad.ok, false, '漏一维就得拦下');
  assert.match(bad.message, new RegExp(RULES.dimensions[0].label), '要说清漏的是哪一维');
});

test('六维评估：分数越界（超出量表上限）不许发出去', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const values = {};
  for (const d of RULES.dimensions) values[d.key] = d.max;
  values[RULES.dimensions[0].key] = RULES.dimensions[0].max + 1;

  const bad = planSolvabilitySubmit({ pkg: samplePkg(), values, spec });
  assert.equal(bad.ok, false, '越界的分数服务端会 400，前端先拦一道');
});

// ══════════════════════════════════════════════════════════════════
// 四、否决项
// ══════════════════════════════════════════════════════════════════

test('否决项：只有规则里没有 auto 的那些才让委员会自报', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const expected = RULES.vetoes.filter((v) => !v.auto);
  const self = selfReportedVetoes(spec);
  assert.equal(self.length, expected.length);

  const html = solvabilityFormHtml({ pkg: samplePkg(), spec });
  for (const v of expected) {
    assert.ok(html.includes(v.label), `自报项「${v.label}」必须出现在表单里`);
  }
  for (const v of RULES.vetoes.filter((x) => x.auto)) {
    assert.ok(
      !html.includes(v.label),
      `「${v.label}」是由维度取值自动推导的，不该让委员会自报`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════
// 五、状态机
// ══════════════════════════════════════════════════════════════════

test('状态机：已发布的卡的评估与签级控件**锁住**（按钮在，但点不动）', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const published = samplePkg({ status: 'published' });

  const form = solvabilityFormHtml({ pkg: published, spec });
  const assess = buttonTag(form, 'assess');
  assert.ok(assess, '评估提交按钮要留着（委员会看得见这张卡怎么评的）');
  assert.ok(assess.includes('disabled'), '已发布的卡不得还能提交评估');
  assert.ok(form.includes('已发布'), '必须说清为什么锁着');

  const sign = signoffFormHtml({ pkg: published, spec });
  assert.ok(buttonTag(sign, 'approve').includes('disabled'), '已发布的卡不得还能签级');
  assert.ok(buttonTag(sign, 'return').includes('disabled'), '已发布的卡不得还能退回');

  const open = solvabilityFormHtml({ pkg: samplePkg({ status: 'submitted' }), spec });
  assert.ok(!buttonTag(open, 'assess').includes('disabled'), '已提交的卡必须能提交评估');
});

test('展示模型：状态、档位与得分都从服务端返回值来', () => {
  const view = packageView(samplePkg({
    status: 'assessed',
    solvabilityScore: 9,
    solvabilityGrade: 'B',
  }));
  assert.equal(view.statusLabel, '已评估');
  assert.equal(view.solvabilityScore, 9);
  assert.equal(view.solvabilityGrade, 'B');
  assert.equal(view.canAssess, true, '已评估的卡可以重新评估');
  assert.equal(view.canSign, true, '已评估的卡可以签级');
});

// ══════════════════════════════════════════════════════════════════
// 六、反馈与外壳
// ══════════════════════════════════════════════════════════════════

test('失败反馈：错误态里必须有**真能点的**「重试」', () => {
  const html = feedbackHtml({ tone: 'danger', message: '提交失败：服务不可用' });
  assert.ok(html.includes('data-action="retry"'), '错误态必须有重试按钮');
  assert.ok(html.includes('<button'), '重试必须是个真按钮（能点）');
  assert.ok(html.includes('提交失败：服务不可用'), '必须把失败原因说出来');
  assert.ok(html.includes('role="alert"'), '错误态要对辅助技术可见');
});

test('成功反馈：走提示条，不带重试', () => {
  const html = feedbackHtml({ tone: 'success', title: '已签级', message: '当前档位 A' });
  assert.ok(html.includes('notice'), '成功反馈用提示条');
  assert.ok(html.includes('已签级'));
  assert.ok(!html.includes('data-action="retry"'), '成功反馈不需要重试');
});

test('列表：空态给得出下一步，不是一片空白', () => {
  const html = taskPackagesHtml({ packages: [], spec: null });
  assert.ok(html.includes('还没有任务卡'));
  assert.ok(html.includes('state--empty'));
});

test('列表：每张卡都渲染出标题与两个操作区', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const html = taskPackagesHtml({ packages: [samplePkg()], spec });
  assert.ok(html.includes('门店缺货预测'));
  assert.ok(html.includes('data-role="dimension"'), '必须有六维评分控件');
  assert.ok(html.includes('data-action="approve"'));
  assert.ok(html.includes('data-action="return"'));
  assert.ok(html.includes('data-feedback="tp_1"'), '每张卡都要有就地反馈区');
});

test('存储型 XSS：任务卡标题必须转义后再进 innerHTML', () => {
  const spec = solvabilitySpecFromRules(RULES);
  const html = taskPackageCardHtml({
    pkg: samplePkg({ title: '<img src=x onerror=alert(1)>' }),
    spec,
  });
  assert.ok(!html.includes('<img src=x'), '标题里的标签不得原样进 HTML');
  assert.ok(html.includes('&lt;img'), '标题必须被转义');
});

// ══════════════════════════════════════════════════════════════════
// 七、指标行与配比体检
// ══════════════════════════════════════════════════════════════════

test('指标行：五个数都按状态数出来（前端不自己推口径）', () => {
  const cards = statCards([
    { status: 'submitted' }, { status: 'submitted' }, { status: 'assessed' },
    { status: 'returned' }, { status: 'published' },
  ]);
  assert.deepEqual(cards.map((c) => c.label), ['任务卡总数', '待评估', '待签级', '已退回', '已发布']);
  assert.deepEqual(cards.map((c) => c.value), [5, 2, 1, 1, 1]);
  assert.deepEqual(statCards([]).map((c) => c.value), [0, 0, 0, 0, 0]);
});

test('配比体检：结论与问题都来自 API 的 mix（前端不自己算比例）', () => {
  const bad = mixPanelHtml({
    total: 10, free: 3, enterprise: 7, actualFree: 0.3, actualEnterprise: 0.7,
    ok: false, errors: ['[TASK_MIX_FREE] 自由命题占比 30.0%，目标占比 30.0%'],
  });
  assert.ok(bad.includes('配比未达标'));
  assert.ok(bad.includes('[TASK_MIX_FREE]'), '配比问题要显示 API 的原文（口径不重述）');

  const good = mixPanelHtml({
    total: 3, free: 1, enterprise: 2, actualFree: 0.33, actualEnterprise: 0.67,
    ok: true, errors: [],
  });
  assert.ok(good.includes('配比达标'));
  assert.ok(!good.includes('配比未达标'));

  const none = mixPanelHtml(null);
  assert.ok(none.includes('暂无配比体检数据'), '没有体检数据时要说清，而不是空白');
});
```

### 申诉裁决界面测试

`platform/test/admin-appeals.test.js`：申诉裁决界面测试

```javascript
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
```

### 评委前置界面测试

`platform/test/review-prep.test.js`：评委前置界面测试

```javascript
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
```

### 能力点路由守卫测试

`platform/test/route-capability-guard.test.js`：能力点路由守卫测试

```javascript
// platform/test/route-capability-guard.test.js —— W1-b（DP-105）权限模型的行为闸
//
// 规则溯源：
//   - 「权限不靠角色枚举，靠『能力 + 授权记录』」→ 设计文档 §7.1 / §7.2
//   - 「前端按**能力点**声明式拦分区级页面；只声明 API 同样要求**全局**能力点的页面；
//     赛段级页面一律不拦」→ docs/superpowers/plans/2026-10-22-platform-P10-design-system.md
//     §3（DP-105）
//   - 「can() 是唯一判定入口；前端拿到的能力点只是**提示**」→ 全局约束「可见性在 API 层过滤」
//
// ⚠️ 本文件测的是**一条完整链路**：仓储（能力点并集）→ 对外形状（/api/me 的 capabilities）
//    → 前端守卫（canReach）。中间任何一环断了，守卫就会「误伤有权限的人」或「放行没权限的人」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { listUserCapabilities, insertAssignment } from '../src/db/repo/assignments.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { createUser, toPublicUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { loadRules } from '../src/config.js';
import { canReach, requiredCapability, userCapabilities, ROUTE_CAPABILITIES } from '../web/nav.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-cap-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  insertCapability(db, 'registration:review', '审核报名分级');
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertCapability(db, 'stage:compute', '触发计算发榜');
  insertCapability(db, 'score:write', '评分写入');
  insertRole(db, 'admin', '组委会');
  const user = createUser(db, { name: '甲', phone: '13900000077', password: 'pw' });
  return { db, close, dataDir, user };
}

// ══════════════════════════════════════════════════════════════════
// 一、仓储层：能力点 = 角色能力 ∪ 全局资源授权
// ══════════════════════════════════════════════════════════════════

test('能力点并集：角色能力 ∪ 全局资源授权（两条来源都要算进去）', () => {
  const { db, close, dataDir, user } = setup();
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, user.id, 'admin');
  insertAssignment(db, {
    id: 'as_1', userId: user.id, capability: 'stage:compute',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  assert.deepEqual(
    listUserCapabilities(db, user.id),
    ['audit:read', 'stage:compute'],
    '角色给的与直接授权的都要在里面',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('赛段级授权**不算数**（前端只声明「API 同样要求全局能力点」的页面）', () => {
  // ⛔ 这条是「前端拦路会不会误伤」的边界：评委 / 企业席拿的是**赛段级**授权，
  //    把它算进前端的能力点 ⇒ 前端会以为「这个页面我能进」而 API 其实 403。
  const { db, close, dataDir, user } = setup();
  insertAssignment(db, {
    id: 'as_stage', userId: user.id, capability: 'stage:compute',
    scopeType: 'stage', scopeId: 'stage_final', grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  insertAssignment(db, {
    id: 'as_edition', userId: user.id, capability: 'audit:read',
    scopeType: 'edition', scopeId: 'ed_1', grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  assert.deepEqual(
    listUserCapabilities(db, user.id),
    [],
    '赛段级 / 届次级授权不得进入全局能力点集合',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('能力点：去重 + 排序确定（同一能力点从两条来源来也只出现一次）', () => {
  const { db, close, dataDir, user } = setup();
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, user.id, 'admin');
  insertAssignment(db, {
    id: 'as_dup', userId: user.id, capability: 'audit:read',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  insertAssignment(db, {
    id: 'as_b', userId: user.id, capability: 'stage:compute',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  const first = listUserCapabilities(db, user.id);
  assert.deepEqual(first, ['audit:read', 'stage:compute'], '去重 + 按能力点键升序');
  // ⚠️ 顺序必须**确定**（同一份数据跑两次给同一个顺序）—— 前端会拿它做集合判断。
  assert.deepEqual(listUserCapabilities(db, user.id), first, '两次调用顺序必须一致');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('能力点：没有任何授权 ⇒ 空数组（不是 null、不是 undefined）', () => {
  const { db, close, dataDir, user } = setup();
  assert.deepEqual(listUserCapabilities(db, user.id), []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 二、对外形状：/api/me 的 capabilities
// ══════════════════════════════════════════════════════════════════

test('toPublicUser 缺省第三参数 ⇒ capabilities 是**空数组**（不是 undefined、不是全部）', () => {
  // ⛔ 缺省即「没有」：漏传不能让前端以为「这个人什么都能干」。
  const pub = toPublicUser({ id: 'u1', name: '甲', is_superadmin: 0, active: 1, created_at: 'now' });
  assert.ok(Array.isArray(pub.capabilities), 'capabilities 必须是数组（前端按数组读）');
  assert.deepEqual(pub.capabilities, [], '缺省就是空数组');
  assert.notEqual(pub.capabilities, undefined, '不得是 undefined');
});

test('toPublicUser 带能力点 ⇒ 原样带出（脏值滤掉、重复去重）', () => {
  const pub = toPublicUser(
    { id: 'u1', name: '甲', is_superadmin: 0, active: 1, created_at: 'now' },
    ['admin'],
    ['audit:read', 'audit:read', '', null, 7],
  );
  assert.deepEqual(pub.capabilities, ['audit:read']);
  assert.deepEqual(pub.roles, ['admin'], 'roles 不受影响');
});

// ══════════════════════════════════════════════════════════════════
// 三、前端守卫：canReach
// ══════════════════════════════════════════════════════════════════

const COMMITTEE_USER = { id: 'u_a', name: '组委会', roles: ['admin'], capabilities: ['audit:read'] };
const PLAYER_USER = { id: 'u_p', name: '选手', roles: ['member'], capabilities: [] };

test('守卫：未登录 ⇒ 拦（分区级页面一律要登录）', () => {
  assert.equal(canReach('/flags', null), false);
  assert.equal(canReach('/admin/registration', null), false);
  assert.equal(canReach('/publish', null), false);
});

test('守卫：超管直通（两种形状都认）', () => {
  assert.equal(canReach('/flags', { id: 'u_s', isSuperadmin: true, capabilities: [] }), true);
  assert.equal(canReach('/flags', { id: 'u_s', is_superadmin: 1, capabilities: [] }), true);
});

test('守卫：缺能力点 ⇒ 拦（登录了但不是组委会的人）', () => {
  assert.equal(canReach('/flags', PLAYER_USER), false, '没有 audit:read 进不了复核队列');
  assert.equal(canReach('/admin/registration', PLAYER_USER), false, '没有 registration:review 进不了筛选台');
  assert.equal(canReach('/publish', PLAYER_USER), false, '没有 stage:compute 进不了发榜');
});

test('守卫：有能力点 ⇒ 放行', () => {
  assert.equal(canReach('/flags', COMMITTEE_USER), true);
  assert.equal(canReach('/admin/registration', { id: 'u_x', capabilities: ['registration:review'] }), true);
  assert.equal(canReach('/publish', { id: 'u_x', capabilities: ['stage:compute'] }), true);
});

test('守卫：**未声明能力点的路径一律放行**（防误伤 —— 赛段级 / 公共页）', () => {
  // ⛔ 这条最容易写错：一旦把赛段级页面也拦了，评委 / 企业席会被挡在门外
  //    （他们的能力点是赛段级授权，前端无从判断）。
  for (const p of [
    '/', '/dashboard', '/apply', '/team', '/tasks', '/leaderboard', '/leaderboard/stage_final',
    '/tier', '/card/t_1', '/review', '/review/stage_final', '/publish/stage_final',
    '/audit/cmp_1', '/login',
  ]) {
    assert.equal(canReach(p, PLAYER_USER), true, `${p} 不得被能力点守卫拦下`);
  }
});

test('守卫：赛段级路径**不在**能力点声明表里（精确匹配，不是前缀匹配）', () => {
  assert.equal(ROUTE_CAPABILITIES['/publish'], 'stage:compute');
  assert.equal(ROUTE_CAPABILITIES['/publish/stage_final'], undefined, '赛段级发榜不得声明能力点');
  assert.equal(ROUTE_CAPABILITIES['/review/stage_final'], undefined, '赛段级评审不得声明能力点');
  assert.equal(ROUTE_CAPABILITIES['/leaderboard/stage_final'], undefined);
  assert.equal(requiredCapability('/flags'), 'audit:read');
  assert.equal(requiredCapability('/flags/'), 'audit:read', '结尾斜杠是同一个页面');
  assert.equal(requiredCapability('/flags?x=1'), 'audit:read', 'query 不影响判定');
  assert.equal(requiredCapability('/apply'), null, '没声明就没有');
});

test('守卫：服务端**没给**能力点 ⇒ 不拦（前端无从判断就别瞎猜）', () => {
  // ⚠️ 这个 user 对象不是 /api/me 的形状（演示适配器 / 旧缓存会话）⇒ 前端手里没有能力点。
  //    拦它 = 误伤一个服务端其实放行的人。
  assert.equal(canReach('/flags', { id: 'u_demo', roles: ['admin'] }), true);
  assert.equal(canReach('/flags', { id: 'u_demo', capabilities: null }), true);
});

test('能力点提取：各种脏形状都要兜住', () => {
  assert.deepEqual(userCapabilities({ capabilities: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(userCapabilities({ capabilities: 'a' }), ['a']);
  assert.deepEqual(userCapabilities({ capabilities: ['', null, 3, 'x'] }), ['x'], '脏值要滤掉');
  assert.deepEqual(userCapabilities(null), []);
  assert.deepEqual(userCapabilities({}), []);
});

// ══════════════════════════════════════════════════════════════════
// 四、端到端：/api/me 真的带上能力点（否则前端守卫永远「缺能力点」）
// ══════════════════════════════════════════════════════════════════

/** 极简请求桩（不需要真起 HTTP 服务）。 */
function call(app, method, path, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, url: path, headers, on() {}, async *[Symbol.asyncIterator]() {} };
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h || {}; },
      end(payload) {
        if (payload) this.body = payload.toString();
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };
    app.handle(req, res);
  });
}

test('/api/me 必须带上能力点（角色给的 + 直接授权的）', async () => {
  const { db, close, dataDir, user } = setup();
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, user.id, 'admin');
  insertAssignment(db, {
    id: 'as_me', userId: user.id, capability: 'stage:compute',
    scopeType: 'global', scopeId: null, grantedBy: null, createdAt: '2026-10-22T00:00:00.000Z',
  });
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const { token } = createSession(db, user.id);
  const res = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(
    body.user.capabilities,
    ['audit:read', 'stage:compute'],
    '/api/me 必须带上能力点（前端守卫靠它判断）',
  );
  // ⚠️ 端到端闭环：这个 user 直接喂给前端守卫 ⇒ 有能力点的人能进组委会页面。
  assert.equal(canReach('/flags', body.user), true);
  assert.equal(canReach('/publish', body.user), true);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('/api/me 的能力点缺省即空数组（没有任何授权的人拿不到「全部权限」）', async () => {
  const { db, close, dataDir, user } = setup();
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const { token } = createSession(db, user.id);
  const res = await call(app, 'GET', '/api/me', { headers: { cookie: `hk_session=${token}` } });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.user.capabilities, [], '没有授权 ⇒ 空数组（不是 undefined、不是全部）');
  assert.equal(canReach('/flags', body.user), false, '没有能力点 ⇒ 前端拦下组委会页面');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 五、前端外壳端到端：缺能力点 ⇒ 渲染「无权限页」，且**不发业务请求**
// ══════════════════════════════════════════════════════════════════

/** 最小 DOM 桩：够 web/app.js 跑起来。 */
function installDom(hash = '') {
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
  });
  const app = mk('div');
  const topbar = mk('div');
  globalThis.window = { location: { search: '', hash }, addEventListener() {} };
  globalThis.document = {
    createElement: (tag) => mk(tag),
    getElementById: (id) => (id === 'topbar' ? topbar : app),
  };
  return { app, topbar };
}

async function bootApp(hash, meBody, tag) {
  const dom = installDom(hash);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url) === '/api/me' ? meBody : { rows: [], total: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  await import(`../web/app.js?v=${tag}`);
  await new Promise((r) => setTimeout(r, 30));
  return { dom, calls };
}

test('前端外壳：缺能力点进组委会页面 ⇒ 渲染「无权限页」且**不发业务请求**', async () => {
  // ⚠️ 这条要防的正是「打磨前的真问题」：页面渲染出**完整界面但全是 0**
  //    （API 返回空集），用户看不懂「这是组委会的东西」，只以为页面坏了。
  const { dom, calls } = await bootApp(
    '#/flags',
    { user: { id: 'u_p', name: '选手', roles: ['member'], capabilities: [] } },
    'cap-guard-anon',
  );
  assert.ok(
    !calls.some((c) => c.includes('/api/audit/flags')),
    `被拦下的页面不得发业务请求，实际请求：${JSON.stringify(calls)}`,
  );
  const html = dom.app.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('组委会'), `无权限页要说明这页属于谁，实际：${html}`);
  assert.ok(html.includes('audit:read'), `无权限页要说明缺哪个能力点，实际：${html}`);
  assert.ok(html.includes('#/'), '无权限页要给出可点的下一步');
});

test('前端外壳（反向对照）：有能力点 ⇒ 页面照常渲染并请求数据', async () => {
  const { calls } = await bootApp(
    '#/flags',
    { user: { id: 'u_a', name: '组委会', roles: ['admin'], capabilities: ['audit:read'] } },
    'cap-guard-ok',
  );
  assert.ok(
    calls.some((c) => c.includes('/api/audit/flags')),
    `有能力点必须真的请求数据（上一条不是恒绿），实际请求：${JSON.stringify(calls)}`,
  );
});
```

### 评委前置读端点与校准白名单测试

`platform/test/review-read-endpoints.test.js`：评委前置读端点与校准白名单测试

```javascript
// platform/test/review-read-endpoints.test.js —— P10 评委前置的**读端点**与**校准维度白名单**
//
// 规则溯源：
//   - 「评委为供应方 / 投资方 / 前雇主必须回避，回避记录留档」→ R-JDG-09
//   - 「评委须签署声明」→ R-JDG-18
//   - 「用同一组样例作品校准宽严尺度，校准结果不计入评分」→ R-JDG-12
//   - 「自评测只触发解释与提问，不加分」→ R-JDG-13
//   - 「互评：队 → 队，提交者必须是发起队的在册成员」→ src/services/review.js submitPeerReviews
//   - 「权限模型 = capability + assignment，can() 是唯一判定入口」→ 设计文档 §7.1 / §7.2
//   - 「三态状态码」→ 设计文档 §7.3（未登录 → 401；禁用 → 403；单条不存在 → 404）
//   - 「可见性在 API 层过滤，前端隐藏 = 数据已泄露」→ 设计文档 §6.6
//   - 「确定性排序：兜底键用 rowid，不用随机 UUID」→ 全局约定 #43
//
// ⚠️ 本文件全部是**行为断言**（断言真实返回值 / 数据库状态），不是「源码里有某个字符串」。
// ⚠️ 夹具用**真实外键**（真实 user / edition / team / stage）—— 本仓有外键约束，假 id 会被 DB 拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-23T08:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['stage:compute', '触发计算发榜'],
  ['peer_review:write', '互评'],
  ['self_review:write', '提交本队自评'],
];

/**
 * 夹具：
 *   三支队（team1 / team2 / team3），队长是**独立的 captain 用户**（不是 admin）——
 *   ⛔ 这样 admin 自己**不属于任何队** ⇒ 「只有我参与的那部分」的断言才不会被
 *   「队长也算参与」这条口径污染（队长当然算参与，但那样就分不清是谁的记录了）。
 *   评委甲在 team1、评委乙在 team2。
 *   两个赛段：初赛（initial，没有 self 席维度）与决赛（final，有 self_eval 自评测维度）。
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-revread-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judgeA = createUser(db, { name: '评委甲', phone: '13900000061', password: 'pw' });
  const judgeB = createUser(db, { name: '评委乙', phone: '13900000062', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900000063', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900000064', password: 'pw' });
  const outsider = createUser(db, { name: '路人', phone: '13900000065', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judgeA.id, 'score:write');
  grant(judgeB.id, 'score:write');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(judgeA.id, 'peer_review:write');
  grant(judgeA.id, 'self_review:write');
  grant(judgeB.id, 'peer_review:write');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: null, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const team3 = insertTeam(db, {
    editionId: edition.id, name: '三队', captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  insertTeamMember(db, { teamId: team1.id, userId: judgeA.id, role: 'member', now: NOW });
  insertTeamMember(db, { teamId: team2.id, userId: judgeB.id, role: 'member', now: NOW });

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  // 决赛赛段：权重表里有 seat='self' 的「自评测」维度（初赛没有）
  const finalStage = insertStage(db, {
    editionId: edition.id, key: 's2', name: '决赛', kind: 'final',
    startsAt: '2026-10-11', endsAt: '2026-10-20', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judgeA.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judgeB.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: finalStage.id, userId: judgeA.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: finalStage.id, userId: judgeB.id, seat: 'judge', now: NOW });

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, edition, judgeA, judgeB, admin, captain, outsider,
    team1, team2, team3, stage, finalStage,
    tokenA: createSession(db, judgeA.id).token,
    tokenB: createSession(db, judgeB.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenOutsider: createSession(db, outsider.id).token,
  };
}

function teardown(s) {
  s.close();
  rmSync(s.dataDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════
// 一、回避台账读口：GET /api/stages/:stageId/recusals
// ══════════════════════════════════════════════════════════════════

test('回避台账：评委只看得到**自己**的记录，看不到别人的', async () => {
  const s = setup();
  // 评委甲为一队申报回避
  const a = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA,
    body: { teamId: s.team1.id, reason: '我是该队的供应方' },
  });
  assert.equal(a.status, 200, '本人申报回避应当成功');
  // 评委乙为二队申报回避
  const b = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenB,
    body: { teamId: s.team2.id, reason: '我是该队的投资方' },
  });
  assert.equal(b.status, 200);

  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 1, '评委甲只能看到自己那一条（评委乙的不许出现）');
  const item = res.json.items[0];
  assert.equal(item.judgeId, s.judgeA.id);
  assert.equal(item.teamId, s.team1.id);
  assert.equal(item.teamName, '一队', '必须带队伍名（人读要用；队名本来就在榜单上公开）');
  assert.equal(item.reason, '我是该队的供应方');
  assert.equal(item.status, 'recused');
  assert.ok(typeof item.createdAt === 'string' && item.createdAt, '必须带 createdAt');
  assert.ok(
    !res.json.items.some((x) => x.judgeId === s.judgeB.id),
    '⛔ 别人的回避记录绝不能出现在我的清单里',
  );
  teardown(s);
});

test('回避台账：组委会（stage:compute）看得到**全部**记录', async () => {
  const s = setup();
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA, body: { teamId: s.team1.id, reason: '供应方' },
  });
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenB, body: { teamId: s.team2.id, reason: '投资方' },
  });
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenAdmin });
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 2, '组委会应当看到全部两条');
  assert.deepEqual(
    res.json.items.map((x) => x.judgeId).sort(),
    [s.judgeA.id, s.judgeB.id].sort(),
  );
  teardown(s);
});

test('回避台账：没有记录时返回 200 + `{ items: [] }`（⛔ 不是 404）', async () => {
  const s = setup();
  const judge = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenA });
  assert.equal(judge.status, 200);
  assert.deepEqual(judge.json, { items: [] }, '列表端点没有记录是常态 ⇒ 200 + 空集');

  const admin = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenAdmin });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.json, { items: [] });
  teardown(s);
});

test('回避台账：普通登录用户（无任何能力点）只能看到自己的（空）清单，不是 403', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenOutsider });
  assert.equal(res.status, 200, '「登录即可读自己的」—— 不是「有权限才许读」');
  assert.deepEqual(res.json, { items: [] });
  teardown(s);
});

test('回避台账：未登录 → 401；赛段不存在 → 404', async () => {
  const s = setup();
  const anon = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`);
  assert.equal(anon.status, 401);

  const missing = await callJson(s.app, 'GET', '/api/stages/stage_nonexistent/recusals', { token: s.tokenA });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'STAGE_NOT_FOUND');
  teardown(s);
});

test('回避台账：撤销（reinstated）也进台账，status 标得出', async () => {
  const s = setup();
  await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA, body: { teamId: s.team1.id, reason: '前雇主' },
  });
  // ⛔ 撤销只能由组委会做（路由里的硬闸）
  const byJudge = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenA, body: { teamId: s.team1.id, reason: '误报', action: 'reinstated' },
  });
  assert.equal(byJudge.status, 403, '评委不得自己撤销自己申报的回避');

  const byAdmin = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/recusals`, {
    token: s.tokenAdmin, body: { judgeId: s.judgeA.id, teamId: s.team1.id, reason: '误报', action: 'reinstated' },
  });
  assert.equal(byAdmin.status, 200);

  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/recusals`, { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((x) => x.status).sort(), ['recused', 'reinstated']);
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 二、review-board 的三个「我已经交过哪些」
// ══════════════════════════════════════════════════════════════════

/** 让两支队都有「真实交付物」（互评资格的前置条件：已有人给它打过分）。 */
async function seedDeliverables(s, stageId) {
  for (const teamId of [s.team1.id, s.team2.id]) {
    const r = await callJson(s.app, 'POST', `/api/stages/${stageId}/reviews`, {
      token: s.tokenA,
      body: { items: [{ teamId, dimension: 'innovation', rawScore: 70 }] },
    });
    assert.equal(r.status, 200, `评委打分应当成功：${JSON.stringify(r.json)}`);
  }
}

test('review-board：myPeerReviews / mySelfReviews / myCalibrations **只含当前 viewer 自己的**', async () => {
  const s = setup();
  // ⚠️ 这一整组用例都在**决赛赛段**上做：决赛权重表同时有
  //    seat='judge'（innovation…）与 seat='self'（self_eval 自评测）两类维度。
  const stageId = s.finalStage.id;
  await seedDeliverables(s, stageId);

  // 评委甲（team1 成员）交互评（从 team1 → team2）
  const peer = await callJson(s.app, 'POST', `/api/stages/${stageId}/peer-reviews`, {
    token: s.tokenA,
    body: { items: [{ fromTeamId: s.team1.id, toTeamId: s.team2.id, score: 66 }] },
  });
  assert.equal(peer.status, 200, JSON.stringify(peer.json));

  // 评委甲为本队交自评
  const self = await callJson(s.app, 'POST', `/api/stages/${stageId}/self-review`, {
    token: s.tokenA,
    body: { teamId: s.team1.id, items: [{ dimension: 'self_eval', rawScore: 80 }] },
  });
  assert.equal(self.status, 200, JSON.stringify(self.json));

  // 评委甲交校准分（评委席维度）
  const cal = await callJson(s.app, 'POST', `/api/stages/${stageId}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'innovation', rawScore: 55 }] },
  });
  assert.equal(cal.status, 200, JSON.stringify(cal.json));

  const mine = await callJson(s.app, 'GET', `/api/stages/${stageId}/review-board`, { token: s.tokenA });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.myPeerReviews.length, 1);
  assert.equal(mine.json.myPeerReviews[0].fromTeamId, s.team1.id);
  assert.equal(mine.json.myPeerReviews[0].toTeamId, s.team2.id);
  assert.equal(mine.json.myPeerReviews[0].score, 66);
  assert.equal(mine.json.mySelfReviews.length, 1);
  assert.equal(mine.json.mySelfReviews[0].teamId, s.team1.id);
  assert.equal(mine.json.mySelfReviews[0].dimension, 'self_eval');
  assert.equal(mine.json.mySelfReviews[0].rawScore, 80);
  assert.equal(mine.json.myCalibrations.length, 1);
  assert.equal(mine.json.myCalibrations[0].dimension, 'innovation');
  assert.equal(mine.json.myCalibrations[0].rawScore, 55);

  // ⛔ 别人（评委乙，什么都没交）必须什么都看不到
  const other = await callJson(s.app, 'GET', `/api/stages/${stageId}/review-board`, { token: s.tokenB });
  assert.equal(other.status, 200);
  assert.deepEqual(other.json.myPeerReviews, [], '⛔ 别人的互评不许进我的清单');
  assert.deepEqual(other.json.mySelfReviews, []);
  assert.deepEqual(other.json.myCalibrations, []);

  // ⛔ 组委会也**只看自己的**（本轮不实现「看全部」）
  const admin = await callJson(s.app, 'GET', `/api/stages/${stageId}/review-board`, { token: s.tokenAdmin });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.json.myPeerReviews, [], '组委会看到的也是「自己的」，不是全赛段的');
  assert.deepEqual(admin.json.mySelfReviews, []);
  assert.deepEqual(admin.json.myCalibrations, []);
  teardown(s);
});

test('review-board：没交过时三个数组都是空数组（200，不是 404）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', `/api/stages/${s.stage.id}/review-board`, { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.myPeerReviews, []);
  assert.deepEqual(res.json.mySelfReviews, []);
  assert.deepEqual(res.json.myCalibrations, []);
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 三、校准分的维度白名单（与 POST /reviews 同口径）
// ══════════════════════════════════════════════════════════════════

test('⛔ 校准打分提交**非评委席维度** → 403（与 POST /reviews 同一错误码）', async () => {
  const s = setup();
  // ⚠️ 两个非评委席维度分别住在**两张权重表**里：
  //   'enterprise'（企业确认，seat='enterprise'）在初赛表；
  //   'self_eval'（自评测，seat='self'）**只在决赛表**（初赛表没有这个维度）。
  //   ⇒ 分两个赛段试，否则 'self_eval' 在初赛会被判「未知维度」（400）而不是「席位不对」（403）。
  const cases = [
    { stageId: s.stage.id, dimension: 'enterprise' },
    { stageId: s.finalStage.id, dimension: 'self_eval' },
  ];
  for (const { stageId, dimension } of cases) {
    const res = await callJson(s.app, 'POST', `/api/stages/${stageId}/calibration`, {
      token: s.tokenA, body: { items: [{ dimension, rawScore: 90 }] },
    });
    assert.equal(res.status, 403, `维度 ${dimension} 不该被校准入口接受`);
    assert.equal(res.json.error.code, 'DIMENSION_SEAT_FORBIDDEN');
  }
  // ⛔ 被拒的校准**不得落库**
  const rows = s.db.prepare('SELECT * FROM calibrations').all();
  assert.equal(rows.length, 0, '被拒绝的校准分不得写进 calibrations 表');
  teardown(s);
});

test('⛔ 校准与打分的维度闸门**同一口径**（同样 403 / 同样错误码）', async () => {
  const s = setup();
  const cal = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'enterprise', rawScore: 90 }] },
  });
  const review = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/reviews`, {
    token: s.tokenA, body: { items: [{ teamId: s.team1.id, dimension: 'enterprise', rawScore: 90 }] },
  });
  assert.equal(cal.status, review.status, '两个入口的状态码必须一致');
  assert.equal(cal.json.error.code, review.json.error.code, '两个入口的错误码必须一致');
  teardown(s);
});

test('校准打分提交**评委席维度** → 成功（且只落一条）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'innovation', rawScore: 60 }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.submitted, 1);
  const rows = s.db.prepare('SELECT * FROM calibrations WHERE stage_id = ? AND judge_id = ?')
    .all(s.stage.id, s.judgeA.id);
  assert.equal(rows.length, 1, '校准分必须真的落库');
  assert.equal(rows[0].dimension, 'innovation');
  assert.equal(rows[0].raw_score, 60);
  teardown(s);
});

test('⛔ 校准打分提交**未知维度** → 400 UNKNOWN_DIMENSION（与打分入口同口径）', async () => {
  const s = setup();
  const res = await callJson(s.app, 'POST', `/api/stages/${s.stage.id}/calibration`, {
    token: s.tokenA, body: { items: [{ dimension: 'not_a_dimension', rawScore: 60 }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'UNKNOWN_DIMENSION');
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 四、演示适配器：GET /api/teams 与正式站**同口径**
// ══════════════════════════════════════════════════════════════════

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const demoSeed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));

test('正式站：GET /api/teams 只返回「我参与的」队伍', async () => {
  const s = setup();
  const res = await callJson(s.app, 'GET', '/api/teams', { token: s.tokenA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((t) => t.id), [s.team1.id], '评委甲只在 team1 里');
  const others = await callJson(s.app, 'GET', '/api/teams', { token: s.tokenB });
  assert.deepEqual(others.json.items.map((t) => t.id), [s.team2.id], '评委乙只在 team2 里');
  teardown(s);
});

test('演示适配器：GET /api/teams **不得返回全部队伍**（与正式站同口径：只返回我参与的）', async () => {
  const { createDemoApi, demoMyTeams } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });

  const { items } = await api.get('/api/teams');
  assert.ok(Array.isArray(items), '形状必须是 { items: [...] }（与正式站一致）');
  assert.ok(
    items.length < demoSeed.teams.length,
    `⛔ 演示站不得返回全部 ${demoSeed.teams.length} 支队（正式站只返回我参与的），实际 ${items.length}`,
  );
  assert.deepEqual(items.map((t) => t.id), ['t_alpha'], '演示管理员的「我的战队」只有种子里的那一支');

  // ⚠️ **逐字段同口径**：以「演示队长（MBA）」的身份看 ⇒ 他的队伍 = 他当队长/当成员的那几支
  const state = { ...demoSeed, me: { id: 'mba_captain', teamId: null } };
  const mine = demoMyTeams(state).map((t) => t.id);
  assert.deepEqual(mine.sort(), ['t_alpha', 't_epsilon', 't_gamma']);
  assert.ok(!mine.includes('t_beta'), '不是他队的队伍不得出现');
  assert.ok(!mine.includes('t_delta'), '不是他队的队伍不得出现');
});

test('演示适配器与正式站：GET /api/teams 的**队伍视图形状**逐字段一致', async () => {
  const s = setup();
  const formal = await callJson(s.app, 'GET', '/api/teams', { token: s.tokenA });
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  const demo = await api.get('/api/teams');

  const keys = (t) => Object.keys(t).sort();
  assert.deepEqual(keys(demo.items[0]), keys(formal.json.items[0]), '两边的字段集合必须一致');
  assert.ok(Array.isArray(demo.items[0].members));
  assert.ok(demo.items[0].members[0].userId, '成员必须带 userId');
  assert.ok(['captain', 'member'].includes(demo.items[0].members[0].role));
  teardown(s);
});

// ══════════════════════════════════════════════════════════════════
// 五、演示适配器：评委前置的**五个端点**都得在（缺一个 ⇒ 演示站是错误态）
// ══════════════════════════════════════════════════════════════════

test('演示适配器：评委前置的五个端点都已实现（⛔ 不是 DEMO_ENDPOINT_MISSING）', async () => {
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  const stage = 'stage_final';

  const calls = [
    ['get', `/api/stages/${stage}/recusals`, null],
    ['post', `/api/stages/${stage}/recusals`, { teamId: 't_alpha', reason: '演示：我是该队的供应方' }],
    ['post', `/api/stages/${stage}/peer-reviews`, {
      items: [{ fromTeamId: 't_alpha', toTeamId: 't_beta', score: 70 }],
    }],
    ['post', `/api/stages/${stage}/self-review`, {
      teamId: 't_alpha', items: [{ dimension: 'self_eval', rawScore: 80 }],
    }],
    ['post', `/api/stages/${stage}/calibration`, { items: [{ dimension: 'innovation', rawScore: 60 }] }],
  ];
  for (const [verb, path, body] of calls) {
    await assert.doesNotReject(
      () => api[verb](path, body ?? undefined),
      (e) => {
        assert.notEqual(e.code, 'DEMO_ENDPOINT_MISSING', `演示站未实现 ${verb.toUpperCase()} ${path}`);
        return true;
      },
    );
  }
});

test('演示适配器：评委前置的端点**形状**与正式站一致', async () => {
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  const stage = 'stage_final';

  // ① 回避台账读口：{ items: [...] }，字段与正式站 getRecusalLedger 一致
  const empty = await api.get(`/api/stages/${stage}/recusals`);
  assert.deepEqual(Object.keys(empty).sort(), ['items'], '必须是 { items } 一个键');
  assert.deepEqual(empty.items, [], '没有记录时是空集');

  const created = await api.post(`/api/stages/${stage}/recusals`, {
    teamId: 't_alpha', reason: '演示：供应方',
  });
  assert.ok(created.id, 'POST 返回数据库原始行（带 id）');
  assert.equal(created.stage_id, stage);
  assert.equal(created.team_id, 't_alpha');
  assert.equal(created.reason, '演示：供应方');
  assert.equal(created.action, 'recused');

  const ledger = await api.get(`/api/stages/${stage}/recusals`);
  assert.equal(ledger.items.length, 1);
  assert.deepEqual(
    Object.keys(ledger.items[0]).sort(),
    ['auditBy', 'createdAt', 'id', 'judgeId', 'judgeName', 'reason', 'source', 'stageId', 'status', 'teamId', 'teamName'],
  );
  assert.equal(ledger.items[0].teamName, '拾光队', '必须带队伍名（人读要用）');
  assert.equal(ledger.items[0].status, 'recused');

  // ② 互评：{ stageId, submitted, items }
  const peer = await api.post(`/api/stages/${stage}/peer-reviews`, {
    items: [{ fromTeamId: 't_alpha', toTeamId: 't_beta', score: 70 }],
  });
  assert.deepEqual(Object.keys(peer).sort(), ['items', 'stageId', 'submitted']);
  assert.equal(peer.submitted, 1);
  assert.equal(peer.items[0].from_team_id, 't_alpha');
  assert.equal(peer.items[0].to_team_id, 't_beta');
  assert.equal(peer.items[0].score, 70);

  // ③ 自评：{ stageId, teamId, submitted, items }
  const self = await api.post(`/api/stages/${stage}/self-review`, {
    teamId: 't_alpha', items: [{ dimension: 'self_eval', rawScore: 80 }],
  });
  assert.deepEqual(Object.keys(self).sort(), ['items', 'stageId', 'submitted', 'teamId']);
  assert.equal(self.items[0].dimension, 'self_eval');
  assert.equal(self.items[0].raw_score, 80);

  // ④ 校准：{ stageId, judgeId, submitted }
  const cal = await api.post(`/api/stages/${stage}/calibration`, {
    items: [{ dimension: 'innovation', rawScore: 60 }],
  });
  assert.deepEqual(Object.keys(cal).sort(), ['judgeId', 'stageId', 'submitted']);
  assert.equal(cal.submitted, 1);

  // ⑤ review-board 带上三个「我已经交过哪些」（与正式站同名字段）
  const board = await api.get(`/api/stages/${stage}/review-board`);
  assert.ok(Array.isArray(board.myPeerReviews));
  assert.ok(Array.isArray(board.mySelfReviews));
  assert.ok(Array.isArray(board.myCalibrations));
  assert.deepEqual(Object.keys(board.myPeerReviews[0]).sort(), ['fromTeamId', 'score', 'toTeamId']);
  assert.deepEqual(Object.keys(board.mySelfReviews[0]).sort(), ['dimension', 'rawScore', 'teamId']);
  assert.deepEqual(Object.keys(board.myCalibrations[0]).sort(), ['dimension', 'rawScore']);
});

test('演示适配器：校准的**维度白名单**与正式站同码（非评委席 → 403 DIMENSION_SEAT_FORBIDDEN）', async () => {
  const { createDemoApi } = await import('../web/api.demo.js');
  const { rules } = loadRules(rulesDir);
  const api = createDemoApi({ storage: makeStorage(), seed: demoSeed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  await assert.rejects(
    () => api.post('/api/stages/stage_final/calibration', { items: [{ dimension: 'enterprise', rawScore: 90 }] }),
    (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, 'DIMENSION_SEAT_FORBIDDEN');
      return true;
    },
  );
  await assert.rejects(
    () => api.post('/api/stages/stage_final/calibration', { items: [{ dimension: 'self_eval', rawScore: 90 }] }),
    (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, 'DIMENSION_SEAT_FORBIDDEN');
      return true;
    },
  );
});
```

### 报名类申诉后端（DP-106）

`platform/test/appeals-registration.test.js`：报名类申诉后端（DP-106）

```javascript
// platform/test/appeals-registration.test.js —— 报名类申诉（DP-106）
//
// 规则溯源：
//   - 「R-REG-08：分级不接收时选手可向组委会提交申诉」→ 设计文档 §9「组委会视角 → 复核/申诉/改级」
//     与 web/views/registration.js 的选手侧申诉面板（POST /api/appeals，body = { subjectType, subjectId, reason }）。
//   - 「终态裁定不可被选手改写」→ src/services/registration.js 的 decideRegistration 注释
//     （2026-10-21 独立评审 Minor M-4 的修正）：委员会已裁定（accepted / rejected）的报名，选手不能申诉。
//   - 「三态状态码：列表 200 + 空集 / 单条 404 / 禁用 403」→ 设计文档 §8。
//   - 「可见性与授权在 API 层裁决」→ 全局约束：listAppeals 对无 audit:read 的人返空集，**不得放宽**。
//
// ⚠️ 本文件测的是**服务层**（src/services/review-state.js）的行为，
//    断言一律打在**数据库真实状态 / 返回值**上 ——
//    不写「文件里有某个字符串」那种会被无关代码顶替的形式。
//
// ⚠️ 夹具用**真实的用户 / 届期 / 报名行**（本仓有外键约束：audit_log.actor_id、appeals.filed_by、
//    registration_events.actor_id 都 REFERENCES users(id)；tier_records.team_id REFERENCES teams(id)）
//    ⇒ 用假 id 会被 DB 直接拒绝（外键失败），不是断言失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import {
  getRegistration as findRegistrationRow, updateRegistrationRow,
} from '../src/db/repo/registrations.js';
import { listRegistrationEvents } from '../src/db/repo/registrationEvents.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';
import { submitRegistration, decideRegistration } from '../src/services/registration.js';
import {
  fileAppeal, decideAppeal, listAppeals, transition,
} from '../src/services/review-state.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

const NOW = '2026-10-23T02:00:00.000Z';
const APPEAL_NOW = '2026-10-23T03:00:00.000Z';
const DECIDE_NOW = '2026-10-23T04:00:00.000Z';

/** 低分问卷 ⇒ C 级 ⇒ **不接收**（grading.accepted === false）—— 选手侧申诉入口的出现条件。 */
const LOW = {
  direction: [1, 1, 1, 1, 1],
  capability: [1, 1, 1, 1, 1],
  collaboration: [1, 1, 1, 1, 1],
  open: '我的方向还在探索中',
  consent: { accepted: true, items: [] },
};

/** 高分问卷 ⇒ S 级 ⇒ 接收（对照组：接收的人没有申诉理由）。 */
const HIGH = {
  direction: [4, 4, 4, 4, 4],
  capability: [4, 4, 4, 4, 4],
  collaboration: [4, 4, 4, 4, 4],
  open: '我想解决门店排班问题',
  consent: { accepted: true, items: ['no_data_export'] },
};

const RULES = {
  audit: {
    reviewState: { appealSubjectType: 'team_result', appealAllowedTiers: ['D'] },
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-appeal-reg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  // 能力点 / 角色 / 角色能力（走仓储层，不写裸 SQL —— 全局约束「SQL 只在 src/db/repo/」）
  const CAPS = [
    ['registration:review', '复核报名分级'],
    ['audit:read', '读取审计与申诉队列'],
    ['audit:write', '裁决申诉与复核项'],
    ['appeal:write', '提交申诉'],
  ];
  for (const [k, d] of CAPS) insertCapability(db, k, d);
  insertRole(db, 'admin', '组委会');
  for (const [k] of CAPS) insertRoleCapability(db, 'admin', k);

  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const player = createUser(db, { name: '甲', phone: '13900003001', password: 'pw', mbaStatus: 'mba' });
  const other = createUser(db, { name: '乙', phone: '13900003002', password: 'pw', mbaStatus: 'mba' });
  const committee = createUser(db, { name: '组委会', phone: '13900003003', password: 'pw', mbaStatus: 'mba' });
  insertUserRole(db, committee.id, 'admin');

  return { db, close, dataDir, rules, edition, player, other, committee };
}

/** 造一条**不接收**的报名（C 级，status 仍是 submitted —— 尚未进终态裁定）。 */
function fileLowRegistration({ db, rules, edition, user, now = NOW }) {
  return submitRegistration({
    db, userId: user.id, editionId: edition.id, answers: LOW, now, rules,
  });
}

// ══════════════════════════════════════════════════════════════════
// 一、提交：本人可申诉自己的报名
// ══════════════════════════════════════════════════════════════════

test('报名类申诉：选手能对自己的**未接收**报名提交申诉（落一条 subject_type=registration 的记录）', () => {
  const { db, close, dataDir, rules, edition, player } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  assert.equal(reg.grading.accepted, false, '前置：这条报名是不接收的');

  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '能力维有未提交的佐证材料，请复核', now: APPEAL_NOW, rules: RULES,
  });
  assert.equal(appeal.subject_type, 'registration', '必须是报名类申诉');
  assert.equal(appeal.subject_id, reg.id, 'subject_id 存**报名 id 原样**（不加前缀）');
  assert.equal(appeal.filed_by, player.id);
  assert.equal(appeal.reason, '能力维有未提交的佐证材料，请复核');
  assert.equal(appeal.status, 'submitted', '新提的申诉是待裁决');
  assert.equal(appeal.decided_by, null);

  // 审计留痕：申诉进了队列就要能复盘
  const { rows } = queryAuditLog(db, { action: 'appeal.filed' });
  assert.equal(rows.length, 1, '提交一次写一条审计日志');
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.subjectType, 'registration');
  assert.equal(detail.subjectId, reg.id);
  assert.equal(detail.onBehalf, false, '本人提交 ⇒ 不是代提交');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 二、提交：三类拒绝（403 / 404 / 409）
// ══════════════════════════════════════════════════════════════════

test('报名类申诉：不能申诉**别人的**报名 ⇒ 403（且不得留下任何记录）', () => {
  const { db, close, dataDir, rules, edition, player, other } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: other.id,
      reason: '这不是我的报名', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 403,
  );
  const list = listAppeals({
    db, filter: {}, viewer: { id: player.id, is_superadmin: 1, active: 1 },
  });
  assert.equal(list.total, 0, '被拒的申诉不得落库');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：报名不存在 ⇒ 404', () => {
  const { db, close, dataDir, rules, player } = setup();
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: 'reg_not_exist_at_all', filedBy: player.id,
      reason: '不存在的报名', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 404 && /报名记录不存在/.test(e.message),
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：已终态裁定（accepted / rejected）的报名 ⇒ 409（不可申诉）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  // 委员会改级 ⇒ status 落到终态（accepted / rejected）
  decideRegistration({
    db, id: reg.id, level: 'C', decidedBy: committee.id, note: '复核不通过', now: NOW, rules,
  });
  const row = findRegistrationRow(db, reg.id);
  assert.equal(row.status, 'rejected', '前置：委员会已裁定为终态');
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
      reason: '终态之后不服', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 409 && /裁定/.test(e.message),
  );

  // 另一条：accepted 也是终态 ⇒ 同样 409
  // ⚠️ 同一 userId + editionId 只能有一条有效报名（部分唯一索引）⇒ 换一届期造第二条。
  const edition2 = createEdition(db, {
    name: '第二届', city: '上海', startsAt: '2026-11-01', endsAt: '2026-11-30', now: NOW,
  });
  const reg2 = submitRegistration({
    db, userId: player.id, editionId: edition2.id, answers: LOW, now: NOW, rules,
  });
  decideRegistration({
    db, id: reg2.id, level: 'B', decidedBy: committee.id, note: '复核通过', now: NOW, rules,
  });
  assert.equal(findRegistrationRow(db, reg2.id).status, 'accepted', '前置：这条落在 accepted 终态');
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg2.id, filedBy: player.id,
      reason: '终态之后不服', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：同一报名重复提交未裁决的申诉 ⇒ 409（防重复）', () => {
  const { db, close, dataDir, rules, edition, player } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '第一次申诉', now: APPEAL_NOW, rules: RULES,
  });
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
      reason: '再提一次', now: '2026-10-23T03:30:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  const list = listAppeals({
    db, filter: {}, viewer: { id: player.id, is_superadmin: 1, active: 1 },
  });
  assert.equal(list.total, 1, '重复提交不得产生第二条申诉');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：空理由 ⇒ 400（服务层也必须挡，不能只靠前端）', () => {
  const { db, close, dataDir, rules, edition, player } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
      reason: '   ', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 400,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：组委会代提交允许，且**必须留痕**（detail.onBehalf = true）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: committee.id,
    reason: '组委会代为提交', now: APPEAL_NOW, rules: RULES,
  });
  assert.equal(appeal.filed_by, committee.id);
  const { rows } = queryAuditLog(db, { action: 'appeal.filed' });
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.onBehalf, true, '代提交必须留痕（否则复盘分不清是谁提的）');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 三、裁决：成立 / 驳回
// ══════════════════════════════════════════════════════════════════

test('报名类申诉**裁决成立** ⇒ 撤销分级裁定（level_final 清空 / status 回到 submitted）且**不触发赛段重算**', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  // ⚠️ 夹具：把 level_final 置上、status 留在**非终态**（模拟「已改级但还没落终态」的报名行）
  //    ⇒ 这样「裁决成立 ⇒ 清空 level_final」才是**可观测的**（不是空操作）。
  updateRegistrationRow(db, reg.id, { level_final: 'C', status: 'submitted' });

  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'accepted', decidedBy: committee.id,
    note: '成立，退回待复核重新分级', now: DECIDE_NOW, rules: RULES,
  });

  // ① 报名行真的被改了（数据库真实状态，不是返回值）
  const after = findRegistrationRow(db, reg.id);
  assert.equal(after.level_final, null, '分级裁定必须被撤销（level_final 置 NULL）');
  assert.equal(after.status, 'submitted', '必须回到待委员会重新分级');
  // ② 没有触发赛段重算
  assert.equal(out.recomputeRequired, false, '报名类申诉不涉及赛段分数 ⇒ 不得要求重算');
  assert.deepEqual(out.transitions, [], '报名类申诉不得产生赛段状态迁移');
  // ③ 事件轨迹留痕（追加式）
  const events = listRegistrationEvents(db, reg.id);
  const last = events[events.length - 1];
  assert.equal(last.to_status, 'submitted');
  assert.equal(last.reason, '成立，退回待复核重新分级', '裁决说明必须落进事件轨迹');
  assert.equal(last.actor_id, committee.id, '裁决人必须落库（谁裁决的要能追责）');
  // ④ 申诉行本身被裁决
  assert.equal(out.appeal.status, 'accepted');
  assert.equal(out.appeal.decided_by, committee.id);
  assert.equal(out.appeal.decision_note, '成立，退回待复核重新分级');
  assert.equal(out.appeal.decided_at, DECIDE_NOW);
  // ⑤ 审计日志：recomputeRequired 也要是 false
  const { rows } = queryAuditLog(db, { action: 'appeal.decided' });
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.recomputeRequired, false, '审计日志里的重算标志必须与返回值一致');
  assert.equal(detail.subjectType, 'registration');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉**裁决驳回** ⇒ 报名**不动**（只留痕）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  updateRegistrationRow(db, reg.id, { level_final: 'C', status: 'submitted' });
  const before = findRegistrationRow(db, reg.id);

  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'rejected', decidedBy: committee.id,
    note: '证据不足，维持原判', now: DECIDE_NOW, rules: RULES,
  });

  const after = findRegistrationRow(db, reg.id);
  assert.equal(after.level_final, before.level_final, '驳回不得改分级裁定');
  assert.equal(after.status, before.status, '驳回不得改报名状态');
  assert.equal(out.recomputeRequired, false);
  assert.deepEqual(out.transitions, []);
  // 只留痕：申诉行 + 审计日志
  assert.equal(out.appeal.status, 'rejected');
  assert.equal(out.appeal.decided_by, committee.id);
  assert.equal(out.appeal.decision_note, '证据不足，维持原判');
  const { rows } = queryAuditLog(db, { action: 'appeal.decided' });
  assert.equal(rows.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('报名类申诉：已裁决的申诉不得二次裁决 ⇒ 409', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  const appeal = fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  decideAppeal({
    db, appealId: appeal.id, decision: 'rejected', decidedBy: committee.id,
    note: '维持原判', now: DECIDE_NOW, rules: RULES,
  });
  assert.throws(
    () => decideAppeal({
      db, appealId: appeal.id, decision: 'accepted', decidedBy: committee.id,
      note: '再改一次', now: '2026-10-23T05:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 四、原路径没被改坏（赛段结果类申诉）
// ══════════════════════════════════════════════════════════════════

/** 造一条赛段结果类申诉要用的夹具：队伍 + D 段位 + 已 FINALIZED 的赛段。 */
function seedTeamResult(db) {
  db.prepare(
    `INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
     VALUES ('u_captain','甲队队长','13900000988','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
     VALUES ('t1','ed_team','甲队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES ('tr_t1','t1','D',0,0,'[]','2026-10-20T00:00:00.000Z',NULL)`,
  ).run();
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_captain', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
}

test('原路径没被改坏：赛段结果类申诉（team_result）仍按原口径走 —— 成立 = 撤销终稿 + 要求重算', () => {
  const { db, close, dataDir } = setup();
  // teams.edition_id / tier_records 的外键要有着落 ⇒ 补一条届期
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('ed_team','届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z')`,
  ).run();
  seedTeamResult(db);

  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: APPEAL_NOW, rules: RULES,
  });
  assert.equal(appeal.subject_type, 'team_result');
  assert.equal(appeal.subject_id, 'st1:t1');

  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'accepted', decidedBy: 'u_captain',
    note: '成立，重算', now: DECIDE_NOW, rules: RULES,
  });
  assert.equal(out.recomputeRequired, true, '赛段结果类成立仍必须要求重算');
  assert.deepEqual(
    out.transitions.map((t) => t.to), ['REJECTED', 'PENDING_REVIEW'],
    '赛段结果类成立仍走「撤销终稿 → 重新复核」',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('原路径没被改坏：赛段结果类申诉的原有前置校验仍在（未 FINALIZED / 档位不在可申诉档 ⇒ 409 / 403）', () => {
  const { db, close, dataDir } = setup();
  db.prepare(
    `INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
     VALUES ('ed_team','届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z')`,
  ).run();
  seedTeamResult(db);
  // 未 FINALIZED 的条目 ⇒ 409
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st2:t1', filedBy: 'u_captain',
      reason: '还没定稿', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 409,
  );
  // 档位不在 appealAllowedTiers（D）⇒ 403
  // ⚠️ 顺序要紧：tier_records.team_id REFERENCES teams(id) ⇒ 先有队伍再有段位记录。
  db.prepare(
    `INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
     VALUES ('t2','ed_team','乙队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES ('tr_t2','t2','B',0,0,'[]','2026-10-20T00:00:00.000Z',NULL)`,
  ).run();
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t2', filedBy: 'u_captain',
      reason: 'B 档也要申诉', now: APPEAL_NOW, rules: RULES,
    }),
    (e) => e.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 五、可见性（没被放宽）
// ══════════════════════════════════════════════════════════════════

test('申诉列表：无 audit:read 的人仍拿到**空集**（可见性没被放宽）', () => {
  const { db, close, dataDir, rules, edition, player, committee } = setup();
  const reg = fileLowRegistration({ db, rules, edition, user: player });
  fileAppeal({
    db, subjectType: 'registration', subjectId: reg.id, filedBy: player.id,
    reason: '复核我的能力维', now: APPEAL_NOW, rules: RULES,
  });
  // 选手本人没有 audit:read ⇒ 空集（选手在报名结果页看不到别人的申诉，这是对的）
  const denied = listAppeals({ db, filter: {}, viewer: player });
  assert.deepEqual(denied.rows, []);
  assert.equal(denied.total, 0);
  // 组委会（有 audit:read）看得到，且字段名与正式站口径一致
  const allowed = listAppeals({ db, filter: {}, viewer: committee });
  assert.equal(allowed.total, 1);
  assert.deepEqual(
    Object.keys(allowed.rows[0]).sort(),
    ['createdAt', 'decidedAt', 'decidedBy', 'decisionNote', 'filedBy', 'id', 'reason', 'status', 'subjectId', 'subjectType'],
    '列表行的字段名必须与正式站口径逐字一致',
  );
  assert.equal(allowed.rows[0].subjectType, 'registration');
  assert.equal(allowed.rows[0].subjectId, reg.id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// 六、演示适配器（公网演示站）补齐 /api/appeals
// ══════════════════════════════════════════════════════════════════
//
// ⚠️ P9 教训：演示站与正式站的**形状**必须逐字一致 —— 演示适配器此前**完全没有**
//    /api/appeals ⇒ 公网演示站的「申诉裁决」页是错误态（端点未实现）。

function makeMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('演示适配器：申诉三端点齐全（列表 / 提交 / 裁决），形状与正式站逐字一致', async () => {
  const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(rulesDir);
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeMemoryStorage(), seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });

  // 演示站先造一条报名（演示适配器的报名存在本地状态里）
  const reg = await api.post('/api/registrations', {
    editionId: 'ed_demo',
    answers: {
      direction: [1, 1, 1, 1, 1],
      capability: [1, 1, 1, 1, 1],
      collaboration: [1, 1, 1, 1, 1],
      open: '演示报名',
      consent: { accepted: true },
    },
  });
  assert.ok(reg?.id, '演示站要有报名');

  // ① 提交
  const appeal = await api.post('/api/appeals', {
    subjectType: 'registration', subjectId: reg.id, reason: '演示：复核我的能力维',
  });
  assert.equal(appeal.subjectType, 'registration');
  assert.equal(appeal.subjectId, reg.id);
  assert.equal(appeal.status, 'submitted');

  // ② 列表：字段名与正式站口径逐字一致
  const list = await api.get('/api/appeals');
  assert.equal(list.total, 1);
  assert.deepEqual(
    Object.keys(list.rows[0]).sort(),
    ['createdAt', 'decidedAt', 'decidedBy', 'decisionNote', 'filedBy', 'id', 'reason', 'status', 'subjectId', 'subjectType'],
    '演示站的申诉行字段名必须与正式站一致（P9 教训：不能另写一份形状）',
  );

  // ③ 裁决：更新本地状态并返回（报名类成立 ⇒ 撤销分级裁定、回到待复核、不重算）
  const out = await api.post(`/api/appeals/${appeal.id}/decide`, {
    decision: 'accepted', note: '成立，退回待复核',
  });
  assert.equal(out.appeal.status, 'accepted');
  assert.equal(out.appeal.decidedBy, 'demo_admin');
  assert.ok(out.appeal.decidedAt, '必须记裁决时间');
  assert.equal(out.appeal.decisionNote, '成立，退回待复核');
  assert.equal(out.recomputeRequired, false, '报名类申诉不触发赛段重算');
  assert.deepEqual(out.transitions, []);
  const after = (await api.get('/api/registrations')).items.find((r) => r.id === reg.id);
  assert.equal(after.status, 'submitted', '裁决成立 ⇒ 报名回到待复核');
  assert.equal(after.levelFinal, null, '裁决成立 ⇒ 分级裁定被撤销');

  // ④ 空理由 ⇒ 400（与正式站同一口径）
  await assert.rejects(
    () => api.post('/api/appeals', { subjectType: 'registration', subjectId: reg.id, reason: '  ' }),
    (e) => e.status === 400,
  );
});
```

### 降级告警的「人话 / 内部明细」两层（DP-107）

`platform/test/warning-wording.test.js`：降级告警的「人话 / 内部明细」两层（DP-107）

```javascript
// platform/test/warning-wording.test.js —— 降级告警的「人话 / 内部明细」两层
//
// 规则溯源：
//   - S-5 / C-05「降级必须显式展示，不静默」⇒ 告警**一条都不许少**（本文件钉住数量）。
//   - 「可见性在 API 层裁决」（设计文档 §6.6 + src/domain/visibility.js 头注释）⇒
//     公开端点的内部明细由**后端**裁剪，前端不许自己判断权限。
//   - 文案分层（2026-10-23）：`message` 只给人读（禁止英文维度键 / 队伍 id /
//     评委 id / 内部原因码 / 浮点噪声），`detail` 是内部明细（只给 audit:read 的人看），
//     `code` 是**内部规则键**（2026-10-28 E184 起，**公开响应与公开界面都不许出现**）。
//
// ⚠️ **E184（2026-10-28）：本文件有三处断言被改写** —— 不是「改测试迁就实现」，
//    是**旧断言把错的契约钉成了规格**：
//    旧断言①「`html.includes('normalization_fallback')` 必须为 true」
//    旧断言②「`code` 必须保留在公开响应里」
//    旧断言③「`warn__code` 标签照常渲染」
//    ⇒ 三条都在说「内部规则键必须出现在公开页 / 公开响应里」⇒ 那是**缺陷本身**，不是规格。
//    ⇒ 新断言更强：不是「这几个码不许出现」，而是「**领域层产出的每一个码都不许出现**」
//      （清单从源码实时抽 ⇒ 新加的码自动进清单 ⇒ 漏一个就红）。
//
// ⚠️ 全部是**行为断言**：断言真实返回值（领域层输出 / HTTP 响应体 / 渲染出的 HTML），
//    不是「源码里有某个字符串」—— 那种断言会被无关代码顶替。
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyVisibility } from '../src/domain/visibility.js';
import { leaderboardHtml } from '../web/views/leaderboard.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-20T00:00:00.000Z';

// ══════════════════════════════════════════════════════════════════
// 一、领域层夹具（真实 rules/scoring-final.json —— 维度中文名取自 config.dimensions[].name）
// ══════════════════════════════════════════════════════════════════

/**
 * 真实外键口径的领域层夹具：
 *   - 评委 j1 在「技术可行性」上给两支队打分 ⇒ 样本数 2 < 5 ⇒ 触发归一化降级
 *   - t_a 的自评（54.8）比评委分（70）低 15.200000000000003 分 ⇒ 触发「评委须提问」
 *   - 其余维度没有分 ⇒ 触发 dimension_no_scores
 */
function scoreFixture() {
  const { rules } = loadRules(join(here, '..', 'rules'));
  const config = rules.scoring.final;
  const out = scoreStage({
    config,
    judges: [{ judgeId: 'j1', seat: 'judge' }],
    submissions: [
      { judgeId: 'j1', teamId: 't_a', dimension: 'feasibility', rawScore: 70 },
      { judgeId: 'j1', teamId: 't_b', dimension: 'feasibility', rawScore: 62 },
    ],
    enterpriseConfirmations: [],
    peerReviews: [],
    teams: [
      { teamId: 't_a', packageEnterpriseId: 'e_1', isFreeBrief: false },
      { teamId: 't_b', packageEnterpriseId: 'e_1', isFreeBrief: false },
    ],
    selfReviews: [{ teamId: 't_a', dimension: 'feasibility', rawScore: 54.8 }],
  });
  return { config, out };
}

test('★ normalization_fallback：正文只给人话（评委 id / 内部原因码 / 英文维度键都进 detail）', () => {
  const { out } = scoreFixture();
  const w = out.warnings.find((x) => x.code === 'normalization_fallback');
  assert.ok(w, `必须出现 normalization_fallback，实际：${JSON.stringify(out.warnings.map((x) => x.code))}`);
  // ⛔ 正文里不许出现评委 id
  assert.ok(!w.message.includes('j1'), `正文出现评委 id：${w.message}`);
  // ⛔ 正文里不许出现内部原因码
  assert.ok(!w.message.includes('judge_sample_too_small'), `正文出现内部原因码：${w.message}`);
  assert.ok(!w.message.includes(':'), `正文里不该出现「评委 id : 原因码」这种内部拼接：${w.message}`);
  // ⛔ 正文里不许出现原始维度键（作为裸词）
  assert.ok(!w.message.includes('feasibility'), `正文出现英文维度键：${w.message}`);
  // ✅ 正文用中文维度名
  assert.ok(w.message.includes('技术可行性'), `正文必须用中文维度名：${w.message}`);
  // ✅ 内部明细挪进 detail
  assert.ok(w.detail, 'detail 必须带内部明细');
  assert.ok(w.detail.includes('j1') && w.detail.includes('judge_sample_too_small'),
    `detail 必须带评委 id 与原因码：${w.detail}`);
  // ✅ code 保留（机器判据）
  assert.equal(w.code, 'normalization_fallback');
});

test('★ self_eval_judge_question：正文不得带浮点噪声（15.200000000000003 ⇒ 15.2）', () => {
  const { out } = scoreFixture();
  const w = out.warnings.find((x) => x.code === 'self_eval_judge_question');
  assert.ok(w, `必须出现 self_eval_judge_question，实际：${JSON.stringify(out.warnings.map((x) => x.code))}`);
  assert.ok(!w.message.includes('0000003'), `正文带浮点噪声：${w.message}`);
  assert.ok(!w.message.includes('15.200000000000003'), `正文带浮点噪声：${w.message}`);
  assert.ok(w.message.includes('15.2'), `正文必须带四舍五入后的分差：${w.message}`);
  assert.ok(!/15\.2\d{3,}/.test(w.message), `正文带浮点噪声：${w.message}`);
});

test('★ dimension_no_scores：正文不许出现队伍 id 与英文维度键（挪进 detail）', () => {
  const { out } = scoreFixture();
  const list = out.warnings.filter((x) => x.code === 'dimension_no_scores');
  assert.ok(list.length > 0, '必须出现 dimension_no_scores');
  for (const w of list) {
    assert.ok(!w.message.includes(w.teamId), `正文出现队伍 id：${w.message}`);
    assert.ok(!w.message.includes(w.dimension), `正文出现英文维度键：${w.message}`);
    assert.ok(w.detail && w.detail.includes(w.teamId) && w.detail.includes(w.dimension),
      `detail 必须带队伍 id 与维度键：${w.detail}`);
  }
});

test('★ detail 存在时不得出现在 message 里（两层不许互相污染）', () => {
  const { out } = scoreFixture();
  const withDetail = out.warnings.filter((w) => w.detail);
  assert.ok(withDetail.length > 0, '夹具必须产出带 detail 的告警');
  // 说明性单词不是内部标识，不参与判据
  const STOPWORDS = new Set(['id', 'dim']);
  for (const w of withDetail) {
    assert.ok(!w.message.includes(w.detail), `message 里混进了 detail：${w.message}`);
    // detail 里的 ASCII 标识符（队伍 id / 维度键 / 评委 id / 原因码）不得出现在正文
    const ids = String(w.detail).match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
    for (const id of ids) {
      if (STOPWORDS.has(id.toLowerCase())) continue;
      assert.ok(!w.message.includes(id), `message 里混进了 detail 的标识符「${id}」：${w.message}`);
    }
  }
});

test('★ 告警一条都没少：分层只改文案，不许把告警藏了（S-5 / C-05）', () => {
  const { out } = scoreFixture();
  const byCode = {};
  for (const w of out.warnings) byCode[w.code] = (byCode[w.code] ?? 0) + 1;
  assert.equal(out.warnings.length, 11, `告警总数变了：${JSON.stringify(byCode)}`);
  assert.equal(byCode.normalization_fallback, 1, '归一化降级告警必须仍在');
  assert.equal(byCode.self_eval_judge_question, 1, '自评差异告警必须仍在');
  assert.equal(byCode.dimension_no_scores, 7, '缺分维度告警必须仍在');
  assert.equal(byCode.no_enterprise_confirmation, 2, '企业确认告警必须仍在');
});

// ══════════════════════════════════════════════════════════════════
// 二、公开端点：内部明细的可见性在 API 层裁决
// ══════════════════════════════════════════════════════════════════

/** 快照里的告警（形状 = 现在的分层形状：code + message + detail + 原有字段） */
const SNAPSHOT_WARNINGS = [
  {
    code: 'normalization_fallback',
    message: '维度「技术可行性」的评委宽严归一化已降级 —— 本维度未按评委宽严做校正',
    detail: '降级明细（评委 id : 原因码）：j1:judge_sample_too_small',
    dimension: 'feasibility',
  },
  {
    code: 'dimension_no_scores',
    message: '有队伍在「自评测」维度上没有任何评分，该维度权重记 0',
    detail: '队伍 t_a / 维度 self_eval',
    teamId: 't_a',
    dimension: 'self_eval',
  },
  {
    code: 'R2_missing_dual_signature',
    message: '企业确认缺双签（出题企业签字 / 跨领域评委签字），该项按 0 分计',
    detail: '队伍 t_b',
    teamId: 't_b',
  },
];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-warn-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_auditor','审计员','13800000010','x','mba',NULL,0,1,'${NOW}'),
           ('u_cap','A队队长','13800000011','x','mba',NULL,0,1,'${NOW}'),
           ('u_cap2','B队队长','13800000013','x','mba',NULL,0,1,'${NOW}'),
           ('u_out','外部访客','13800000012','x','other',NULL,0,1,'${NOW}');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','${NOW}');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at)
    VALUES ('tp_1','ed_1','e_1','某某公司','任务一','痛点一','交付物一','验收一','A','approved',10,'A','试点承诺','承诺书',0,'u_cap','${NOW}');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at)
    VALUES ('t_a','ed_1','A队','u_cap','tp_1','A','active','${NOW}'),
           ('t_b','ed_1','B队','u_cap2','tp_1','A','active','${NOW}');
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES ('tm_1','t_a','u_cap','captain','${NOW}'), ('tm_2','t_b','u_cap2','captain','${NOW}');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1','st_1','t_a',1,90,88,95,0,10,NULL,'${NOW}'),
           ('sr_2','st_1','t_b',2,80,80,0,0,8,NULL,'${NOW}');
  `);
  // 能力点与授权（SQL 在仓储层；授权走 can() 的唯一入口 grantAssignment）
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  grantAssignment(db, {
    userId: 'u_auditor', capability: 'audit:read', scopeType: 'global', scopeId: null, grantedBy: 'u_auditor',
  });
  // 计算快照：告警的来源（P2 写、P3 读）
  db.prepare(
    `INSERT INTO computation_snapshots (id, kind, edition_id, stage_id, team_id, rule_version,
      input_json, output_json, trace_json, revision, created_at)
     VALUES ('cs_1','stage_score','ed_1','st_1',NULL,'scoring-final@2026-10-20','{}',?,'{}',1,?)`,
  ).run(JSON.stringify({ warnings: SNAPSHOT_WARNINGS }), NOW);

  const { rules } = loadRules(join(here, '..', 'rules'));
  const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
  return { db, close, dataDir, app };
}

const sessionToken = (db, userId) => createSession(db, userId, { ttlDays: 7, now: new Date(NOW) }).token;

test('★ 公开端点（滚动总榜 / 赛段榜）：匿名与普通用户拿不到 detail，有 audit:read 的人才拿得到', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    const paths = ['/api/leaderboard/rolling?editionId=ed_1', '/api/leaderboard/st_1?scope=rank'];

    for (const path of paths) {
      // ① 匿名访客
      const anon = await callJson(app, 'GET', path);
      assert.equal(anon.status, 200, `${path} 匿名访问应成功`);
      assert.equal(anon.json.warnings.length, SNAPSHOT_WARNINGS.length,
        `${path}：告警一条都不许少（数量不变）`);
      for (const w of anon.json.warnings) {
        assert.equal(w.detail, undefined, `${path}：匿名访客不得拿到 detail（${w.code}）`);
      }
      assert.ok(!anon.text.includes('judge_sample_too_small'),
        `${path}：响应体里不许出现内部原因码`);

      // ② 普通用户（没有 audit:read）
      const plain = await callJson(app, 'GET', path, { token: sessionToken(db, 'u_cap') });
      assert.equal(plain.status, 200, `${path} 普通用户访问应成功`);
      assert.equal(plain.json.warnings.length, SNAPSHOT_WARNINGS.length,
        `${path}：普通用户的告警数量不变`);
      for (const w of plain.json.warnings) {
        assert.equal(w.detail, undefined, `${path}：普通用户不得拿到 detail（${w.code}）`);
      }
      assert.ok(!plain.text.includes('judge_sample_too_small'),
        `${path}：响应体里不许出现内部原因码`);

      // ③ 有 audit:read 的人 ⇒ detail 完整可见
      const auditor = await callJson(app, 'GET', path, { token: sessionToken(db, 'u_auditor') });
      assert.equal(auditor.status, 200, `${path} 审计员访问应成功`);
      assert.equal(auditor.json.warnings.length, SNAPSHOT_WARNINGS.length,
        `${path}：审计员看到的告警数量不变`);
      for (const [i, w] of auditor.json.warnings.entries()) {
        assert.equal(w.detail, SNAPSHOT_WARNINGS[i].detail, `${path}：审计员必须拿到 detail`);
      }
      assert.ok(auditor.text.includes('judge_sample_too_small'),
        `${path}：审计员能看到内部原因码`);
    }
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('★ 公开端点：人话正文一条不少、一条不改；内部规则键（code）一个都不许下发', async () => {
  const { db, close, dataDir, app } = setup();
  try {
    const res = await callJson(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.warnings.map((w) => w.message),
      SNAPSHOT_WARNINGS.map((w) => w.message),
      '人话正文必须原样透出（一条不少、一条不改）',
    );
    // ⛔ **E184（2026-10-28）：公开响应里不许再下发 `code`** ——
    //    `code` 是**内部规则键**（normalization_fallback / R2_missing_dual_signature 这种），
    //    与 `detail` 同一类（内部工作语言）。
    //    ⚠️ E172 当初把 `code`「故意保留」的理由是「机器判据 / 审计靠它定位」，
    //    但那条理由**只对有 audit:read 的人成立** ⇒ 审计定位在审计页与留痕原文里就够。
    //    ⇒ 界面上不渲染的，就不该发到浏览器（「前端隐藏 = 数据已经发到浏览器」）。
    for (const w of res.json.warnings) {
      assert.equal(w.code, undefined, `公开响应里不得下发内部规则键（${w.code}）`);
    }
    assert.ok(!res.text.includes('normalization_fallback'), '响应体里不许出现内部规则键');
    // 内部标识字段对没权限的人也不下发（前端不渲染 ⇒ 不该发出去）
    for (const w of res.json.warnings) {
      assert.equal(w.teamId, undefined, '公开响应里不得下发队伍 id');
      assert.equal(w.dimension, undefined, '公开响应里不得下发英文维度键');
    }
    // 有权限的人拿得到全部内部信息（审计定位不受影响）
    const auditor = await callJson(app, 'GET', '/api/leaderboard/rolling?editionId=ed_1', {
      token: sessionToken(db, 'u_auditor'),
    });
    assert.deepEqual(
      auditor.json.warnings.map((w) => w.code),
      SNAPSHOT_WARNINGS.map((w) => w.code),
      '审计员必须拿得到全部 code（审计定位靠它）',
    );
    assert.equal(auditor.json.warnings[1].teamId, 't_a', '审计员应拿到队伍 id');
    assert.equal(auditor.json.warnings[1].dimension, 'self_eval', '审计员应拿到维度键');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 三、前端渲染：code 降级成小号标签，detail 单独成行
// ══════════════════════════════════════════════════════════════════

test('★ 前端渲染：内部规则键（code）完全不渲染，detail 单独成行', () => {
  const html = leaderboardHtml({
    scope: 'rolling',
    warnings: [{
      code: 'normalization_fallback',
      message: '维度「技术可行性」的评委宽严归一化已降级 —— 本维度未按评委宽严做校正',
      detail: '降级明细（评委 id : 原因码）：j1:judge_sample_too_small',
      stageName: '决赛路演',
    }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  // ⛔ code 不得再当正文前缀
  assert.ok(!html.includes('[normalization_fallback]'), 'code 不得再以 [code] 形式出现在正文');
  // ⛔ **E184：code 一点都不许渲染** —— 上一版把它降级成「小号等宽标签」
  //    （`warn__code`）跟在正文后面，理由是「机器判据不能丢」，
  //    但**标签仍然是可见文本** ⇒ 匿名访客照样看得见 `normalization_fallback`。
  assert.ok(!html.includes('warn__code'), '内部规则键不许渲染成任何标签');
  assert.ok(!html.includes('normalization_fallback'), '内部规则键不许出现在页面上');
  // ✅ detail 单独成行
  assert.ok(html.includes('warn__detail'), 'detail 必须单独成行');
  assert.ok(/<div class="warn__detail">[^<]+<\/div>/.test(html), 'detail 必须是独立的块级行');
  assert.ok(html.includes('judge_sample_too_small'), 'detail 的内容必须真的渲染出来');
  // ⚠️ 位置硬契约：告警仍然置顶（字符索引 < 队名的字符索引）
  assert.ok(html.indexOf('降级明细') < html.indexOf('A队'), '告警必须仍然排在榜单之前（置顶）');
});

test('★ 前端渲染：没有 detail 时不渲染明细行（后端裁剪掉的就是不显示）', () => {
  const html = leaderboardHtml({
    scope: 'rank',
    warnings: [{ code: 'R2_missing_dual_signature', message: '企业确认缺双签，该项按 0 分计' }],
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  assert.ok(!html.includes('warn__detail'), '没有 detail 时不许留空的明细行');
  assert.ok(!html.includes('R2_missing_dual_signature'), '内部规则键不许渲染');
  assert.ok(html.includes('企业确认缺双签'), '人话正文照常渲染');
});

// ══════════════════════════════════════════════════════════════════
// 四、领域层唯一入口：告警内部明细的裁剪收进 applyVisibility
//    ⇒ 演示站与正式站共用同一份口径（以前两处各写一份 ⇒ 演示站泄给了匿名访客）
// ══════════════════════════════════════════════════════════════════

const VIS_PAYLOAD = {
  scope: 'rank',
  rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  warnings: SNAPSHOT_WARNINGS,
};
const VIS_CFG = { rank: { showEnterpriseName: false } };

test('★ 领域层唯一入口 applyVisibility：没有 audit:read ⇒ 裁掉内部明细，但告警一条不少', () => {
  const out = applyVisibility({
    payload: VIS_PAYLOAD,
    viewer: null,
    visibilityConfig: VIS_CFG,
    context: { scope: 'rank' },
  });
  assert.equal(out.warnings.length, SNAPSHOT_WARNINGS.length, '告警一条都不许少（S-5 / C-05）');
  for (const w of out.warnings) {
    assert.equal(w.detail, undefined, `detail 必须被裁掉（${w.code}）`);
    assert.equal(w.teamId, undefined, `队伍 id 必须被裁掉（${w.code}）`);
    assert.equal(w.teamIds, undefined, `队伍 id 列表必须被裁掉（${w.code}）`);
    assert.equal(w.dimension, undefined, `英文维度键必须被裁掉（${w.code}）`);
    // ⛔ **E184**：内部规则键（code）也必须被裁掉（它是内部工作语言，不是公开信息）
    assert.equal(w.code, undefined, `内部规则键必须被裁掉（${w.code}）`);
    assert.ok(w.message, 'message 必须保留（人话正文）');
  }
  const dumped = JSON.stringify(out.warnings);
  assert.ok(!dumped.includes('judge_sample_too_small'), '告警里不许出现内部原因码');
  assert.ok(!dumped.includes('t_a'), '告警里不许出现队伍 id');
  assert.ok(!dumped.includes('normalization_fallback'), '告警里不许出现内部规则键');
});

test('★ 领域层唯一入口 applyVisibility：canAudit ⇒ 内部明细与内部规则键完整可见', () => {
  const out = applyVisibility({
    payload: VIS_PAYLOAD,
    viewer: { id: 'u_auditor' },
    visibilityConfig: VIS_CFG,
    context: { scope: 'rank', canAudit: true },
  });
  assert.equal(out.warnings.length, SNAPSHOT_WARNINGS.length, '告警数量不变');
  for (const [i, w] of out.warnings.entries()) {
    assert.equal(w.detail, SNAPSHOT_WARNINGS[i].detail, '审计员必须拿到 detail');
    assert.equal(w.code, SNAPSHOT_WARNINGS[i].code, '审计员必须拿到 code（审计定位靠它）');
  }
  assert.equal(out.warnings[1].teamId, 't_a', '审计员必须拿到队伍 id');
  assert.equal(out.warnings[1].dimension, 'self_eval', '审计员必须拿到英文维度键');
});

/** 演示站的内存版 localStorage（与浏览器同形状） */
function makeMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('★ 演示站与正式站同口径：匿名访客拿不到 detail，演示管理员拿得到', async () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const { createDemoApi } = await import('../web/api.demo.js');
  const api = createDemoApi({ storage: makeMemoryStorage(), seed, rules });

  // 跑一次真实引擎的计算 ⇒ 产出告警（与构建期预计算同一条路径）
  await api.post('/api/auth/login', { name: '演示管理员' });
  await api.post('/api/stages/stage_final/compute', {});

  const admin = await api.get('/api/leaderboard/rolling');
  assert.ok(Array.isArray(admin.warnings) && admin.warnings.length > 0, '演示站必须有告警（否则这条闸是假绿）');
  assert.ok(admin.warnings.some((w) => w.detail), '演示管理员（audit:read）必须拿到 detail');

  // 退出登录 ⇒ 匿名访客看同一个公开端点
  await api.post('/api/auth/logout', {});
  const anon = await api.get('/api/leaderboard/rolling');
  assert.equal(anon.warnings.length, admin.warnings.length, '匿名访客看到的告警一条都不许少');
  for (const w of anon.warnings) {
    assert.equal(w.detail, undefined, `匿名访客不得拿到 detail（${w.code}）`);
    assert.equal(w.teamId, undefined, `匿名访客不得拿到队伍 id（${w.code}）`);
    assert.equal(w.dimension, undefined, `匿名访客不得拿到英文维度键（${w.code}）`);
    // ⛔ **E184**：内部规则键也不许下发（演示站与正式站**同一把尺**）
    assert.equal(w.code, undefined, `匿名访客不得拿到内部规则键（${w.code}）`);
    assert.ok(w.message, '人话正文必须保留');
  }
  const dumped = JSON.stringify(anon.warnings);
  // ⚠️ `detail`（评委 id + 内部原因码 / 队伍 id / 英文维度键 / 内部破同分键名）
  //    与 `code`（内部规则键）**都不许**出现在匿名访客的响应里（E184）。
  for (const marker of ['judge_sample_too_small', 'partial:', '/ 维度 ', 'tiebreak_extra', 't_alpha',
    'normalization_fallback', 'R2_missing_dual_signature']) {
    assert.ok(!dumped.includes(marker), `匿名访客不得看到内部标识「${marker}」`);
  }
});
```

### 演示站组委会写流程的行为闸

`platform/test/demo-admin-write-flows.test.js`：演示站组委会写流程的行为闸

```javascript
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
```

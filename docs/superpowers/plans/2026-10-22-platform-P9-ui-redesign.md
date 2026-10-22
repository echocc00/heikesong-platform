# P9 · UI 重构：落地页 + 科技感设计系统

> **日期**：2026-10-22
> **触发**：用户指令 —— 「调用 ui-design skill，ui 重构下，两个要求：① 要有落地页，也就是首页，首页用来介绍赛事和赛制，吸引报名等信息；② 整体风格要专业，有科技感，交互感要强」
> **依据**：docs/three-port-alignment.md（三端拆分）+ platform/rules/*.json（赛制的唯一出处）
>
> **本阶段的硬约束**（沿用全局约束，不因重构而放宽）：
> 零 npm 依赖 · 零构建 · 原生 ESM · 可移植 · 跨平台稳定 · 可扩容 · 性能可接受

---

## 0. 一句话

把首页从「KPI + 入口卡的仪表盘」改成**落地页**：讲清赛事与赛制、吸引报名；
同时把整个设计系统换成「暗色优先 · 数据说话」的科技感语言，并给规则内容一套**专属的视觉语法**。

---

## 1. 设计契约（Design Contract）

> 格式依 ui-design skill 的 `references/tokens.md`「The design contract」。

### 1.1 Subject（主体）

**华东区 AI 商业黑客松** —— 一个**以规则为产品**的赛事平台。

- 参赛者：AI / 商业 / 创业团队（队长须 MBA）
- 评委：企业席 + 技术专家席（观察员无投票权）
- 组委会：报名筛选、复核、评审、赛段发榜
- ⭐ **这个产品的「真实文物」不是界面，是赛制本身**：
  五段赛程、六个评分维度的权重、段位阶梯、筛选漏斗、破同分链。
  ⇒ 界面的第一职责是**把规则讲清楚**，第二职责才是好看。

### 1.2 Audience & frequency（受众与频次）

| 人群 | 频次 | 核心诉求 |
|---|---|---|
| 访客（潜在参赛者） | 首次访问，停留 60–180 秒 | 30 秒内明白「这是什么赛、赛制怎么算、我能不能参加、怎么报名」 |
| 参赛者 | 登录后每日回访 | 看榜、看自己的段位、领任务、交行为分 |
| 组委会 | 低频高风险 | 筛选报名、复核、打分、发榜 |

### 1.3 Primary job（首要任务）

**让一个从未听说过这个赛事的人，在 30 秒内看明白赛制，并产生报名意向。**

### 1.4 三轴选择（axis）

| 轴 | 选择 | 理由 |
|---|---|---|
| **Macrostructure** | `split-hero` | **刻意不用默认的 `hero-led`**。本页主体是规则，而规则的可视化载体是「赛程脊柱」。脊柱放进首屏右半屏 ⇒ **首屏本身就是赛制说明**，不是「口号 + 装饰图」。左主张右实物，屏幕即广告。 |
| **Visual style** | `midnight`（Midnight / Developer Tool） | dark-first、"界面后退，让数据承担对比" —— 正好匹配规则密集的内容；且与既有暗色基调（#0b0e14）同源 ⇒ 保留既有品牌（冲突序 #3「保留既有」）。 |
| **Type pairing** | `plex-family`（IBM Plex Family） | 数据工具 / 基础设施 / B2B SaaZ 的首选，与 midnight 同组。 |

**⚠️ 零依赖 ⇒ 不引入任何网络字体。**
字体栈写 `"IBM Plex Sans", <系统栈>` / `"IBM Plex Mono", <等宽栈>`；
本机未安装 IBM Plex ⇒ 实际渲染是系统栈。
**截图即真实**，不假装（skill：「Never claim a visual improvement you have not looked at」）。

### 1.5 Signature —— 「规则即图形」(Rules as Graphics)

> **本赛事每一条规则都用同一个几何语法呈现，从不用段落散文。**

| 载体 | 语法 | 用在哪 |
|---|---|---|
| **条** bar | 比例条 | 评审维度权重（10% / 20% / 25% …） |
| **脊** spine | 连线 + 节点 | 五段赛程 S1→S5 与各自交付物 |
| **阶** step | 逐级台阶 | 段位 D → C → B → A → S 与权益 |
| **流** stream | 递减流 | 筛选漏斗 30% → 30% → 20% → 10% |

一个语法、四种载体。**这是「这是黑客松的赛制页」而不是「通用 SaaS 首页」的判据。**

### 1.6 Palette

暗色（默认，midnight 派生）：

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#0B0D12` | 页面底 |
| `--surface` | `#151922` | 卡片 |
| `--surface-raised` | `#1B202B` | 浮起层 |
| `--surface-sunken` | `#10131A` | 凹陷槽 |
| `--fg` | `#E6E9EF` | 正文 |
| `--fg-strong` | `#F5F7FA` | 标题 |
| `--fg-muted` | `#98A2B3` | 次要 |
| `--fg-subtle` | `#7C8698` | 弱 |
| `--border` | `#242A36` | 1px 分隔 |
| `--border-strong` | `#333B4B` | 强分隔 |
| `--accent` | `#7C9CFF` | 强调（对 --bg ≈ 8.2:1） |
| `--on-accent` | `#0B0D12` | 压 accent 实底的文字（≈ 8.2:1 ✅） |

⚠️ **白字压 `#7C9CFF` 只有 2.6:1** ⇒ 实底按钮一律用 `--on-accent`（深色字），沿用 P0 的同一纪律。
语义色沿用既有并校准：`--success #35C88A` / `--warn #F0B429` / `--danger #F56E72` / `--info #38BDF8`。

亮色主题（`[data-theme="light"]` + `prefers-color-scheme`）：
`--bg #F4F6FA` / `--surface #FFFFFF` / `--fg #161B24` / `--accent #2F5FE0`（对白 ≈ 5.6:1）/ `--on-accent #FFFFFF`。
**同一 token 名、不同值** ⇒ 换主题只换变量（DP-83）。

### 1.7 Type / Spacing / Radius / Elevation / Motion

- **字体**：`"IBM Plex Sans", -apple-system, …, "PingFang SC", …` ／ `"IBM Plex Mono", ui-monospace, …`
  数字（积分 / 权重 / 名次 / 日期）一律 `tabular-nums` + 等宽 —— midnight 的签名动作③
- **间距**：4px 基数，`--sp-1…--sp-12`（沿用）＋ 新增 `--sp-16: 64px`（分节留白）
- **圆角**：收紧为 sm 4 / md 6 / lg 10 / xl 14 / full —— **比现状更方** ⇒ 更技术感
- **层级**：卡片**零阴影**，只用 1px 边框分隔（midnight 签名动作①）；
  阴影只留给浮层（toast / 顶栏 scrim）
- **动效**：两档时长 `--dur-1: 120ms`（hover/状态）、`--dur-2: 260ms`（进入/展开）；
  缓动 `cubic-bezier(.2,.8,.2,1)`；`prefers-reduced-motion: reduce` ⇒ 全部降为 0.01ms（沿用既有约定）

### 1.8 Measure（可复算的验收阈值）

| # | 阈值 |
|---|---|
| M1 | 首屏 1440×900 内可见：赛事名 + 副题 + ≥1 主 CTA + ≥3 个关键数字 + 赛程脊柱 5 个节点 |
| M2 | 正文 `--fg` 对 `--bg` ≥ 7:1；`--fg-muted` ≥ 4.5:1；主 CTA 文字 ≥ 4.5:1 |
| M3 | 六视口（360 / 390 / 768 / 1024 / 1440 / 1920）无横向滚动、无重叠、无截断 |
| M4 | 每屏强调色元素 ≤ 3（主 CTA + 焦点环 + 活动节点） |
| M5 | 除 hero 标题外，所有标题 ≤ 24px；全页**只有一个** oversized moment |
| M6 | 落地页未登录 100% 可用（无 401、无「需要登录」）；登录后 CTA 变「进入工作台」 |
| M7 | 落地页零死链（机器闸：href 逐一比对路由表） |
| M8 | 视图里写出的 class 全部能在 styles.css 找到规则（class 差集 = 0） |
| M9 | Tab 可达每个 CTA；`:focus-visible` 可见 |
| M10 | `prefers-reduced-motion` 下降级；亮色主题下同样满足 M2 |

⚠️ **对 midnight「标题不超过 28px」的一处刻意偏离**：落地页需要 hero 标题。
按 skill 的冲突序「用户明确要求 > 既有惯例」，hero 标题取 **40px（桌面）/ 30px（移动）**，
且用紧字距 + 中等字重 + 等宽 eyebrow，让它读起来像「赛事控制台」而不是「创业公司落地页」。
**全页只有这一个 oversized moment**，其余标题一律 ≤ 24px。

### 1.9 交互清单（"交互感要强"的可执行拆解）

> ⚠️ skill 的 tell 目录里有 `scroll-fade-sections`（每段滚动淡入）与 `hover-lift-everything`（每卡都浮起）
> ⇒ **不做这两条**。下面的交互全部与「规则」直接相关，且各自独立：

| 交互 | 做什么 | 降级 |
|---|---|---|
| **赛程脊柱选择** | 点/聚焦某个赛段节点 → 右栏详情面板换成该赛段的交付物与说明 | 无 JS 时是完整静态列表（`<details>` 语义） |
| **权重条联动** | 评审维度表与比例条一一对应；悬停某维度 → 对应条高亮 | 无 JS 时条仍有正确宽度 |
| **数字滚动** | 关键数字在进入视口时 count-up 到目标值 | 无 JS 时直接显示终值 |
| **Hero 指针辉光** | 指针位置驱动一层极淡的径向辉光 + 网格底纹 | 无 JS / reduced-motion 时为静态网格 |
| **段位阶梯联动** | 悬停/聚焦某级 → 权益区高亮对应权益 | 静态可读 |
| **漏斗流动** | 进入视口时漏斗各级依次展开（stagger 40ms） | reduced-motion 下降级为直接显示 |

---

## 2. 信息架构决策

| 路径 | 内容 | 登录 |
|---|---|---|
| `/` | **落地页**（赛事介绍 + 赛制 + 报名 CTA） | 公开 |
| `/dashboard` | 原「赛事总览」仪表盘（KPI + 入口卡 + 前五榜） | 需登录 |
| `/leaderboard` `/tier` | 榜单 / 段位榜 | 公开 |
| 其余不变 | 报名 / 我的战队 / 任务清单 / 评审席 / 组委会 | 按原规则 |

**为什么这么切**：用户明确要求「首页 = 落地页」，而 P7.1 刚把总览页做成仪表盘。
两者定位不同 ⇒ **并存而不是二选一**：`/` 给访客，`/dashboard` 给已登录的人，
导航里「我的赛事」分区加一条「工作台」。**原总览页一行内容都不删**（可逆）。

---

## 3. 落地页内容来源（⛔ 不编造赛制）

> **所有赛制数字都来自 `platform/rules/*.json`，不许在前端硬编码。**

新增**一个**公开只读端点：`GET /api/event-info`
（公开、免 token、**白名单投影** —— 不整体倒 `rules`，内部备注如「待组委会确认」不进公开响应）。

投影内容：

| 段落 | 来源 |
|---|---|
| 五段赛程 + 交付物 + 晋级率 | `rules.schedule` |
| 初赛 / 决赛评分维度与权重 | `rules.scoring.initial` / `rules.scoring.final` |
| 段位 D→S 与权益 | `rules.ranks` |
| 报名筛选漏斗 | `rules.registration.funnel` |
| 组队规则 | `rules.teamFormation` |
| 名次积分 / MVP 口径 | `rules.points` |
| 破同分链（标签） | `rules.tiebreak.chain` |
| 行为分（标签 + 分值） | `rules.behavior.events` |
| 合规红线 | `rules.compliance.redLines` |
| 分层公开门槛 | `rules.visibility` |

演示站（`web/api.demo.js`）必须有**同形状**的实现 —— 演示适配器同样持有 `rules` 对象。

---

## 4. 任务清单

| Task | 内容 | 文件 |
|---|---|---|
| T1 | 后端：`getEventInfo(rules)` 白名单投影 + `GET /api/event-info` | `src/services/public-api.js`、`src/http/routes/public.js` |
| T2 | 演示适配器：同形状端点 | `web/api.demo.js` |
| T3 | 设计系统：token 层重写（midnight 化）+ 圆角收紧 + 落地页组件 | `web/styles.css` |
| T4 | 落地页视图（纯函数 + 渲染 + 六类交互） | `web/views/landing.js`（新建） |
| T5 | 路由与导航：`/` = 落地页，`/dashboard` = 原总览 | `web/app.js`、`web/nav.js` |
| T6 | 页面元信息（description / theme-color） | `web/index.html` |
| T7 | 测试：落地页行为闸、端点闸、演示 parity、死链闸、class 差集闸 | `test/web-landing.test.js`（新建）等 |
| T8 | 视觉验证：Playwright 六视口截图 + 读图 + 修复 | — |
| T9 | 计划块同步（owned 文件同步回原阶段计划）+ 台账 + 提交 + 部署 | — |

---

## 5. 文件归属与计划块同步

| 文件 | owning 阶段 | 本阶段动作 |
|---|---|---|
| `web/styles.css` | P0 | Modify ⇒ **同步回 P0 计划块** |
| `web/app.js` | P0 | Modify ⇒ **同步回 P0 计划块** |
| `web/index.html` | P6 | Modify ⇒ **同步回 P6 计划块** |
| `web/nav.js` | P7 | Modify ⇒ **同步回 P7 计划块** |
| `web/views/home.js` | P7 | Modify（加工作台标识）⇒ **同步回 P7 计划块** |
| `web/api.demo.js` | P6 | Modify ⇒ **同步回 P6 计划块** |
| `src/services/public-api.js` | P5 | Modify ⇒ **同步回 P5 计划块** |
| `src/http/routes/public.js` | P5 | Modify ⇒ **同步回 P5 计划块** |
| `web/views/landing.js` | **P9** | Create ⇒ 规格块在本文件 |
| `test/web-landing.test.js` | **P9** | Create ⇒ 规格块在本文件 |

---

## 6. 台账编号

本阶段用 **E114 – E124**（事件）与 **DP-100 – DP-101**（设计原则），不与 P7.1（E103–E107 / DP-89–DP-93）、
P8（E108–E113 / DP-94–DP-99）重号。

### DP-100 · 赛制只从配置来

落地页**一个字都不许硬编码**赛制数字。赛程日序、维度权重、漏斗比例、晋级率、名次积分……
全部只在 `platform/rules/*.json` 里；前端从 `GET /api/event-info` 取。

**机器闸**：`test/web-landing.test.js` 扫落地页源码里的**规则里出现过的字面量**
（`'10-01'` / `0.25` / `'0.10'` …），命中即红。

**为什么**：规则会改（委员会随时可能调权重与赛期）。前端一旦写死一个数字，
落地页就会**嘴上说一套、实际算另一套** —— 这是赛制类页面最致命的一种撒谎。

### DP-101 · 降级路径也必须可点，且**不许抛**

错误态里的「重试」要**真的绑在那一个按钮上**；并且降级代码在**任何 DOM 环境**下都不能抛
（最小测试桩没有 `querySelector`）—— 抛出的新异常会变成 `unhandledRejection`
并**归到正在跑的另一个用例头上**（症状与出错的页面毫无关系，极难定位）。

**为什么**：P9 实测踩过 —— `demo-static` 的「演示版横幅」用例被落地页的降级代码带崩，
排查方向完全跑偏。降级路径是**最容易被测不到**的路径（只有在出错的分支里才会走到），
所以它的写法必须比正常路径更保守。

---

---

## 7. 规格块（P9 新建文件）

### T1 的领域层投影（纯函数，演示站与正式站共用同一份）

**Step: 创建 `platform/src/domain/event-info.js`**

```js
// src/domain/event-info.js — 赛事规则投影（落地页的数据源）
// 依据：P9「UI 重构：落地页 + 科技感设计系统」；赛制的唯一出处是 platform/rules/*.json
//
// ⚠️⚠️ **为什么这个文件在 domain 层（而不是 services/ 或直接写在前端）**：
//   落地页要「介绍赛事与赛制」⇒ 前端需要赛段起止与交付物、评审维度权重、段位表、
//   筛选漏斗、组队规则、名次积分、破同分链、合规红线。
//   这些**全部**只在 `platform/rules/*.json` 里（赛制的唯一出处），
//   而 rules 是**服务端**配置、浏览器读不到 ⇒ 必须由服务端投影出去。
//
//   ⇒ 放在 domain 层的理由是**一份实现、两处使用**：
//     · src/services/public-api.js 的 GET /api/event-info（正式平台）
//     · web/api.demo.js 的同形状端点（公网演示站）
//   两者 import **同一个函数** ⇒ 演示站与正式站的落地页内容**不可能漂移**
//   （P8 的教训：演示适配器曾把「错误的形状」锁进测试 ⇒ 形状必须同源，不能各写一份）。
//
// ⛔⛔ **白名单投影，不是整体倒 rules**：
//   rules 里大量字段是**内部工作备注**（「此为待组委会确认口径」「首届后回测」「占位题面」…），
//   整体倒出去 = 把内部待办状态公开发布。
//   ⇒ 这里**逐字段白名单**挑出「参赛者有权知道的赛制」，其余一律不带。
//
// ⛔ **公开的是「规则」，不是「数据」**：
//   规则（权重、赛程、段位）本来就该公开 —— 参赛者有权知道自己被怎么评；
//   而**分数、名次、企业名、签字人**由 applyVisibility 负责，不在这个文件里。
//
// ⛔ **零依赖、零 IO、纯函数**：领域层要能进浏览器（build-demo.js 会把 src/domain 整目录
//    拷进静态产物），所以这里不得 import 任何 Node 内置模块。
//    ⇒ 不 import src/errors.js（它带 node:crypto），「规则未加载」由**调用方**抛业务错误。

/**
 * 数值兜底：把可能是 undefined / null / 非数字的值转成有限数。
 * ⚠️ 不用 `Number(x) || 0`：Number('abc') 是 NaN（falsy → 0，恰好对），
 *    但 Number(Infinity) 是 Infinity（truthy ⇒ 会被原样带出去 ⇒ 前端渲染成 "Infinity"）。
 *    ⇒ 这里显式判有限。
 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 字符串兜底。 */
function str(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** 布尔兜底（只认真值 true）。 */
function bool(value) {
  return value === true;
}

/** 数组兜底：非数组一律当空数组（配置写错形状时不炸）。 */
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 评分维度投影：只带 key / 名称 / 权重 / 席位。
 * ⚠️ 不带任何内部说明（配置里那些「冲突裁决」「占位」备注是内部工作语言）。
 */
function dimensions(cfg) {
  return arr(cfg?.dimensions).map((d) => ({
    key: str(d?.key),
    name: str(d?.name),
    weight: num(d?.weight),
    seat: str(d?.seat),
  }));
}

/**
 * 赛事规则投影（纯函数）。
 *
 * @param {object} rules 已加载的规则配置（src/config.js 的 loadRules 结果）
 * @returns {object} 落地页用的赛制数据（**形状恒定**：缺配置也给空数组，不给 undefined）
 */
export function buildEventInfo(rules) {
  const r = rules ?? {};
  const schedule = r.schedule ?? {};
  const initial = r.scoring?.initial ?? {};
  const final = r.scoring?.final ?? {};
  const ranks = r.ranks ?? {};
  const registration = r.registration ?? {};
  const formation = r.teamFormation ?? {};
  const points = r.points ?? {};
  const behavior = r.behavior ?? {};
  const compliance = r.compliance ?? {};
  const visibility = r.visibility ?? {};

  return {
    /** 赛段表（脊）：起止是**相对日序**（月-日），由届期起始日落到日历。 */
    stages: arr(schedule.stages).map((s) => ({
      key: str(s?.key),
      name: str(s?.name),
      start: str(s?.start),
      end: str(s?.end),
      deliverables: arr(s?.deliverables).map((d) => str(d)),
      hardRequirement: s?.hardRequirement !== false,
      // ⛔ **不带 note**：rules 里的 note 是**内部溯源说明**
      //    （「R-STG-05：任务书 §六…以甲方投决积分为主」——带内部文档编号与原文引用）。
      //    ⇒ 「这个赛段不做硬性要求」这件事由 hardRequirement（布尔）表达就够了，
      //      落地页据此自己写一句话；把 note 原文倒出去等于把内部工作语言公开。
    })),
    advancement: {
      rate: num(schedule.advancement?.rate),
      finalTopN: num(schedule.advancement?.finalTopN),
    },
    scoring: {
      initial: { dimensions: dimensions(initial) },
      final: { dimensions: dimensions(final) },
    },
    /** 段位（阶）。benefits 按段位键取，取不到就是空数组。 */
    tiers: arr(ranks.tiers).map((t) => ({
      key: str(t?.key),
      name: str(t?.name),
      minMilestones: num(t?.minMilestones),
      requiresBusinessSignoff: bool(t?.requiresBusinessSignoff),
      requiresDataOrPrototype: bool(t?.requiresDataOrPrototype),
      benefits: arr(ranks.benefits?.[str(t?.key)]).map((b) => str(b)),
    })),
    /** 段位**永不解锁**的东西（避免落地页暗示段位能换奖金）。 */
    tierNeverUnlocks: arr(ranks.neverUnlocks).map((x) => str(x)),
    /** 报名筛选漏斗（流）：rate 为 null 表示比例待定（如辅导期）。 */
    funnel: arr(registration.funnel).map((f) => ({
      key: str(f?.key),
      label: str(f?.label),
      rate: f?.rate === null || f?.rate === undefined ? null : num(f.rate),
    })),
    /** 报名画像三维度 + 分级门槛（落地页用来说明「怎么筛人」）。 */
    registration: {
      dimensions: arr(registration.dimensions).map((d) => ({
        key: str(d?.key),
        label: str(d?.label),
        weight: num(d?.weight),
      })),
      levels: arr(registration.levels).map((l) => ({
        key: str(l?.key),
        label: str(l?.label),
        minScore: num(l?.minScore),
      })),
    },
    /** 组队规则。 */
    formation: {
      teamMin: num(formation.teamSize?.min),
      teamMax: num(formation.teamSize?.max),
      captainMustBeMba: bool(formation.captainMustBeMba),
      teamsPerPackageMin: num(formation.teamsPerPackage?.min),
      teamsPerPackageMax: num(formation.teamsPerPackage?.max),
      enterpriseQuota: num(formation.packageQuotaMix?.enterprise),
      freeQuota: num(formation.packageQuotaMix?.free),
    },
    /** 名次积分与 MVP 口径。 */
    scoringPoints: {
      stagePoints: arr(points.stagePoints).map((n) => num(n)),
      stagePointsOnlyTopN: num(points.stagePointsOnlyTopN),
      mvpStagesCounted: num(points.mvp?.stagesCounted),
      tieRankStyle: str(points.tieRankStyle),
    },
    /** 破同分链：只给标签与顺序（说明「同分怎么决」）。 */
    tiebreak: arr(r.tiebreak?.chain).map((c, i) => ({
      order: i + 1,
      key: str(c?.key),
      label: str(c?.label),
      scope: str(c?.scope),
      deterministic: bool(c?.deterministic),
    })),
    /** 行为分（过程参与度）：只给标签与分值。 */
    behaviorEvents: arr(behavior.events).map((e) => ({
      key: str(e?.key),
      label: str(e?.label),
      points: num(e?.points),
    })),
    behaviorMaxWeightShare: num(behavior.maxWeightShare),
    /** 合规红线（报名页与落地页都要明示）。 */
    redLines: arr(compliance.redLines).map((x) => ({
      key: str(x?.key),
      label: str(x?.label),
    })),
    /** 分层公开门槛：C 段及以上公开。 */
    visibility: {
      publicFromTier: str(visibility.rank?.publicFromTier),
    },
  };
}
```

### T4 落地页视图（纯函数 + 渲染 + 交互）

**Step: 创建 `platform/web/views/landing.js`**

```js
// web/views/landing.js — 落地页（首页）：介绍赛事与赛制，吸引报名
// 溯源需求：P9「UI 重构：落地页 + 科技感设计系统」
//          → docs/superpowers/plans/2026-10-22-platform-P9-ui-redesign.md
//
// ⚠️⚠️ **为什么首页要变成落地页**：
//   P7.1 把首页做成了「KPI + 入口卡」的仪表盘 —— 那是**给已登录的人**看的操作面板。
//   但首页是**访客的第一印象**：一个还没注册的人看到 KPI 卡只会困惑
//   （「在榜队伍 12」跟我有什么关系？），看不到「这是什么赛、怎么比、我能不能参加」。
//   ⇒ 现在 `/` = 落地页（公开），原仪表盘迁到 `/dashboard`（登录后可达）。
//     两者**并存**，原总览页一行内容都没删（可逆）。
//
// ⛔ **赛制数字一个字都不许硬编码**：
//   赛段的起止与交付物、评审维度权重、段位表、漏斗、组队规则、名次积分、
//   破同分链、合规红线 —— **全部**来自 `GET /api/event-info`
//   （服务端对 platform/rules/*.json 的白名单投影，见 src/domain/event-info.js）。
//   ⇒ 委员会改 rules/*.json，落地页自动跟着变；前端改数字 = 口径撒谎。
//
// ⛔ **纯逻辑与 IO 分离**：本文件的导出（landingStats / landingSpine / landingWeightBars …）
//    都是纯函数（无 IO、无 DOM）⇒ platform/test/web-landing.test.js 能对**结果本身**断言。
//
// ⚠️ **交互清单**（契约 §1.9）—— 刻意**不做**「每段滚动淡入」与「每卡都浮起」
//    （skill 的 tell 目录把这两条列为俗套）。这里的每一处交互都与**规则**直接相关：
//    ① 赛程脊点选 → 详情切换　② 初赛/决赛同维度**权重联动高亮**
//    ③ 关键数字 count-up　④ Hero 指针辉光　⑤ 段位阶悬停 → 权益高亮
//    ⑥ 漏斗进入视口依次伸展
import { escapeHtml } from '../escape.js';
import { errorState, friendlyError, loadingState } from '../ui.js';

/**
 * 百分比显示：0.10 → 10%，小数一位（权重表里出现过 0.05 这种值）。
 * ⛔ 不许用 `Math.round(v * 100) + '%'`：0.05 → 5%，0.125 → 13%（应为 12.5%）。
 * @param {number} v 0–1 的比例
 * @returns {string} 形如 "12.5%" 的字符串
 */
export function pctText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const p = n * 100;
  const rounded = Math.round(p * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * 关键数字行。
 * ⚠️ **数字与标签必须成对出现**（P7 的 DP-89 教训）：数组长度可变会让解构错位。
 *   ⇒ 这里返回**固定形状**的对象数组，长度由入参决定但每项的字段都齐全。
 *
 * @param {object} input
 * @param {object} input.info        /api/event-info 的返回
 * @param {number|null} input.boardCount  在榜队伍数（滚动总榜行数）
 * @returns {Array<{label:string,value:string|number}>}
 */
export function landingStats({ info = {}, boardCount = null } = {}) {
  const stages = Array.isArray(info.stages) ? info.stages.length : 0;
  const dims = Array.isArray(info?.scoring?.initial?.dimensions) ? info.scoring.initial.dimensions.length : 0;
  const tiers = Array.isArray(info.tiers) ? info.tiers.length : 0;
  const out = [
    { label: '赛段', value: stages },
    { label: '评审维度', value: dims },
    { label: '段位', value: tiers },
    { label: '在榜队伍', value: boardCount === null ? '—' : boardCount },
  ];
  return out;
}

/**
 * 赛程脊的节点。
 * ⚠️ 日期是**相对日序**（rules/schedule.json 里是 "10-01"）⇒ 直接显示，
 *    不许在前端编日历日期（届期起始日服务端才知道，编出来就是假日期）。
 *
 * @param {Array<object>} stages
 * @returns {Array<{key:string,name:string,date:string}>}
 */
export function landingSpineNodes(stages) {
  return (Array.isArray(stages) ? stages : []).map((s) => ({
    key: String(s?.key ?? ''),
    name: String(s?.name ?? ''),
    date: s?.start && s?.end ? `${s.start} – ${s.end}` : String(s?.start ?? ''),
    raw: s,
  }));
}

/**
 * 赛程详情面板（节点被选中时显示的内容）。
 * ⚠️ **交付物必须来自 rules**（rules/schedule.json 的 deliverables）。
 * ⚠️ **不带 note**：rules 里的 note 是内部溯源说明（带文档编号与原文引用）⇒ 不进公开页。
 *    「本赛段不做硬性交付要求」这件事由 hardRequirement（布尔）表达。
 * @param {object} stage
 * @returns {{title:string,items:string[],hardRequirement:boolean}}
 */
export function landingSpineDetail(stage) {
  const s = stage ?? {};
  const items = Array.isArray(s.deliverables) ? s.deliverables.map((d) => String(d)) : [];
  return {
    title: `${s.key ? `${s.key} · ` : ''}${s.name ?? ''}`.trim() || '赛段',
    items,
    hardRequirement: s.hardRequirement !== false,
  };
}

/**
 * 权重条（评分维度）。
 * ⚠️ 权重是赛制里最该被「看见」的数字 ⇒ 给它一条**真实的比例条**，
 *    而不是只写一个百分数。
 * ⚠️ seat（评委席 / 企业席）要显示出来 —— 「谁打这一分」是参赛者最关心的问题之一。
 *
 * @param {Array<object>} dimensions
 * @returns {Array<{key:string,label:string,seat:string,value:number,text:string}>}
 */
export function landingWeightBars(dimensions) {
  return (Array.isArray(dimensions) ? dimensions : []).map((d) => ({
    key: String(d?.key ?? ''),
    label: String(d?.name ?? ''),
    seat: String(d?.seat ?? ''),
    value: Number(d?.weight) || 0,
    text: pctText(d?.weight),
  }));
}

/** 席位的中文名（配置里是英文键）。 */
export function seatLabel(seat) {
  const map = { judge: '评委席', enterprise: '企业席', self: '自评', observer: '观察员' };
  return map[String(seat ?? '')] ?? (seat ? String(seat) : '—');
}

/**
 * 段位阶（ladder）。
 * ⚠️ 权益取自 rules.ranks.benefits；某段位没有权益时**明说**「暂无额外权益」，
 *    不留空白（空白读起来像"没加载出来"）。
 *
 * @param {Array<object>} tiers
 * @returns {Array<{key:string,name:string,requirement:string,benefits:string[]}>}
 */
export function landingLadderSteps(tiers) {
  return (Array.isArray(tiers) ? tiers : []).map((t) => {
    const reqs = [];
    if (Number(t?.minMilestones) > 0) reqs.push(`里程碑 ≥ ${t.minMilestones}`);
    if (t?.requiresDataOrPrototype === true) reqs.push('需数据接入或原型里程碑');
    if (t?.requiresBusinessSignoff === true) reqs.push('需企业签字');
    return {
      key: String(t?.key ?? ''),
      name: String(t?.name ?? ''),
      requirement: reqs.join(' · '),
      benefits: Array.isArray(t?.benefits) ? t.benefits.map((b) => String(b)) : [],
    };
  });
}

/**
 * 漏斗（流）。
 * ⚠️ rate 为 null 表示「比例待定」（rules 里辅导期就是 null）⇒ 显示「—」，
 *    **不许显示 0%**（0% 会被读成「这一届一个人都进不去」）。
 * @param {Array<object>} funnel
 * @returns {Array<{key:string,label:string,rate:number|null,text:string}>}
 */
export function landingFunnelStages(funnel) {
  return (Array.isArray(funnel) ? funnel : []).map((f) => ({
    key: String(f?.key ?? ''),
    label: String(f?.label ?? ''),
    rate: f?.rate === null || f?.rate === undefined ? null : Number(f.rate),
    text: f?.rate === null || f?.rate === undefined ? '—' : pctText(f.rate),
  }));
}

/**
 * 破同分链（有序）。
 * @param {Array<object>} chain
 * @returns {Array<{order:number,label:string,scope:string,scopeText:string}>}
 */
export function landingChainItems(chain) {
  const scopeText = { always: '始终参与', tied_only: '仅同分时', final_only: '仅决赛' };
  return (Array.isArray(chain) ? chain : []).map((c, i) => ({
    order: Number(c?.order) || i + 1,
    label: String(c?.label ?? ''),
    scope: String(c?.scope ?? ''),
    scopeText: scopeText[String(c?.scope ?? '')] ?? '',
  }));
}

/**
 * CTA：访客看到「报名」，已登录看到「工作台」。
 * ⚠️ **每个 href 都必须命中真实路由**（死链闸见 test/web-landing.test.js）。
 * @param {object|null} user
 * @returns {{primary:{href:string,label:string}, secondary:Array<{href:string,label:string}>}}
 */
export function landingCta(user) {
  if (user) {
    return {
      primary: { href: '#/dashboard', label: '进入工作台' },
      secondary: [
        { href: '#/team', label: '我的战队' },
        { href: '#/leaderboard', label: '看榜单' },
      ],
    };
  }
  return {
    primary: { href: '#/apply', label: '立即报名' },
    secondary: [
      { href: '#/leaderboard', label: '看榜单' },
      { href: '#/login', label: '已有账号，登录' },
    ],
  };
}

/** CTA 下方那句说明（按登录态变化）。 */
export function landingCtaNote(user) {
  return user
    ? '登录后可以直接报名、组队、领任务，并实时看到自己队伍的积分与段位。'
    : '报名需填三维度画像问卷（方向 / 能力 / 协作），提交后由组委会分级。';
}

// ─────────────────────────────────────────────────────────────────────
// HTML 片段（纯函数）
// ─────────────────────────────────────────────────────────────────────

/** 关键数字行 HTML。 */
export function landingStatsHtml(stats) {
  return `<div class="landing__stats">${(stats ?? []).map((s) => `
    <div class="landing__stat">
      <p class="landing__stat-value" data-count-to="${escapeHtml(s.value)}">${escapeHtml(s.value)}</p>
      <p class="landing__stat-label">${escapeHtml(s.label)}</p>
    </div>`).join('')}</div>`;
}

/** 赛程脊 HTML。detail 为**初始**（第一个赛段）的详情 ⇒ 无 JS 时也有内容。 */
export function landingSpineHtml(nodes, detail) {
  return `<div class="spine" data-spine>
    ${(nodes ?? []).map((n, i) => `
      <button type="button" class="spine__node${i === 0 ? ' is-active' : ''}"
              data-stage-key="${escapeHtml(n.key)}" aria-pressed="${i === 0 ? 'true' : 'false'}">
        <span class="spine__node-head">
          <span class="spine__node-key">${escapeHtml(n.key)}</span>
          <span class="spine__node-name">${escapeHtml(n.name)}</span>
        </span>
        <span class="spine__node-date">${escapeHtml(n.date)}</span>
      </button>`).join('')}
    <div class="spine__detail" data-spine-detail>${landingSpineDetailHtml(detail)}</div>
  </div>`;
}

/** 权重条 HTML。 */
export function landingWeightBarsHtml(bars) {
  return `<div class="weightbars">${(bars ?? []).map((b) => `
    <div class="weightbar" data-dim-key="${escapeHtml(b.key)}">
      <span class="weightbar__label">${escapeHtml(b.label)}
        <span class="weightbar__seat">${escapeHtml(seatLabel(b.seat))}</span>
      </span>
      <span class="weightbar__track"><span class="weightbar__fill" style="--w:${escapeHtml(b.text)}"></span></span>
      <span class="weightbar__value">${escapeHtml(b.text)}</span>
    </div>`).join('')}</div>`;
}

/** 段位阶 HTML。 */
export function landingLadderHtml(steps) {
  return `<div class="ladder">${(steps ?? []).map((s) => `
    <div class="ladder__step" data-tier-key="${escapeHtml(s.key)}">
      <span class="ladder__key">${escapeHtml(s.key)}</span>
      <span class="ladder__name">${escapeHtml(s.name)}
        ${s.requirement ? `<span class="ladder__req">${escapeHtml(s.requirement)}</span>` : ''}
      </span>
      ${s.benefits.length
        ? `<ul class="ladder__benefits">${s.benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '<span class="ladder__none">暂无额外权益</span>'}
    </div>`).join('')}</div>`;
}

/** 漏斗 HTML。 */
export function landingFunnelHtml(stages) {
  return `<div class="funnel">${(stages ?? []).map((s) => `
    <div class="funnel__stage">
      <span class="funnel__label">${escapeHtml(s.label)}</span>
      <span class="funnel__track"><span class="funnel__bar" style="--w:${escapeHtml(s.rate === null ? '0' : s.text)}"></span></span>
      <span class="funnel__rate">${escapeHtml(s.text)}</span>
    </div>`).join('')}</div>`;
}

/** 破同分链 HTML。 */
export function landingChainHtml(items) {
  return `<div class="chain">${(items ?? []).map((c) => `
    <span class="chain__item">
      <span class="chain__order">${escapeHtml(c.order)}</span>
      <span>${escapeHtml(c.label)}</span>
      ${c.scopeText ? `<span class="chain__scope">${escapeHtml(c.scopeText)}</span>` : ''}
    </span>`).join('')}</div>`;
}

/** 合规红线 HTML。 */
export function landingRedlinesHtml(redlines) {
  return `<ul class="redlines">${(redlines ?? []).map((r) => `
    <li><span class="redlines__mark" aria-hidden="true">▸</span><span>${escapeHtml(r.label)}</span></li>`).join('')}</ul>`;
}

// ─────────────────────────────────────────────────────────────────────
// 交互层
// ─────────────────────────────────────────────────────────────────────

/** 动效是否允许（尊重系统的「减少动态效果」设置）。 */
function motionAllowed() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 数字 count-up。
 * ⚠️ 必须**先显示终值**再动画：从 0 数上去会在读屏与「复制文本」时暴露错误数字。
 *    这里保留终值在 DOM 里（data-count-to），动画只改 textContent。
 */
function countUp(el) {
  const target = Number(el.getAttribute('data-count-to'));
  if (!Number.isFinite(target)) return;
  if (!motionAllowed()) { el.textContent = String(target); return; }
  const duration = 700;
  const start = performance.now?.() ?? 0;
  const step = (now) => {
    const t = Math.min(1, ((now ?? start) - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = String(target);
  };
  requestAnimationFrame(step);
}

/**
 * 挂上落地页的全部交互。
 * ⛔ **每一个交互都必须在「没有对应 API」时安静降级**（测试里没有 DOM / IntersectionObserver）。
 * @param {HTMLElement} wrap 视图根
 * @param {object} ctx      应用上下文
 */
export function wireLanding(wrap, ctx) {
  if (!wrap || typeof wrap.querySelectorAll !== 'function') return;

  // ① 赛程脊点选 → 详情切换
  const spine = wrap.querySelector('[data-spine]');
  const detailBox = wrap.querySelector('[data-spine-detail]');
  const stageMap = new Map((ctx?.landingStages ?? []).map((s) => [String(s.key), s]));
  spine?.addEventListener?.('click', (e) => {
    const btn = e?.target?.closest?.('[data-stage-key]');
    if (!btn || !stageMap.size) return;
    const key = btn.getAttribute('data-stage-key');
    const stage = stageMap.get(key);
    if (!stage) return;
    for (const node of spine.querySelectorAll('[data-stage-key]')) {
      const on = node === btn;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (detailBox) detailBox.innerHTML = landingSpineDetailHtml(landingSpineDetail(stage));
  });

  // ② 初赛 / 决赛**同维度**联动高亮（企业确认 10% → 25% 这类对比，一眼看懂）
  const bars = wrap.querySelectorAll('[data-dim-key]');
  for (const bar of bars) {
    bar.addEventListener?.('mouseenter', () => {
      const key = bar.getAttribute('data-dim-key');
      for (const other of bars) {
        other.classList.toggle('is-active', other.getAttribute('data-dim-key') === key);
      }
    });
    bar.addEventListener?.('mouseleave', () => {
      for (const other of bars) other.classList.remove('is-active');
    });
  }

  // ③ Hero 指针辉光
  const hero = wrap.querySelector('.landing__hero');
  hero?.addEventListener?.('pointermove', (e) => {
    if (!motionAllowed()) return;
    const rect = hero.getBoundingClientRect?.();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    hero.style.setProperty('--glow-x', `${Math.max(0, Math.min(100, x))}%`);
    hero.style.setProperty('--glow-y', `${Math.max(0, Math.min(100, y))}%`);
  });

  // ④ 进入视口：揭示 + 数字 count-up + 漏斗伸展
  const revealables = wrap.querySelectorAll('.reveal, .landing__stat-value, .funnel__bar');
  if (typeof IntersectionObserver === 'undefined') {
    for (const el of revealables) {
      el.classList?.add('is-revealed');
      if (el.classList?.contains('landing__stat-value')) countUp(el);
    }
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      el.classList?.add('is-revealed');
      if (el.classList?.contains('landing__stat-value')) countUp(el);
      io.unobserve(el);
    }
  }, { threshold: 0.15 });
  for (const el of revealables) io.observe(el);
}

/** 赛程详情面板的 HTML（点选后重绘用）。 */
export function landingSpineDetailHtml(detail) {
  const items = (detail?.items ?? []).map((d) => `<li>${escapeHtml(d)}</li>`).join('');
  const hard = detail?.hardRequirement === false
    ? '<p class="spine__detail-note">本赛段不做硬性交付要求</p>'
    : '';
  return `<p class="spine__detail-title">${escapeHtml(detail?.title ?? '')}</p>
    ${items ? `<ul class="spine__detail-list">${items}</ul>` : '<p class="spine__detail-note">本赛段无固定交付物清单。</p>'}
    ${hard}`;
}

// ─────────────────────────────────────────────────────────────────────
// 视图
// ─────────────────────────────────────────────────────────────────────

/**
 * 落地页视图。
 *
 * ⚠️ **同步渲染骨架，异步补数据**：首屏立刻有内容（骨架屏），
 *    弱网下也不白屏；赛制数据到位后再替换。
 * ⚠️ **未登录 100% 可用**：不请求任何需要登录态的端点（契约 M6）。
 *
 * @param {object} ctx 应用上下文（{ api, navigate, setState, getState }）
 * @returns {HTMLElement}
 */
export function renderLanding(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'landing';
  const { user } = ctx.getState();
  const cta = landingCta(user);

  wrap.innerHTML = `
    <section class="landing__hero">
      <div class="landing__hero-grid">
        <div>
          <p class="landing__eyebrow">华东区 · AI 商业黑客松</p>
          <p class="landing__hello">${user
            ? `已登录：<strong>${escapeHtml(user.name || '')}</strong>`
            : '<span class="muted">未登录</span> —— 登录后可报名、组队、领任务'}</p>
          <h1 class="landing__title">把一个真实的商业问题，<br />做成能被企业接住的方案</h1>
          <p class="landing__lede">
            五段赛程、六个评审维度、公开的破同分链 —— 赛制全部写在明处。
            你和评委看的是同一张评分表。
          </p>
          <div class="landing__cta">
            <a class="btn btn--primary" href="${escapeHtml(cta.primary.href)}">${escapeHtml(cta.primary.label)}</a>
            ${cta.secondary.map((s) => `<a class="btn btn--ghost" href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a>`).join('')}
            <p class="landing__cta-note">${escapeHtml(landingCtaNote(user))}</p>
          </div>
          <div id="landing-stats">${loadingState({ rows: 1, label: '正在汇总赛事数据…' })}</div>
        </div>
        <div>
          <p class="landing__eyebrow">赛程</p>
          <div id="landing-spine">${loadingState({ rows: 2, label: '正在加载赛程…' })}</div>
        </div>
      </div>
    </section>

    <section class="landing__section" id="landing-rules">
      <div class="landing__section-head">
        <p class="landing__eyebrow">赛制 · 怎么算</p>
        <h2 class="landing__section-title">每一分从哪来，权重是多少</h2>
        <p class="landing__section-desc">
          初赛与决赛各有一张权重表。把鼠标移到任一维度上，两张表里的同名维度会一起亮起 ——
          权重怎么随赛段变化的，一眼就能看出来。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile">
          <div class="ruletile__head">
            <h3 class="ruletile__title">初赛权重表</h3>
            <span class="ruletile__meta" id="landing-initial-meta"></span>
          </div>
          <div id="landing-initial"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head">
            <h3 class="ruletile__title">决赛权重表</h3>
            <span class="ruletile__meta" id="landing-final-meta"></span>
          </div>
          <div id="landing-final"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">同分怎么决</h3></div>
          <p class="ruletile__desc">破同分链按顺序用，队伍编号是唯一的确定性兜底 —— 同样的输入，永远得出同样的名次。</p>
          <div id="landing-chain"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">过程参与度</h3></div>
          <p class="ruletile__desc">行为分只用于破同分，占评审分比重有上限 —— 认真过程有用，但不会盖过结果。</p>
          <div id="landing-behavior"></div>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">赛程与晋级</p>
        <h2 class="landing__section-title">五段赛程，各有交付物</h2>
        <p class="landing__section-desc">
          点左侧任意赛段看它的交付物。晋级按入围率与决赛名额两个数字定，不靠印象。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile ruletile--wide">
          <div class="ruletile__head">
            <h3 class="ruletile__title">赛段一览</h3>
            <span class="ruletile__meta" id="landing-advancement"></span>
          </div>
          <div id="landing-stage-table"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">名次与积分</h3></div>
          <div id="landing-points"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">晋级口径</h3></div>
          <div id="landing-advancement-detail"></div>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">段位与权益</p>
        <h2 class="landing__section-title">走过的每一步都算数</h2>
        <p class="landing__section-desc">
          段位由里程碑与企业签字决定，权益随段位解锁。
        </p>
      </div>
      <div class="rulegrid">
        <article class="ruletile ruletile--wide">
          <div class="ruletile__head"><h3 class="ruletile__title">段位表</h3></div>
          <div id="landing-ladder"></div>
          <p class="ruletile__desc" id="landing-never" style="margin-top:var(--sp-4)"></p>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">报名与筛选</p>
        <h2 class="landing__section-title">谁会进来看你</h2>
        <p class="landing__section-desc">
          报名先过三维度画像问卷，再进五段漏斗。每一段的比例都写在明处。
        </p>
      </div>
      <div class="rulegrid rulegrid--2">
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">筛选漏斗</h3></div>
          <div id="landing-funnel"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">报名画像</h3></div>
          <div id="landing-profile"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">分级门槛</h3></div>
          <div id="landing-levels"></div>
        </article>
        <article class="ruletile">
          <div class="ruletile__head"><h3 class="ruletile__title">组队规则</h3></div>
          <div id="landing-formation"></div>
        </article>
      </div>
    </section>

    <section class="landing__section">
      <div class="landing__section-head">
        <p class="landing__eyebrow">合规</p>
        <h2 class="landing__section-title">红线写在报名之前</h2>
        <p class="landing__section-desc">知识产权、数据出境、AI 生成内容标注、身份真实 —— 四条红线，报名即确认。</p>
      </div>
      <div class="rulegrid">
        <article class="ruletile ruletile--wide">
          <div id="landing-redlines"></div>
        </article>
      </div>
    </section>

    <section class="ctaband">
      <div>
        <h2 class="ctaband__title">${user ? '回到你的赛事现场' : '先占一个位置'}</h2>
        <p class="ctaband__desc">${escapeHtml(landingCtaNote(user))}</p>
      </div>
      <div class="ctaband__actions">
        <a class="btn btn--primary" href="${escapeHtml(cta.primary.href)}">${escapeHtml(cta.primary.label)}</a>
        ${cta.secondary.map((s) => `<a class="btn btn--ghost" href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a>`).join('')}
      </div>
    </section>

    <footer class="landing__footer">
      <span>华东区 AI 商业黑客松 · 赛事平台</span>
      <span class="landing__footer-links">
        <a href="#/leaderboard">榜单</a>
        <a href="#/tier">段位榜</a>
        <a href="#/login">登录</a>
      </span>
    </footer>`;

  const statsBox = wrap.querySelector('#landing-stats');
  const spineBox = wrap.querySelector('#landing-spine');

  // ⚠️ 两个请求**并行**，且都不需要登录态（契约 M6）。
  const infoP = ctx.api.get('/api/event-info');
  const boardP = ctx.api.get('/api/leaderboard/rolling').catch(() => null);

  Promise.all([infoP, boardP]).then(([info, board]) => {
    if (!info) return;
    ctx.landingStages = info.stages ?? [];
    const boardCount = board ? (board.rows ?? []).length : null;

    if (statsBox) statsBox.innerHTML = landingStatsHtml(landingStats({ info, boardCount }));

    const nodes = landingSpineNodes(info.stages);
    if (spineBox) {
      spineBox.innerHTML = nodes.length
        ? landingSpineHtml(nodes, landingSpineDetail(nodes[0].raw))
        : '<p class="muted small">赛程尚未公布。</p>';
    }

    const initialBars = landingWeightBars(info.scoring?.initial?.dimensions);
    const finalBars = landingWeightBars(info.scoring?.final?.dimensions);
    const initialBox = wrap.querySelector('#landing-initial');
    const finalBox = wrap.querySelector('#landing-final');
    if (initialBox) initialBox.innerHTML = landingWeightBarsHtml(initialBars);
    if (finalBox) finalBox.innerHTML = landingWeightBarsHtml(finalBars);
    const initialMeta = wrap.querySelector('#landing-initial-meta');
    const finalMeta = wrap.querySelector('#landing-final-meta');
    if (initialMeta) initialMeta.textContent = `${initialBars.length} 个维度`;
    if (finalMeta) finalMeta.textContent = `${finalBars.length} 个维度`;

    const chainBox = wrap.querySelector('#landing-chain');
    if (chainBox) chainBox.innerHTML = landingChainHtml(landingChainItems(info.tiebreak));

    const behaviorBox = wrap.querySelector('#landing-behavior');
    if (behaviorBox) {
      const items = (info.behaviorEvents ?? []).map((e) => `
        <div class="chain__item">
          <span>${escapeHtml(e.label)}</span>
          <span class="chain__order">+${escapeHtml(e.points)}</span>
        </div>`).join('');
      behaviorBox.innerHTML = `<div class="chain">${items}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          行为分在总分里的占比上限 ${escapeHtml(pctText(info.behaviorMaxWeightShare))}，且只用于破同分。
        </p>`;
    }

    const advBox = wrap.querySelector('#landing-advancement');
    if (advBox) {
      advBox.textContent = `入围率 ${pctText(info.advancement?.rate)} · 决赛 TOP ${info.advancement?.finalTopN ?? '—'}`;
    }

    const tableBox = wrap.querySelector('#landing-stage-table');
    if (tableBox) {
      const rows = nodes.map((n) => `
        <tr>
          <td class="mono">${escapeHtml(n.key)}</td>
          <td>${escapeHtml(n.name)}</td>
          <td class="mono">${escapeHtml(n.date)}</td>
          <td>${escapeHtml((n.raw?.deliverables ?? []).join('、') || '—')}</td>
        </tr>`).join('');
      tableBox.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr><th>赛段</th><th>名称</th><th>时间</th><th>交付物</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    }

    const pointsBox = wrap.querySelector('#landing-points');
    if (pointsBox) {
      const sp = info.scoringPoints ?? {};
      const pts = (sp.stagePoints ?? []).map((n) => `<span class="chain__item"><span class="chain__order">${escapeHtml(n)}</span><span>分</span></span>`).join('');
      pointsBox.innerHTML = `<div class="chain">${pts}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          每个赛段只给前 ${escapeHtml(sp.stagePointsOnlyTopN ?? '—')} 名记名次积分；
          MVP 取 ${escapeHtml(sp.mvpStagesCounted ?? '—')} 个赛段的名次积分之和。
        </p>`;
    }

    const advDetailBox = wrap.querySelector('#landing-advancement-detail');
    if (advDetailBox) {
      const a = info.advancement ?? {};
      const vis = info.visibility?.publicFromTier ?? '';
      advDetailBox.innerHTML = `<ul class="redlines">
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>赛段晋级按入围率 <strong>${escapeHtml(pctText(a.rate))}</strong></span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>决赛名额 <strong>TOP ${escapeHtml(a.finalTopN ?? '—')}</strong></span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>榜单分层公开：${vis ? `${escapeHtml(vis)} 段及以上` : '按组委口径'}</span></li>
      </ul>`;
    }

    const ladderBox = wrap.querySelector('#landing-ladder');
    if (ladderBox) ladderBox.innerHTML = landingLadderHtml(landingLadderSteps(info.tiers));
    const neverBox = wrap.querySelector('#landing-never');
    if (neverBox) {
      const never = info.tierNeverUnlocks ?? [];
      neverBox.textContent = never.length
        ? `段位权益不解锁：${never.join('、')} —— 名次与奖金只看评审分。`
        : '';
    }

    const funnelBox = wrap.querySelector('#landing-funnel');
    if (funnelBox) funnelBox.innerHTML = landingFunnelHtml(landingFunnelStages(info.funnel));

    const profileBox = wrap.querySelector('#landing-profile');
    if (profileBox) {
      const dims = (info.registration?.dimensions ?? []).map((d) => `
        <div class="weightbar">
          <span class="weightbar__label">${escapeHtml(d.label)}</span>
          <span class="weightbar__track"><span class="weightbar__fill" style="--w:${escapeHtml(pctText(d.weight))}"></span></span>
          <span class="weightbar__value">${escapeHtml(pctText(d.weight))}</span>
        </div>`).join('');
      profileBox.innerHTML = `<div class="weightbars">${dims}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          三个维度各 5 题、1–5 分制，加权后折算百分制。
        </p>`;
    }

    const levelsBox = wrap.querySelector('#landing-levels');
    if (levelsBox) {
      const levels = (info.registration?.levels ?? []).map((l) => `
        <span class="chain__item">
          <span class="chain__order">${escapeHtml(l.key)}</span>
          <span>${escapeHtml(l.label)}</span>
          <span class="chain__scope">≥ ${escapeHtml(l.minScore)} 分</span>
        </span>`).join('');
      levelsBox.innerHTML = `<div class="chain">${levels}</div>
        <p class="ruletile__desc" style="margin-top:var(--sp-3)">
          分级由问卷分数决定，组委会可复核改级；改级会留痕。
        </p>`;
    }

    const formationBox = wrap.querySelector('#landing-formation');
    if (formationBox) {
      const f = info.formation ?? {};
      formationBox.innerHTML = `<ul class="redlines">
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>每队 ${escapeHtml(f.teamMin)}–${escapeHtml(f.teamMax)} 人</span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>${f.captainMustBeMba ? '队长须为 MBA' : '队长无学历限制'}</span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>每个任务包 ${escapeHtml(f.teamsPerPackageMin)}–${escapeHtml(f.teamsPerPackageMax)} 支队伍</span></li>
        <li><span class="redlines__mark" aria-hidden="true">▸</span><span>任务包配额：企业命题 ${escapeHtml(pctText(f.enterpriseQuota))} / 自由命题 ${escapeHtml(pctText(f.freeQuota))}</span></li>
      </ul>`;
    }

    const redlinesBox = wrap.querySelector('#landing-redlines');
    if (redlinesBox) redlinesBox.innerHTML = landingRedlinesHtml(info.redLines);

    wireLanding(wrap, ctx);
  }).catch((e) => {
    const message = friendlyError(e, '赛事信息加载失败');
    if (spineBox) {
      spineBox.innerHTML = errorState({ message, hint: '赛程与权重表暂时读不到，刷新页面可重试。' });
      // ⚠️ 全链路可选链：这个 catch 会在**任何** DOM 环境下跑（包括测试用的最小桩），
      //    直接写 `spineBox.querySelector(...)` 会在桩上抛 TypeError
      //    ⇒ 抛出的新异常没人接 ⇒ 变成 unhandledRejection ⇒ **把别的用例搞挂**。
      spineBox.querySelector?.('[data-action="retry"]')?.addEventListener?.('click', () => {
        globalThis.location?.reload?.();
      });
    }
    if (statsBox) statsBox.innerHTML = '';
  });

  return wrap;
}
```

### T7 落地页行为闸

**Step: 创建 `platform/test/web-landing.test.js`**

```js
// platform/test/web-landing.test.js —— 落地页（首页）的行为闸
//
// 规则溯源：
//   - 「要有落地页，也就是首页，首页用来介绍赛事和赛制，吸引报名」→ P9 用户指令
//   - 「赛制全部配置化」→ 全局约束（规则只有 rules/*.json 一个出处）
//   - 「可见性在 API 层过滤」/「前端只判登录态」→ 全局约束（DP-77）
//
// ⚠️ 本文件为什么存在：
//   落地页是**访客的第一印象**，也是**赛制对外唯一的公开表述**。
//   两类事故肉眼极难发现、但用户一定看得见：
//     ① 赛制数字在前端被硬编码 ⇒ 委员会改了 rules/*.json，落地页还在说旧话（口径撒谎）；
//     ② 落地页里出现一个指向不存在路由的链接 ⇒ 访客点下去是「页面不存在」；
//     ③ 登录态相关的东西漏进未登录页 ⇒ 访客看到「需要登录」或 401 错误态。
//   ⇒ 全部变成**可复算的机器闸**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  landingStats, landingSpineNodes, landingSpineDetail, landingWeightBars, seatLabel,
  landingLadderSteps, landingFunnelStages, landingChainItems, landingCta, landingCtaNote,
  landingStatsHtml, landingSpineHtml, landingSpineDetailHtml, landingWeightBarsHtml, landingLadderHtml,
  landingFunnelHtml, landingChainHtml, landingRedlinesHtml, renderLanding, pctText,
} from '../web/views/landing.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const APP_JS = readFileSync(join(webDir, 'app.js'), 'utf8');
const NAV_JS = readFileSync(join(webDir, 'nav.js'), 'utf8');
const LANDING_JS = readFileSync(join(webDir, 'views', 'landing.js'), 'utf8');
const STYLES_CSS = readFileSync(join(webDir, 'styles.css'), 'utf8');

/** 路由表：从 app.js 的 route('...') 调用点**扫出来**（手写清单会漏）。 */
const ROUTES = [...APP_JS.matchAll(/route\(\s*'([^']+)'/g)].map((m) => m[1]);

/** 路由模式匹配（支持 :param 段）。 */
function routeMatches(pattern, path) {
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return false;
  return pp.every((seg, i) => seg.startsWith(':') || seg === xp[i]);
}

/** 某个 hash 链接（#/xxx）有没有对应的路由。 */
function hasRoute(hashPath) {
  const clean = String(hashPath).replace(/^#/, '').replace(/\?.*$/, '');
  return ROUTES.some((r) => routeMatches(r, clean));
}

/** 剥掉注释（只扫代码，不扫注释里的说明文字）。 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ══════════════════════════════════════════════════════════════════
// 一、路由与信息架构
// ══════════════════════════════════════════════════════════════════

test('落地页挂在 /，原总览仪表盘迁到 /dashboard（两者并存）', () => {
  assert.ok(ROUTES.includes('/'), '必须有落地页路由 /');
  assert.ok(ROUTES.includes('/dashboard'), '必须保留 /dashboard（工作台）');
  assert.ok(
    /route\('\/',\s*\(\w+\)\s*=>\s*renderLanding\(\w+\)\)/.test(APP_JS),
    '/ 必须挂 renderLanding',
  );
  assert.ok(
    /route\('\/dashboard',\s*\(\w+\)\s*=>\s*renderHome\(\w+\)\)/.test(APP_JS),
    '/dashboard 必须挂 renderHome（原总览仪表盘，一行内容没删）',
  );
});

test('导航里必须有「工作台」入口，且指向 /dashboard', () => {
  assert.ok(/path:\s*'\/dashboard'/.test(NAV_JS), '导航必须提供 /dashboard 入口');
  assert.ok(/label:\s*'工作台'/.test(NAV_JS));
  assert.ok(/label:\s*'首页'/.test(NAV_JS), '「赛事」分区的第一项必须是首页');
});

test('落地页不需要登录（公开页）—— /dashboard 才需要登录', () => {
  assert.ok(
    /PROTECTED_ROUTES[\s\S]*?pattern:\s*\/\^\\\/dashboard/.test(NAV_JS),
    '/dashboard 必须受登录守卫保护',
  );
  const guardSection = NAV_JS.slice(NAV_JS.indexOf('PROTECTED_ROUTES'));
  const patterns = [...guardSection.matchAll(/pattern:\s*(\/\^[^\n]+)/g)].map((m) => m[1]);
  assert.ok(
    !patterns.some((p) => /\\\/\$/.test(p) && !p.includes('dashboard')),
    `根路径不得进受保护清单（落地页对访客开放）：${patterns.join(' | ')}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// 二、死链闸：落地页里的每个 href 都必须命中真实路由
// ══════════════════════════════════════════════════════════════════

test('死链闸：落地页 CTA 的每个 href 都对应真实路由', () => {
  for (const user of [null, { name: '张三' }, { roles: ['admin'] }]) {
    const cta = landingCta(user);
    const all = [cta.primary, ...cta.secondary];
    for (const l of all) {
      assert.ok(hasRoute(l.href), `死链：CTA 指向 ${l.href}，但路由表里没有（现有：${ROUTES.join(', ')}）`);
    }
  }
});

test('死链闸：落地页渲染出的 HTML 里每个 href 都对应真实路由', async () => {
  const html = await renderLandingHtml();
  const hrefs = [...html.matchAll(/href="(#[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3, `落地页至少要有 3 个链接，实际 ${hrefs.length}`);
  for (const h of hrefs) {
    assert.ok(hasRoute(h), `死链：落地页出现 ${h}，但路由表里没有（现有：${ROUTES.join(', ')}）`);
  }
});

test('死链闸：主导航的每个 path 都对应真实路由（含新增的 /dashboard）', () => {
  const paths = [...NAV_JS.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 7, `导航里应该有 7 条以上的路径（漏扫说明正则失效），实际 ${paths.length}`);
  for (const p of paths) {
    assert.ok(hasRoute(p), `死链：导航项 ${p} 没有对应路由`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 三、赛制不得在前端硬编码
// ══════════════════════════════════════════════════════════════════

test('赛制口径闸：落地页源码里不得出现 rules 里的具体数字', () => {
  const code = codeOnly(LANDING_JS);
  // ⛔ 这些数字来自 rules/*.json（赛程日序、权重表、漏斗比例、晋级率…）
  //    前端写死任何个 = 口径撒谎（委员会改配置后落地页还在说旧话）。
  const forbidden = ['10-01', '10-26', '10-29', '0.10', '0.20', '0.25', '0.35', '0.40', '0.05', '0.30'];
  for (const n of forbidden) {
    assert.ok(!code.includes(n), `落地页不许硬编码赛制数字「${n}」（必须来自 /api/event-info）`);
  }
});

test('赛制口径闸：落地页必须从 /api/event-info 取赛制', () => {
  const code = codeOnly(LANDING_JS);
  assert.ok(code.includes('/api/event-info'), '必须请求 /api/event-info');
});

// ══════════════════════════════════════════════════════════════════
// 四、纯函数：形状与口径
// ══════════════════════════════════════════════════════════════════

test('百分比：0.10 → 10%，0.05 → 5%，0.125 → 12.5%', () => {
  assert.equal(pctText(0.1), '10%');
  assert.equal(pctText(0.05), '5%');
  assert.equal(pctText(0.125), '12.5%');
  assert.equal(pctText(0), '0%');
  assert.equal(pctText(undefined), '—');
});

test('关键数字：固定 4 张卡，且数字与标签成对（不许错位）', () => {
  const stats = landingStats({
    info: { stages: [1, 2, 3, 4, 5], scoring: { initial: { dimensions: [1, 2, 3, 4, 5, 6] } }, tiers: [1, 2, 3, 4, 5] },
    boardCount: 12,
  });
  assert.equal(stats.length, 4);
  assert.deepEqual(stats.map((s) => s.label), ['赛段', '评审维度', '段位', '在榜队伍']);
  assert.deepEqual(stats.map((s) => s.value), [5, 6, 5, 12]);
});

test('关键数字：取不到数时用「—」占位（不是 undefined）', () => {
  const stats = landingStats({ info: {}, boardCount: null });
  assert.equal(stats.length, 4, '卡片数量不许变（变了标签就会错位 —— DP-89）');
  assert.ok(!stats.some((s) => s.value === undefined), '不许出现 undefined');
  assert.equal(stats.at(-1).value, '—');
});

test('赛程脊：节点带 key / 名称 / 日期（日期直接用 rules 的相对日序）', () => {
  const nodes = landingSpineNodes([
    { key: 'S1', name: '调研', start: '10-01', end: '10-10', deliverables: ['企业问题确认书'] },
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].key, 'S1');
  assert.equal(nodes[0].name, '调研');
  assert.equal(nodes[0].date, '10-01 – 10-10');
});

test('赛程详情：交付物来自 rules，且非硬性赛段要说明', () => {
  const d = landingSpineDetail({
    key: 'S5', name: '落地', deliverables: ['试点或意向确认'], hardRequirement: false,
  });
  assert.equal(d.title, 'S5 · 落地');
  assert.deepEqual(d.items, ['试点或意向确认']);
  assert.equal(d.hardRequirement, false);
  // ⚠️ 详情里**不许有 note**：rules 的 note 是内部溯源说明（带文档编号）⇒ 不进公开页。
  assert.equal(d.note, undefined, '公开投影不得带 rules 的原始 note');
  const html = landingSpineDetailHtml(d);
  assert.ok(html.includes('不做硬性交付要求'), '非硬性赛段要说明');
});

test('权重条：权重取自维度，百分比正确，席位中文化', () => {
  const bars = landingWeightBars([
    { key: 'enterprise', name: '企业确认', weight: 0.1, seat: 'enterprise' },
    { key: 'self_eval', name: '自评测', weight: 0.05, seat: 'self' },
  ]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].text, '10%');
  assert.equal(bars[1].text, '5%');
  assert.equal(seatLabel('enterprise'), '企业席');
  assert.equal(seatLabel('judge'), '评委席');
  assert.equal(seatLabel('self'), '自评');
  assert.equal(seatLabel('unknown'), 'unknown');
});

test('段位阶：无权益的段位要明说「暂无额外权益」（不留空白）', () => {
  const steps = landingLadderSteps([
    { key: 'S', name: '验证', minMilestones: 5, requiresBusinessSignoff: true, benefits: ['完赛证明'] },
    { key: 'D', name: '出题', minMilestones: 0, benefits: [] },
  ]);
  assert.ok(steps[0].requirement.includes('里程碑 ≥ 5'));
  assert.ok(steps[0].requirement.includes('需企业签字'));
  assert.deepEqual(steps[0].benefits, ['完赛证明']);
  assert.deepEqual(steps[1].benefits, []);
  const html = landingLadderHtml(steps);
  assert.ok(html.includes('暂无额外权益'), '空白会被读成「没加载出来」');
});

test('漏斗：rate 为 null 时显示「—」（不许显示 0%）', () => {
  const stages = landingFunnelStages([
    { key: 'registration', label: '报名筛选', rate: 0.3 },
    { key: 'coaching', label: '辅导期', rate: null },
  ]);
  assert.equal(stages[0].text, '30%');
  assert.equal(stages[1].text, '—');
  assert.equal(stages[1].rate, null);
  const html = landingFunnelHtml(stages);
  // ⚠️ 判据要精确：`30%</span>` 里**含有** `0%</span>` ⇒ 直接子串匹配会误杀。
  //   所以这里断言「比例格里的内容**恰好**是 —」。
  assert.ok(html.includes('<span class="funnel__rate">—</span>'), 'null 比例的比例格必须显示 —');
  assert.ok(!html.includes('>0%</span>'), 'null 比例不得渲染成 0%');
});

test('破同分链：顺序号连续，作用域中文化', () => {
  const items = landingChainItems([
    { order: 1, key: 'total', label: '总分', scope: 'always' },
    { order: 2, key: 'peer', label: '互评分', scope: 'tied_only' },
  ]);
  assert.deepEqual(items.map((i) => i.order), [1, 2]);
  assert.equal(items[0].scopeText, '始终参与');
  assert.equal(items[1].scopeText, '仅同分时');
});

test('CTA：访客看到「立即报名」，登录后看到「进入工作台」', () => {
  assert.equal(landingCta(null).primary.href, '#/apply');
  assert.equal(landingCta(null).primary.label, '立即报名');
  assert.equal(landingCta({ name: '甲' }).primary.href, '#/dashboard');
  assert.equal(landingCta({ name: '甲' }).primary.label, '进入工作台');
  assert.ok(landingCtaNote(null).length > 0);
});

// ══════════════════════════════════════════════════════════════════
// 五、HTML 转义（服务端数据是外部输入）
// ══════════════════════════════════════════════════════════════════

test('转义闸：赛段名里的 HTML 必须被转义', () => {
  const nodes = landingSpineNodes([
    { key: 'S1', name: '<img src=x onerror=alert(1)>', start: '10-01', end: '10-10', deliverables: [] },
  ]);
  const html = landingSpineHtml(nodes, landingSpineDetail(nodes[0].raw));
  assert.ok(!/<img/i.test(html), '不得出现真实 img 标签');
  assert.ok(html.includes('&lt;img'));
});

test('转义闸：合规红线里的 HTML 必须被转义', () => {
  const html = landingRedlinesHtml([{ key: 'k', label: '<script>alert(1)</script>' }]);
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script'));
});

// ══════════════════════════════════════════════════════════════════
// 六、视图行为（DOM 桩）
// ══════════════════════════════════════════════════════════════════

const INFO = {
  stages: [
    { key: 'S1', name: '调研', start: '10-01', end: '10-10', deliverables: ['企业问题确认书'], hardRequirement: true },
    { key: 'S2', name: '任务', start: '10-10', end: '10-13', deliverables: ['任务清单'], hardRequirement: true },
  ],
  advancement: { rate: 0.25, finalTopN: 32 },
  scoring: {
    initial: { dimensions: [{ key: 'a', name: '创新性', weight: 0.2, seat: 'judge' }] },
    final: { dimensions: [{ key: 'a', name: '创新性', weight: 0.2, seat: 'judge' }] },
  },
  tiers: [{ key: 'S', name: '验证', minMilestones: 5, requiresBusinessSignoff: true, benefits: ['完赛证明'] }],
  tierNeverUnlocks: ['奖金', '决赛名次'],
  funnel: [{ key: 'registration', label: '报名筛选', rate: 0.3 }],
  registration: { dimensions: [{ key: 'direction', label: '方向维度', weight: 0.25 }], levels: [{ key: 'S', label: '顶级种子', minScore: 80 }] },
  formation: { teamMin: 2, teamMax: 5, captainMustBeMba: true, teamsPerPackageMin: 2, teamsPerPackageMax: 3, enterpriseQuota: 0.7, freeQuota: 0.3 },
  scoringPoints: { stagePoints: [10, 8, 5], stagePointsOnlyTopN: 3, mvpStagesCounted: 4 },
  tiebreak: [{ order: 1, key: 'total', label: '总分', scope: 'always' }],
  behaviorEvents: [{ key: 'weekly_progress', label: '每周提交一次进度', points: 2 }],
  behaviorMaxWeightShare: 0.1,
  redLines: [{ key: 'ip', label: '知识产权' }],
  visibility: { publicFromTier: 'C' },
};

/** 最小 DOM 桩：够 renderLanding 跑起来。 */
function stubDom() {
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    style: { setProperty() {} },
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  });
  globalThis.window = { location: { search: '', hash: '#/' }, addEventListener() {}, matchMedia: () => ({ matches: true }) };
  globalThis.document = { createElement: (t) => mk(t), getElementById: () => mk('div') };
}

async function bootLanding(user, apiImpl) {
  stubDom();
  const calls = [];
  const ctx = {
    api: {
      get: async (p) => { calls.push(p); return apiImpl ? apiImpl(p) : INFO; },
    },
    getState: () => ({ user }),
  };
  renderLanding(ctx);
  await new Promise((r) => setTimeout(r, 10));
  return calls;
}

test('落地页：请求 /api/event-info 与滚动总榜', async () => {
  const calls = await bootLanding(null);
  assert.ok(calls.includes('/api/event-info'), `必须请求赛制数据，实际：${JSON.stringify(calls)}`);
  assert.ok(calls.some((c) => c.includes('/api/leaderboard/rolling')), '必须请求在榜队伍数');
});

test('落地页：未登录时**不请求**任何需要登录态的端点', async () => {
  const calls = await bootLanding(null);
  for (const c of calls) {
    assert.ok(
      !c.includes('/api/teams') && !c.includes('/api/registrations'),
      `访客不该请求需要登录的端点：${c}`,
    );
  }
});

test('落地页：赛制接口失败时给出**带重试**的错误态（不许是死路）', async () => {
  stubDom();
  const ctx = {
    api: {
      get: async (p) => {
        if (p === '/api/event-info') throw new TypeError('Failed to fetch');
        return { rows: [] };
      },
    },
    getState: () => ({ user: null }),
  };
  renderLanding(ctx);
  await new Promise((r) => setTimeout(r, 10));
  const code = codeOnly(LANDING_JS);
  assert.ok(/data-action="retry"/.test(code), '错误态必须挂重试按钮');
  // ⚠️ 判据必须**钉在重试按钮自己的那一次绑定上**：
  //    `addEventListener?.('click'` 在本文件里出现多次（赛程节点点选也用 click）
  //    ⇒ 只断言「文件里有 click 绑定」会被那些无关绑定顶替 ⇒ 变异存活。
  assert.ok(
    /querySelector\?\.\('\[data-action="retry"\]'\)\?\.addEventListener\?\.\('click'/.test(code),
    '重试按钮必须真的绑定 click（且是它自己的那一次绑定）',
  );
});

// ══════════════════════════════════════════════════════════════════
// 七、交互：结构闸（DOM 桩无法模拟完整交互，故对源码断言）
// ══════════════════════════════════════════════════════════════════

test('交互闸：赛程脊必须绑定点击并切换详情', () => {
  const code = codeOnly(LANDING_JS);
  // ⚠️ 判据要钉在**节点模板的那一行**上：
  //    `data-stage-key` 在接线代码里也出现（getAttribute / querySelectorAll）
  //    ⇒ 只断言「文件里有这个字符串」会被接线代码顶替 ⇒ 变异存活。
  assert.ok(
    /<button[^>]*data-stage-key="\$\{escapeHtml\(n\.key\)\}"/.test(code),
    '赛程节点按钮必须带 data-stage-key',
  );
  assert.ok(/data-spine-detail/.test(code), '必须有详情容器');
  assert.ok(/is-active/.test(code), '选中的节点必须有活动态');
  assert.ok(/aria-pressed/.test(code), '选中态必须同步 aria-pressed（读屏用户能知道当前选中哪个）');
});

test('交互闸：初赛/决赛同名维度必须联动高亮', () => {
  const code = codeOnly(LANDING_JS);
  assert.ok(/data-dim-key/.test(code), '权重条必须带 data-dim-key');
  assert.ok(/mouseenter/.test(code) && /mouseleave/.test(code), '必须绑定悬停联动');
  // ⚠️ 判据要钉在**比较条件**上：只断言「文件里有 is-active」会被别处顶替
  //    （把条件改成恒 false 时依然有 is-active 字样 ⇒ 变异存活）。
  assert.ok(
    /classList\.toggle\('is-active',\s*other\.getAttribute\('data-dim-key'\) === key\)/.test(code),
    '联动高亮必须按 data-dim-key 相等来判定',
  );
});

test('交互闸：数字 count-up 必须在没有 IntersectionObserver 时降级', () => {
  const code = codeOnly(LANDING_JS);
  assert.ok(/IntersectionObserver/.test(code), '必须用 IntersectionObserver 触发');
  assert.ok(/typeof IntersectionObserver === 'undefined'/.test(code), '没有 IntersectionObserver 时必须降级（测试环境就是没有）');
  assert.ok(/prefers-reduced-motion/.test(code), '必须尊重「减少动态效果」');
});

// ══════════════════════════════════════════════════════════════════
// 八、class 差集闸：视图写出的 class 必须都有样式规则
// ══════════════════════════════════════════════════════════════════

test('class 差集闸：落地页用到的 class 都在 styles.css 里有规则', () => {
  const used = new Set();
  for (const m of LANDING_JS.matchAll(/class="([^"$]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  for (const m of LANDING_JS.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) used.add(m[1]);
  for (const m of LANDING_JS.matchAll(/class="([^"]*)\$\{[^}]+\}[^"]*"/g)) {
    // 动态拼接的 class 由各处显式写出，这里只取字面量部分
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  assert.ok(used.size >= 20, `扫到的 class 太少（${used.size}），说明扫描正则失效`);
  const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}\\b`).test(STYLES_CSS));
  assert.equal(missing.length, 0, `这些 class 在 styles.css 里没有规则（样式不会生效）：${missing.join(', ')}`);
});

// ══════════════════════════════════════════════════════════════════
// 九、设计契约闸
// ══════════════════════════════════════════════════════════════════

test('契约闸：hero 标题是全页唯一的 oversized moment（其余标题 ≤ 24px）', () => {
  const titleRule = STYLES_CSS.match(/\.landing__title\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(/clamp\(30px,\s*4\.2vw,\s*40px\)/.test(titleRule), `hero 标题必须用 clamp(30px, …, 40px)，实际：${titleRule}`);
  // ⚠️ 判据要落到「**标题类**规则」上，不能只查字号变量 ——
  //    变量表里有 26px（--fs-2xl），但它是给**数字**用的（.stat__value），不是标题。
  //    ⇒ 扫描所有 .landing* 规则里出现 font-size 的地方，**除 hero 自己**（含它的
  //      窄屏降档写法）以外，都不许超过 24px。
  const landingRules = [...STYLES_CSS.matchAll(/\.([\w-]*landing[\w-]*)[^{]*\{([^}]*)\}/g)];
  const oversized = [];
  for (const [, selector, body] of landingRules) {
    if (selector.includes('landing__title')) continue;   // hero = 唯一的 oversized moment
    const m = body.match(/font-size:\s*(\d+)px/);
    if (!m) continue;
    const size = Number(m[1]);
    if (size <= 24) continue;
    oversized.push(`${selector}=${size}px`);
  }
  assert.deepEqual(oversized, [], `落地页里除 hero 外不得有超过 24px 的字号，实际：${oversized.join(', ')}`);
  assert.ok(/--fs-xl:\s*20px/.test(STYLES_CSS), '分节标题用 --fs-xl(20px)');
  // 窄屏降档：≤700px 用 26px（仍是全页最大）
  assert.ok(/\.landing__title\s*\{\s*font-size:\s*26px/.test(STYLES_CSS), '窄屏 hero 标题必须降一档到 26px');
});

test('契约闸：圆角已收紧到 midnight 的量级（sm 4 / md 6 / lg 10 / xl 14）', () => {
  assert.ok(/--r-sm:\s*4px/.test(STYLES_CSS));
  assert.ok(/--r-md:\s*6px/.test(STYLES_CSS));
  assert.ok(/--r-lg:\s*10px/.test(STYLES_CSS));
  assert.ok(/--r-xl:\s*14px/.test(STYLES_CSS));
});

test('契约闸：暗色是默认主题，且实底按钮用深色字（白字压强调色不合格）', () => {
  const root = STYLES_CSS.slice(0, STYLES_CSS.indexOf(':root[data-theme="light"]'));
  assert.ok(/--bg:\s*#0b0d12/.test(root), '暗色底必须是默认');
  assert.ok(/--brand:\s*#7c9cff/.test(root));
  assert.ok(/--on-brand:\s*#0b0d12/.test(root), '压 accent 实底的文字必须是深色（白字只有 2.6:1）');
});

test('契约闸：所有动效都尊重 prefers-reduced-motion', () => {
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(STYLES_CSS), '必须有 reduced-motion 分支');
  const reduceIdx = STYLES_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduceIdx > 0, 'reduced-motion 分支必须存在');
});

// ── 辅助：渲染一次落地页拿到完整 HTML（供死链闸用）──────────────────
async function renderLandingHtml() {
  stubDom();
  const captured = [];
  const mk = (tag = 'div') => ({
    tagName: tag, className: '', innerHTML: '', textContent: '', value: '', id: '',
    style: { setProperty() {} },
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return mk(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  });
  // 让 wrap.innerHTML 的内容能被读到：stub 里记录每次 innerHTML 赋值
  globalThis.document = {
    createElement: (t) => {
      const el = mk(t);
      let _html = '';
      Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) { _html = v; captured.push(v); },
      });
      return el;
    },
    getElementById: () => mk('div'),
  };
  const ctx = {
    api: { get: async () => INFO },
    getState: () => ({ user: null }),
  };
  renderLanding(ctx);
  await new Promise((r) => setTimeout(r, 10));
  return captured.join('\n');
}
```

### T7 规则公开接口闸

**Step: 创建 `platform/test/event-info-api.test.js`**

```js
// platform/test/event-info-api.test.js —— 赛事规则公开接口（落地页的数据源）
//
// 规则溯源：
//   - 「规则全部配置化 + 计算留 trace」→ 全局约束
//   - 「可见性在 API 层过滤」→ 全局约束（这里过滤的是**规则**，不是数据）
//   - P9「UI 重构：落地页」→ docs/superpowers/plans/2026-10-22-platform-P9-ui-redesign.md
//
// ⚠️ 本文件为什么存在：
//   落地页要「介绍赛事与赛制」⇒ 赛制数字必须从 rules/*.json 来，不能在前端硬编码。
//   本文件守住三件事：
//     ① 投影是**白名单**：内部备注（"待组委会确认""首届后回测"…）不许进公开响应；
//     ② 投影的**形状固定**：缺配置也给空数组，不给 undefined（前端不必到处判空）；
//     ③ 投影与 rules **同源**：改 rules/*.json，落地页自动跟着变（不用改前端）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/config.js';
import { buildEventInfo } from '../src/domain/event-info.js';
import { getEventInfo } from '../src/services/public-api.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⛔ 临时目录隔离：本用例要建一个临时 SQLite 库 ⇒ 必须 import 隔离器
//    （scripts/temp-leak-scan.js 的 R1 闸会拦「建了临时目录却没有回收机制」）。
//    ⚠️ R2 闸还要求隔离器**先于**第一处临时目录调用执行 ⇒ 这行必须排在用例之前。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'rules');
const { rules } = loadRules(rulesDir);

// ══════════════════════════════════════════════════════════════════
// 一、投影的基本形状
// ══════════════════════════════════════════════════════════════════

test('投影：顶层字段固定（缺配置也给空数组，不给 undefined）', () => {
  const info = buildEventInfo({});
  const keys = Object.keys(info).sort();
  assert.deepEqual(keys, [
    'advancement', 'behaviorEvents', 'behaviorMaxWeightShare', 'formation', 'funnel',
    'redLines', 'registration', 'scoring', 'scoringPoints', 'stages', 'tiebreak',
    'tierNeverUnlocks', 'tiers', 'visibility',
  ].sort());
  assert.deepEqual(info.stages, []);
  assert.deepEqual(info.tiers, []);
  assert.deepEqual(info.funnel, []);
  assert.deepEqual(info.redLines, []);
  assert.equal(info.behaviorMaxWeightShare, 0);
});

test('投影：rules 为 null / undefined 时不炸（返回空骨架）', () => {
  assert.deepEqual(buildEventInfo(null).stages, []);
  assert.deepEqual(buildEventInfo(undefined).funnel, []);
});

test('投影：数值字段拒绝 NaN / Infinity（前端会渲染成 "NaN"）', () => {
  const info = buildEventInfo({
    schedule: { stages: [], advancement: { rate: Infinity, finalTopN: NaN } },
    points: { stagePoints: [10, 'x', Infinity] },
  });
  assert.equal(info.advancement.rate, 0, 'Infinity 必须被兜底成 0');
  assert.equal(info.advancement.finalTopN, 0, 'NaN 必须被兜底成 0');
  assert.deepEqual(info.scoringPoints.stagePoints, [10, 0, 0]);
});

test('投影：配置写错形状时不炸（维度不是数组 → 空数组）', () => {
  const info = buildEventInfo({ scoring: { initial: { dimensions: 'oops' } } });
  assert.deepEqual(info.scoring.initial.dimensions, []);
});

// ══════════════════════════════════════════════════════════════════
// 二、与真实 rules 的对应（投影**不许漏项、不许编项**）
// ══════════════════════════════════════════════════════════════════

test('投影：赛段表与 rules/schedule.json 一致（五段赛程与交付物）', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.stages.length, 5, '本赛事是五段赛程');
  assert.deepEqual(info.stages.map((s) => s.key), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.equal(info.stages[0].name, '调研');
  assert.ok(info.stages[0].deliverables.length > 0, '赛段要有交付物');
  assert.equal(info.stages[0].start, '10-01');
  assert.equal(info.stages[0].hardRequirement, true);
  assert.equal(info.stages.at(-1).hardRequirement, false, 'S5 落地赛段不做硬性要求');
  assert.equal(info.advancement.rate, 0.25, '入围率 25%');
  assert.equal(info.advancement.finalTopN, 32, '决赛 TOP32');
});

test('投影：初赛/决赛权重表与 rules/scoring-*.json 一致', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.scoring.initial.dimensions.length, 6);
  assert.equal(info.scoring.final.dimensions.length, 6);
  const sum = (list) => list.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(sum(info.scoring.initial.dimensions) - 1) < 1e-9, '初赛权重合计必须是 1');
  assert.ok(Math.abs(sum(info.scoring.final.dimensions) - 1) < 1e-9, '决赛权重合计必须是 1');
  const ent = info.scoring.final.dimensions.find((d) => d.key === 'enterprise');
  assert.equal(ent.weight, 0.25, '决赛「企业确认」权重 25%');
});

test('投影：段位表与权益与 rules/ranks.json 一致', () => {
  const info = buildEventInfo(rules);
  assert.deepEqual(info.tiers.map((t) => t.key), ['D', 'C', 'B', 'A', 'S']);
  const s = info.tiers.find((t) => t.key === 'S');
  assert.equal(s.requiresBusinessSignoff, true);
  assert.ok(s.benefits.includes('完赛证明'));
  assert.ok(info.tierNeverUnlocks.includes('奖金'), '段位永不解锁奖金（落地页要说明）');
});

test('投影：漏斗与 rules/registration.json 一致（末段 rate 为 null）', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.funnel.length, 5);
  assert.equal(info.funnel[0].rate, 0.3);
  assert.equal(info.funnel.at(-1).rate, null, '辅导期比例待定 ⇒ null（不是 0）');
});

test('投影：破同分链保留顺序与作用域', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.tiebreak[0].label, '总分');
  assert.equal(info.tiebreak.at(-1).key, 'team_id', '最后必须是确定性兜底（队伍编号）');
  assert.equal(info.tiebreak.at(-1).deterministic, true);
  assert.deepEqual(info.tiebreak.map((c) => c.order), info.tiebreak.map((_, i) => i + 1));
});

test('投影：合规红线与 rules/compliance.json 一致', () => {
  const info = buildEventInfo(rules);
  assert.ok(info.redLines.length >= 5, '合规红线至少 5 条');
  assert.ok(info.redLines.some((r) => r.key === 'ip_no_infringement'));
});

// ══════════════════════════════════════════════════════════════════
// 三、白名单：内部备注一律不许进公开响应
// ══════════════════════════════════════════════════════════════════

test('⛔ 白名单闸：内部备注不许进公开响应', () => {
  const dumped = JSON.stringify(buildEventInfo(rules));
  for (const secret of ['待组委会确认', 'awardPointsNote', 'note', 'source', 'conflictRef']) {
    assert.ok(!dumped.includes(`"${secret}"`), `公开响应里不得出现内部字段/备注：${secret}`);
  }
  assert.ok(!dumped.includes('首届后回测'), '内部口径说明不得出现');
  assert.ok(!dumped.includes('占位题面'), '内部占位说明不得出现');
});

test('⛔ 白名单闸：赛段 note 一律不带（内部溯源说明不进公开响应）', () => {
  const info = buildEventInfo(rules);
  for (const s of info.stages) {
    assert.equal(s.note, undefined, `赛段 ${s.key} 不得带 rules 的原始 note`);
  }
  // 「这个赛段不做硬性要求」由布尔位表达，落地页据此自己写一句话。
  assert.equal(info.stages.at(-1).hardRequirement, false);
});

// ══════════════════════════════════════════════════════════════════
// 四、服务层
// ══════════════════════════════════════════════════════════════════

test('服务层：getEventInfo 与领域层投影**逐字段一致**', () => {
  assert.deepEqual(getEventInfo(rules), buildEventInfo(rules));
});

test('服务层：规则没加载时报业务错误（不是崩栈）', () => {
  assert.throws(() => getEventInfo(null), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.code, 'RULES_MISSING');
    return true;
  });
});

// ══════════════════════════════════════════════════════════════════
// 五、端点（真服务器 + 真 HTTP）
// ══════════════════════════════════════════════════════════════════

test('端点：GET /api/event-info 匿名可读，返回 200 与正确形状', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { openDatabase } = await import('../src/db/sqlite.js');
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { createApp } = await import('../src/server.js');
  const { callJson } = await import('../test-helpers/http-call.js');

  const dataDir = mkdtempSync(join(tmpdir(), 'hks-eventinfo-'));
  const { db } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
  try {
    const res = await callJson(app, 'GET', '/api/event-info');
    assert.equal(res.status, 200, '规则本来就该公开 ⇒ 匿名可读');
    const body = res.json;
    assert.equal(body.stages.length, 5);
    assert.ok(body.scoring.initial.dimensions.length > 0);
    assert.ok(body.tiers.length > 0);
    assert.ok(!JSON.stringify(body).includes('待组委会确认'), '内部备注不得进公开响应');
  } finally {
    db.close?.();
  }
});
```

## 8. P9.1 修复轮（真机复验抓出的 4 个真 bug）

### 8.0 背景

P9 上线后做**真机复验**（真浏览器 + 真机代码 + 真机 Node + **独立数据目录**，全程不碰生产库），
在 P8 的两个详情页上抓到 4 个**机器闸全绿也抓不到**的 bug：

| # | 现象 | 根因 | 修在哪 |
|---|---|---|---|
| B1 | 评委视角同一屏出现「0 我的已交 / 应交 20 格 / 完成度 0%」**和**「本赛段的评分都交了」 | 后端 `getReviewState` 给**没有本赛段席位**的账号算出 total，却把 missing 留空；前端又拿「missing 为空」当「都交了」 | `src/services/review.js`（P2 owns）+ `web/views/review.js`（P8 owns） |
| B2 | 发榜页在「一格都没打」时显示「名册里的队伍都有打分 / 可以执行计算发榜」 | 同一个判据误用：`missingTeams` 为空被当成「都打了分」（真发榜后引擎产出 30 条 `dimension_no_scores`） | `web/views/publish.js`（P8 owns） |
| B3 | 所有提示条的**说明文字从来没渲染出来** | `noticeState` 只认 `items` / `list`，P8 两页传的是 `text` ⇒ 被**静默丢弃** | `web/views/review.js` + `web/views/publish.js`（P8 owns） |
| B4 | 演示站「应交 N 格」比正式站**小 6 倍**；演示站每次计算多一条 `judge_pool_invalid` 告警 | 演示适配器的进度**漏乘评委数**；席型词表写的是 `expert`（真实是 `judge` / `enterprise` / `observer`） | `web/api.demo.js` + `web/seed/demo-data.json`（P6 owns） |

⛔ **B4 是「形状对、数值漂移」**：P8 的 parity 闸只比**形状**，比不到数值 ——
这正是 P8 复盘写下的「演示适配器把错误形状锁进测试」的**数值版**。
⇒ 所以本轮补的闸里有一条是**同数据 ⇒ 演示与真实后端的进度数值逐项相等**。

### 8.1 决策

### DP-102 · 没有席位 ⇒ 应交格数就是 0

`getReviewState` 的 `submitted` / `total` / `missing` 必须**自洽**：
**没有本赛段席位**的账号在这个赛段没有任何属于自己的格子 ⇒ `total = 0`。
（写路径本来就被 `assertVotingJudge` 挡住；这里是让「读到的数」与「写得到的」一致。）

### DP-103 · 「都交了 / 都有打分」只能由**数字**推出

前端的状态行不得由「missing 为空」推断「都交了」——
必须由 `submitted` 与 `total` 推出（`total === 0` ⇒ 「没有格子」；`submitted >= total > 0` ⇒ 「都交了」）。
DP-89（标签跟着值走）的直接应用。

### DP-104 · UI 组件的参数名写错 = 静默丢内容 ⇒ 做成机器闸

`noticeState({ text })` 不报错、不渲染、测试全绿 —— 这类事故只能靠机器闸兜住：
新增「任何视图都不得给 `noticeState` 传 `text`」的扫描闸（**带阳性对照**：注入坏用法必须被抓到）。

### 8.2 归属与计划块同步

| 文件 | 归属 | 动作 |
|---|---|---|
| `src/services/review.js` | P2 owns | Modify ⇒ **同步回 P2 计划块** |
| `web/api.demo.js` | P6 owns | Modify ⇒ **同步回 P6 计划块** |
| `web/seed/demo-data.json` | P6 owns | Modify ⇒ **同步回 P6 计划块** |
| `web/views/review.js` | P8 owns | Modify ⇒ **同步回 P8 计划块** |
| `web/views/publish.js` | P8 owns | Modify ⇒ **同步回 P8 计划块** |
| `platform/test/review-progress-scope.test.js` | **P9 新建** | 新建 ⇒ 规格块放在**本计划** |

### 8.3 规格块（P9.1 新建文件）

**Step: 创建 `platform/test/review-progress-scope.test.js`**

```javascript
// platform/test/review-progress-scope.test.js —— P9.1 修复轮：评审/发榜的「进度口径」自洽闸
//
// ⛔ 起因（真机复验抓出，2026-10-22 —— 真浏览器 + 真机代码 + 真机 Node + 独立数据目录）：
//   ① **评委视角**同一屏出现「0 我的已交 / 应交 20 格 / 完成度 0%」**和**「本赛段的评分都交了」
//      —— 两个说法互相打架（DP-89「标签必须跟着值走」的同款事故）。
//   ② **发榜页**在「一格都没打」时显示「名册里的队伍都有打分 / 可以执行计算发榜」，
//      真发榜后引擎对每队每维度产出 `dimension_no_scores` 告警（实测 30 条）。
//   ③ 演示适配器的「应交 N 格」**漏乘评委数** ⇒ 演示站与正式站**数值**差 6 倍
//      （形状一致，所以 P8 的 parity 闸抓不到 —— 它只比形状）。
//
//   根因（后端）：`getReviewState` 给「**没有本赛段席位**」的账号算出 total = 队伍数 × 维度数，
//   却又把 missing 留空（missing 只在有席位时才算）⇒ {submitted:0, total:20, missing:[]} 自相矛盾；
//   前端再把「missing 为空」当「都交了」⇒ 矛盾被放大成一句**假话**。
//
// ── 三条硬判据 ────────────────────────────────────────────────────────────
//   ① 没有席位 ⇒ total 必须是 0（他在这个赛段没有任何属于自己的格子）；
//   ② 前端状态行必须由**数字**判定，不得由「missing 为空」推断「都交了」；
//   ③ 演示适配器的进度**数值**必须与真实后端同口径（形状对 ≠ 数值对）。
//
// 规则溯源：
//   - 「可见性与授权在 API 层裁决」→ 全局约束
//   - 「写路径由评委席把门」→ src/services/review.js 的 assertVotingJudge
//   - 「DP-89 可选数量的标签必须跟着值一起出现/消失」「DP-87 数字与标签不许错位」
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { getReviewState } from '../src/services/review.js';
import { reviewHtml } from '../web/views/review.js';
import { publishHtml } from '../web/views/publish.js';
import { buildDemoState, demoReviewBoard } from '../web/api.demo.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-22T10:00:00.000Z';
const { rules } = loadRules(rulesDir);

/** final 权重表里的评委席维度（企业席与自评席不算评委的格子）。 */
const FINAL_JUDGE_DIMS = rules.scoring.final.dimensions.filter((d) => d.seat === 'judge').map((d) => d.key);

// ══════════════════════════════════════════════════════════════════
// 一、后端口径：submitted / total / missing 必须自洽
// ══════════════════════════════════════════════════════════════════

/** 造一个「2 队 × 2 评委 + 1 个无席位账号」的赛段。 */
function setupStage() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-scope-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900000061', password: 'pw' });
  const judge1 = createUser(db, { name: '评委甲', phone: '13900000062', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900000063', password: 'pw' });
  const outsider = createUser(db, { name: '无席位账号', phone: '13900000064', password: 'pw' });
  const observer = createUser(db, { name: '观察员', phone: '13900000065', password: 'pw' });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: null, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const team1 = insertTeam(db, { editionId: edition.id, name: '一队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW });
  const team2 = insertTeam(db, { editionId: edition.id, name: '二队', captainId: admin.id, taskPackageId: pkg.id, status: 'active', now: NOW });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's5', name: '落地', kind: 'final',
    startsAt: '2026-10-29', endsAt: '2026-10-31', scoringConfigKey: 'final', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge1.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  // 观察员席**无投票权**（R-JDG-11）⇒ 不得计入应交格数（这一条要有测试盯着，
  // 否则「把观察员也算进去」这种改动会静默改变全赛段的完成度分母）。
  assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });
  return { db, close, dataDir, stage, admin, judge1, judge2, outsider, observer, team1, team2 };
}

test('后端口径：组委会视角 total = 席位数 × 队伍数 × 维度数', () => {
  const s = setupStage();
  try {
    const st = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(st.total, 2 * 2 * FINAL_JUDGE_DIMS.length, `实际 ${st.total}`);
    assert.equal(st.missing.length, st.total, '一格没交 ⇒ missing 数量 = total');
    assert.equal(st.submitted, 0);
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：有席位的评委 total = 队伍数 × 维度数（只看自己那一份）', () => {
  const s = setupStage();
  try {
    const st = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.judge1.id, isAdmin: false },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(st.total, 2 * FINAL_JUDGE_DIMS.length, `实际 ${st.total}`);
    assert.equal(st.missing.length, st.total);
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：**没有席位**的账号 total 必须是 0（不能算出不属于他的格子）', () => {
  const s = setupStage();
  try {
    const st = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.outsider.id, isAdmin: false },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(st.total, 0, `无席位账号的 total 应为 0，实际 ${st.total}`);
    assert.equal(st.missing.length, 0);
    assert.equal(st.submitted, 0);
    // ⛔ 三个数必须自洽：submitted <= total，且 missing 为空时不可能 total > submitted
    assert.ok(st.submitted <= st.total, 'submitted 不能大于 total');
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：dimensionProgress 的 total 与总 total 同源（席位因子一致）', () => {
  const s = setupStage();
  try {
    const admin = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    for (const dim of FINAL_JUDGE_DIMS) {
      assert.equal(admin.dimensionProgress[dim].total, 2 * 2, `维度 ${dim} 的 total 不对`);
    }
    const outsider = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.outsider.id, isAdmin: false },
      dimensions: FINAL_JUDGE_DIMS,
    });
    for (const dim of FINAL_JUDGE_DIMS) {
      assert.equal(outsider.dimensionProgress[dim].total, 0, `维度 ${dim} 对无席位账号必须是 0`);
    }
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('后端口径：观察员席无投票权 ⇒ 不得计入应交格数（R-JDG-11）', () => {
  const s = setupStage();
  try {
    const admin = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    // 名册上坐着 3 个人（2 评委 + 1 观察员），但只有 2 个人有投票权
    assert.equal(admin.total, 2 * 2 * FINAL_JUDGE_DIMS.length,
      `观察员被算进应交格数了（实际 ${admin.total}）`);
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

// ══════════════════════════════════════════════════════════════════
// 二、前端文案：状态行必须由数字判定
// ══════════════════════════════════════════════════════════════════

function board(over = {}) {
  return {
    stage: { id: 'stage_final', key: 'S5', name: '落地', kind: 'final', status: 'open', scoringConfigKey: 'final' },
    dimensions: FINAL_JUDGE_DIMS.map((k) => ({ key: k, name: k, weight: 0.25, seat: 'judge' })),
    judgeDimensions: FINAL_JUDGE_DIMS.map((k) => ({ key: k, name: k, weight: 0.25, seat: 'judge' })),
    teams: [{ id: 't_alpha', name: '拾光队', taskPackageTitle: '库存周转' }],
    myScores: [],
    progress: { scope: 'stage', submitted: 0, total: 4, missing: [], dimensionProgress: {} },
    ...over,
  };
}

test('前端：total=0 且缺格为空 ⇒ 不许说「都交了」（那是把「没有格子」当成「交齐了」）', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'stage', submitted: 0, total: 0, missing: [], dimensionProgress: {} } }) });
  assert.ok(!html.includes('都交了'), 'total=0 时绝不能出现「都交了」');
  assert.ok(html.includes('还没有需要打分的格子'), '应当说明「这个赛段没有需要打分的格子」');
});

test('前端：无席位的评委（submitted=0 / total>0 / missing 空）⇒ 仍不许说「都交了」', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'mine', submitted: 0, total: 20, missing: [], dimensionProgress: {} } }) });
  assert.ok(!html.includes('都交了'), 'submitted < total 时绝不能出现「都交了」');
  assert.ok(html.includes('还差 20 格'), '应当说清还差几格');
});

test('前端：真的交齐了（submitted >= total > 0）才可以说「都交了」', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'stage', submitted: 4, total: 4, missing: [], dimensionProgress: {} } }) });
  assert.ok(html.includes('都交了'), '交齐了就该说都交了');
});

test('前端：还有缺格 ⇒ 显示缺格数（不许出现「都交了」）', () => {
  const html = reviewHtml({ board: board({ progress: { scope: 'stage', submitted: 2, total: 4, missing: [{ teamId: 't_alpha', dimension: 'innovation' }, { teamId: 't_alpha', dimension: 'feasibility' }], dimensionProgress: {} } }) });
  assert.ok(!html.includes('都交了'));
  assert.ok(html.includes('还差 2 格'), '应当给出缺格数');
});

test('前端·发榜页：一格都没打（total=0）⇒ 不许说「名册里的队伍都有打分」', () => {
  const html = publishHtml({ board: board({ progress: { scope: 'stage', submitted: 0, total: 0, missing: [], dimensionProgress: {} } }), result: null });
  assert.ok(!html.includes('都有打分'), 'total=0 时绝不能出现「都有打分」');
  assert.ok(html.includes('一格都还没打'), '应当直说一格都没打');
});

test('前端·发榜页：有缺格 ⇒ 不许说「都有打分」', () => {
  const html = publishHtml({ board: board({ progress: { scope: 'stage', submitted: 1, total: 4, missing: [{ teamId: 't_alpha' }], dimensionProgress: {} } }), result: null });
  assert.ok(!html.includes('都有打分'));
  assert.ok(html.includes('还缺打分'), '应当提示还有队伍缺打分');
});

test('前端·发榜页：交齐了才可以说「都有打分」', () => {
  const html = publishHtml({ board: board({ progress: { scope: 'stage', submitted: 4, total: 4, missing: [], dimensionProgress: {} } }), result: null });
  assert.ok(html.includes('都有打分'));
});

// ══════════════════════════════════════════════════════════════════
// 三、演示适配器：**数值**必须与真实后端同口径
// ══════════════════════════════════════════════════════════════════

test('演示适配器：应交格数 = 席位数 × 队伍数 × 维度数（与真实后端同口径）', () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const state = buildDemoState({
    ...seed,
    judges: [
      { id: 'j1', name: '评委一', seat: 'judge' },
      { id: 'j2', name: '评委二', seat: 'judge' },
      // 观察员**无投票权**（R-JDG-11）：演示侧也必须不把它算进应交格数
      { id: 'j_obs', name: '观察员', seat: 'observer' },
    ],
    teams: [
      { id: 't1', name: '一队', packageId: 'tp_retail', captainId: 'mba_captain', memberIds: [] },
      { id: 't2', name: '二队', packageId: 'tp_retail', captainId: 'mba_captain2', memberIds: [] },
    ],
    reviews: {},
  });
  const b = demoReviewBoard({ state, rules, stageId: 'stage_final' });
  assert.equal(b.teams.length, 2);
  assert.equal(b.progress.total, 2 * 2 * b.judgeDimensions.length, `演示的应交格数不对：${b.progress.total}`);
  assert.equal(b.progress.missing.length, b.progress.total, '演示的缺格数必须 = 应交格数');
  for (const d of b.judgeDimensions) {
    assert.equal(b.progress.dimensionProgress[d.key].total, 2 * 2, `维度 ${d.key} 的 total 不对`);
  }
});

test('演示适配器：与真实后端同数据 ⇒ 进度数值逐项相等（形状对不等于数值对）', () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const state = buildDemoState({
    ...seed,
    judges: [
      { id: 'j1', name: '评委一', seat: 'judge' },
      { id: 'j2', name: '评委二', seat: 'judge' },
      // 观察员**无投票权**（R-JDG-11）：演示侧也必须不把它算进应交格数
      { id: 'j_obs', name: '观察员', seat: 'observer' },
    ],
    teams: [
      { id: 't1', name: '一队', packageId: 'tp_retail', captainId: 'mba_captain', memberIds: [] },
      { id: 't2', name: '二队', packageId: 'tp_retail', captainId: 'mba_captain2', memberIds: [] },
    ],
    reviews: {},
  });
  const demo = demoReviewBoard({ state, rules, stageId: 'stage_final' });

  const s = setupStage();
  try {
    const real = getReviewState({
      db: s.db, stageId: s.stage.id,
      viewer: { userId: s.admin.id, isAdmin: true },
      dimensions: FINAL_JUDGE_DIMS,
    });
    assert.equal(demo.progress.total, real.total, '演示与真实后端的应交格数必须一致');
    assert.equal(demo.progress.submitted, real.submitted, '演示与真实后端的已交格数必须一致');
    assert.equal(demo.progress.missing.length, real.missing.length, '演示与真实后端的缺格数必须一致');
  } finally { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); }
});

test('演示种子：席型词表必须与真实后端一致（judge | enterprise | observer）', () => {
  const seed = JSON.parse(readFileSync(join(here, '..', 'web', 'seed', 'demo-data.json'), 'utf8'));
  const KNOWN = new Set(['judge', 'enterprise', 'observer']);
  for (const j of seed.judges ?? []) {
    assert.ok(KNOWN.has(j.seat), `评委 ${j.id} 的席型「${j.seat}」不在真实后端词表内`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 四、机器闸：noticeState 的参数名写错 ⇒ 说明文字被**静默丢弃**
// ══════════════════════════════════════════════════════════════════

/**
 * 扫一个源码里的 `noticeState(...)` 调用，返回「传了 text」的调用所在行号。
 * ⛔ 这个函数自身必须有判别力 —— 所以下面有**阳性对照**：
 *    把判据改坏（例如让它永远返回空），阳性对照会立刻失败。
 */
function scanNoticeTextArgs(src) {
  const hits = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('noticeState(', from);
    if (at === -1) break;
    let depth = 0;
    let end = at;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    const call = src.slice(at, end + 1);
    if (/(^|[^.\w])text\s*:/.test(call)) {
      hits.push(src.slice(0, at).split('\n').length);
    }
    from = end + 1;
  }
  return hits;
}

test('机器闸：任何视图都不得给 noticeState 传 text（它只认 items / list）', () => {
  // 阳性对照：扫描器必须真的抓得到（否则这条闸是「一条都不判违规」的假绿）
  assert.equal(scanNoticeTextArgs('noticeState({ tone: "info", title: "x", text: "y" });').length, 1,
    '阳性对照失败：扫描器抓不到传了 text 的调用');
  assert.equal(scanNoticeTextArgs('noticeState({ tone: "info", title: "x", items: ["y"] });').length, 0,
    '阳性对照失败：扫描器把正常的 items 误判成 text');

  const viewsDir = join(here, '..', 'web', 'views');
  const offenders = [];
  for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(viewsDir, file), 'utf8');
    for (const line of scanNoticeTextArgs(src)) offenders.push(`${file}:${line}`);
  }
  assert.equal(offenders.length, 0,
    `下列位置给 noticeState 传了 text ⇒ 说明文字**不会渲染**（它只认 items）：\n  ${offenders.join('\n  ')}`);
});
```


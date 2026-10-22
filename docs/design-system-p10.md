# P10 设计系统用法（开发者唯一事实源）

> 配套：`2026-10-22-platform-P10-design-system.md`（设计契约）。
> **所有新页面 / 改版页面都必须照这份写** —— 这是「全站统一」的唯一保障。

---

## 1. 主题：暗色是默认

- `:root` 里就是暗色。**不要**写 `@media (prefers-color-scheme: light)`（P10 删掉了它）。
- 亮色只由用户**显式切换**（顶栏主题按钮写 `localStorage['heikesong:theme']` + `<html data-theme="light">`）。
- 新写颜色**只在 `:root` / `:root[data-theme="light"]` 两个块里**出现；组件规则一律 `var(--xxx)`。

## 2. token 清单（不许写字面色值）

### 2.1 色

| token | 用途 |
|---|---|
| `--bg` / `--bg-subtle` | 页面底 / 分区底（章节交替时用 `--bg-subtle`） |
| `--surface` | 卡片面 |
| `--surface-raised` | hover / 浮起面 |
| `--surface-sunken` | 卡头、下沉内容 |
| `--fg` / `--fg-strong` / `--fg-muted` / `--fg-subtle` | 正文 / 标题 / 次要说明 / 最弱说明（**都是真文本**，对比度 ≥ 4.5:1） |
| `--border` / `--border-strong` | 分隔线 / 可交互边界（后者 ≥ 3:1） |
| `--brand` / `--brand-strong` / `--brand-soft` / `--brand-line` | 强调色四档 |
| `--on-brand` | 压在 `--brand` 实底上的文字色 |
| `--success` / `--warn` / `--danger` / `--info`（各带 `-soft`） | 语义色 |
| `--hairline` | 卡片顶边 1px 高光（材质） |
| `--sheen` | 卡片顶面渐变（材质） |
| `--grain` | 极淡噪点（背景层用） |
| `--grid-line` | 弱化工程网格线 |

### 2.2 尺寸

`--sp-1..--sp-20`（4px 基数）｜`--r-sm/md/lg/xl/full`（4/6/10/14/9999）｜
`--fs-xs/sm/base/md/lg/xl/2xl/3xl`（12/13/14/15/17/20/26/32）｜
`--dur-1`(120ms) `--dur-2`(260ms) `--ease`｜`--maxw`(1240px) `--topbar-h`(60px)｜
`--font` `--mono`（**不要引网络字体**）

## 3. 材质三件套（深度怎么来）

> 卡片**零外阴影**。深度 = ① 底色差 ② 顶边 1px 高光 ③ 顶面极轻渐变。

```css
.my-surface {
  background-color: var(--surface);
  background-image: var(--sheen);
  border: 1px solid var(--border);
  box-shadow: inset 0 1px 0 var(--hairline);
  border-radius: var(--r-lg);
}
```

复用 `.card` / `.panel` 就自带材质，**新容器优先用它们**。

## 4. 现有组件（先查再写）

`web/ui.js` 已导出（**只用这些，别自己造**）：
`pageHead` `panel` `statRow` `badge` `tableWrap` `emptyState` `errorState` `noticeState` `loadingState`
`sectionTitle` `bar` `kv` `field` `labelRow` …

用法约定（与现有视图一致）：
- `noticeState({ tone, title, items, list })` —— ⚠️ **参数叫 `items`（数组），不叫 `text`**（传 `text` 会被静默丢弃，且有机器闸盯着）。
- `emptyState({ title, hint, action })` —— 空态必须给**可点的下一步**。
- `errorState({ message, retry, hint })` —— 错误态必须给**真能点的重试**。

## 5. 页面骨架（P10 标准形）

```html
<section class="landing__section">
  <div class="landing__section-head">
    <p class="landing__eyebrow">分区标签（等宽 · 字距）</p>
    <h2 class="landing__section-title">≤ 26px 的标题</h2>
    <p class="landing__section-desc">导语：一句话说清这一屏在讲什么</p>
  </div>
  …内容…
</section>
```

- **每个页面只有一处 oversized moment**（`--fs-2xl` 以上）；标题层级：eyebrow → H2 → 导语。
- **每屏强调色元素 ≤ 3**（主 CTA + 焦点环 + 活动节点）。其余一律 `--fg-muted` / `--fg-subtle`。
- 数字一律 `class="num"`（等宽数字）；**不要**用 `localeCompare` 做需要复算的排序。

## 6. 交互纪律

| 规则 | 出处 |
|---|---|
| 前端**不按角色拦路**，授权归 API；但**分区级页面可以按「能力点」给明确的无权限说明** | DP-77 / DP-105 |
| 每个可点元素必须有 `:focus-visible` 焦点环 | 契约 M11 |
| 动效一律走 `--dur-1/2` + `--ease`，并尊重 `prefers-reduced-motion` | 契约 |
| **不要**给每张卡片都加滚动淡入（只有章节进入才做） | skill「tell」目录 |
| 降级路径必须可点且**不许抛**（最小 DOM 桩上也要安全） | DP-101 |

## 7. 数据纪律

- 赛制 / 赛事事实**只从 API 来**（`/api/event-info` 的白名单投影），前端**一个字都不许硬编码**
  （机器闸扫源码里的规则字面量，命中即红）。
- 可见性在 API 层过滤；前端只负责**呈现**与**说明**。
- 三态状态码：列表 200+空集｜单条 404｜禁用 403。前端按这个渲染。

## 8. 新页面交付清单

1. 视图文件 `web/views/<name>.js`：**纯函数渲染**（导出可测的纯函数）+ 事件绑定分离。
2. 自带测试 `platform/test/<name>.test.js`（`node:test`、零依赖、行为断言而非文本匹配）。
3. 需要注册路由 / 导航时：把**精确的注册片段**写进交付说明（`app.js` 的 `route(...)` 行、`nav.js` 的导航项），
   由集成人统一改（**避免多人同时改共享文件**）。
4. 视觉自检：Playwright 六视口截图 + 读图（暗色 + 亮色各一轮）。
5. 计划块同步：新建文件 ⇒ 规格块写进 P10 计划；改动既有文件 ⇒ 同步回**最早建立者**的计划。

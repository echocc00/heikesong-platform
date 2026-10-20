# AI 商业黑客松赛事平台 · 设计文档

| 项 | 值 |
|---|---|
| **日期** | 2026-10-20 |
| **状态** | 待评审 |
| **作者** | 零号备战组（T1 第 2 组）· MCode 协作产出 |
| **仓库** | `/Users/mac/soft/AI/orca/heikesong` |
| **代码目录** | `platform/` |
| **配套文档** | [`docs/requirements-traceability.md`](../../requirements-traceability.md)（需求溯源表，99 条）<br>[`docs/rule-decisions.md`](../../rule-decisions.md)（规则冲突登记表，6 条） |

---

## 0. 这份文档怎么读

**它回答四个问题，对应四个章节群：**

| 你想知道 | 看哪节 |
|---|---|
| 这个平台为什么存在、做什么、不做什么 | §1 |
| 每个功能需求**从哪来**、凭什么这么定 | §2 + `requirements-traceability.md` |
| 为什么不自己造轮子、借鉴了谁 | §3 |
| **怎么落地**、为什么用这个实现方式 | §4–§14 |

**阅读约定**：
- **【需求】** 标记 = 来自 `requirements-traceability.md` 的需求编号
- **【冲突】** 标记 = 来自 `rule-decisions.md` 的冲突编号
- **【决策】** 标记 = 本设计做出的关键实现决策，每条都附「为什么」
- **【兜底】** 标记 = 该结论的证据强度分级（沿用项目自己的 evidence-chain 规范）

---

## 1. 背景与目标

### 1.1 这个平台从哪来

平台需求有**三个独立源头**，它们互相独立、不能互相替代：

| # | 源头 | 原话 | 性质 |
|---|---|---|---|
| ① | **任务包 T1（硬要求）** | 「vibe coding 搭建赛事平台原型（**报名/榜单/评审 Demo**）」 | ⛔ 必须做，组委会指定 |
| ② | **任务书 §九（战略定位）** | 「AI 商业化成果实践平台：真实任务、积分榜单、案例资产」+「三池沉淀（项目池/人才池/资源池）」 | 🎯 决定长期形态 |
| ③ | **机制件 S7 / S10 / SABC（规则供给）** | 评分算法、积分段位、报名画像的完整设计 | ⚙️ 决定模块内部逻辑 |

> **关键判断**：① 给了边界，② 给了纵深，③ 给了内容。**没有 ③，① 只能做出一个空壳；没有 ③，② 无法收敛。**
> 这一点决定了本设计的核心结构：**平台不是"做一个赛事网站"，而是"把三份机制件变成可执行、可复算的代码"。**

### 1.2 一期做什么、不做什么

| 一期做 | 一期不做（及原因） |
|---|---|
| 报名与组队长（筛选自动算分分级） | ❌ 邮件/短信通知 —— 依赖外部服务，违反零依赖约束（R-OPS-01） |
| 评审打分（双权重 + z-score + 去极值 + 双签 + 回避） | ❌ 在线代码判题 —— 赛制无此环节 |
| 榜单与积分（A 榜 / B 榜 / 个人榜 / 段位） | ❌ 第三方 OAuth 登录 —— 一期用账号密码 + scrypt，够用且零依赖 |
| 企业侧（出题、里程碑签字、战绩卡） | ❌ 支付与结算 —— H1 预判结论是**首届不该以保本为目标**，先验机制 |
| 三池**底座**（数据模型 + 读写接口） | ❌ 三池**前台页面** —— 一期做出来会是"空池无内容"的死界面 |
| 审计与可复算（计算快照 + 审计日志） | ❌ 移动端 App —— 评审场景以桌面为主 |
| 部署资产（systemd / nginx / compose / 备份） | ❌ 实时协同编辑 —— 无此需求 |

**为什么"三池只做底座"**：三池是报名、评审、里程碑这三块数据的**自然沉淀物**。先让源头跑通并可复算，三池的数据才有质量。倒过来先做三池前台，会得到一个漂亮的空池——这正是本项目在黑客松调研中反复遇到的失败模式（**材料看起来完整，实则撑不住结论**）。

### 1.3 成功标准

| # | 标准 | 怎么判定 |
|---|---|---|
| S-1 | **榜单可复算** | 任取一次发榜，能从快照重放出完全相同的名次（`computation_snapshot` 存了 input + output + trace） |
| S-2 | **规则可换** | 改一份 JSON（权重表 / 段位表 / 阈值 / 可见性策略），重启即生效，**不改一行业务代码** |
| S-3 | **分轨在算法层强制** | 总分函数**在签名层面**不接受行为分参数；类型/断言双重保证 |
| S-4 | **零依赖可移植** | 全新机器上 `git clone && node src/server.js` 即跑起来，不需要联网装任何东西 |
| S-5 | **降级状态可见** | 评委样本不足、配置缺项、双签缺失等情况，在榜单页显式提示，不静默 |
| S-6 | **合规可留档** | 评分明细、企业签字、回避记录、同意记录，赛后 6 个月可查（S7 §4.2） |

---

## 2. 需求溯源（索引）

完整溯源表见 [`docs/requirements-traceability.md`](../../requirements-traceability.md)。此处只给结论：

**分母声明**：需求全集 = **99 条**｜来源 = 任务书 2.0 + S7 + S10 + SABC + 顶层文档 + 项目自身复盘（6 类一手文档）｜独立源数 = 6（**同一作者体系，非独立互证**）

| 状态 | 条数 | 对实现的含义 |
|---|---|---|
| 已定 | 24 | 硬编码行为不可改 |
| **机制件（待组委会确认）** | **56** | **必须配置化** |
| 我方假设 / 待验证 | 19 | 必须留可调参数与回测接口 |
| 规则空白 | 2 | 需组委会拍板 |
| 非功能（推导） | 8 | 由用户决策直接推导 |

> **⭐ 贯穿全表的第一条设计结论**
> **56 条机制件级需求全部来自我们自己尚未被组委会确认的设计。硬编码 = 委员会改一次数值就要改代码、重新部署、重新验证。**
> → 核心规则全部走**声明式配置 + 纯函数引擎 + 计算留痕**。**换一次规则 = 改一份 JSON。**

> **⭐ 第二条设计结论**
> 对 S7/S10 做一致性审计，查出 **6 条自相矛盾或跨文件冲突**（`rule-decisions.md`）。其中 **C-01（初赛 `w_E` 10% vs 20%）若硬编码，初赛榜单会整体错位且不报错**——名次看起来仍然合理，不会有人发现。
> → 规则引擎必须额外做到 **每次计算留 trace + 降级状态显式暴露**。

---

## 3. 开源调研与借鉴结论

> ⏳ *本节待调研子任务回填（4 条轴并行调研中）。*

---

## 4. 技术架构

### 4.1 总体结构

```
┌───────────────────────────────────────────────────────────────┐
│  web/  静态前端 · 原生 ES Module · 零构建                       │
│  ├── router.js      哈希路由（#/login, #/apply …）              │
│  ├── store.js       极简响应式 store（约 60 行）                │
│  ├── api.js         真实 API 客户端                            │
│  ├── api.demo.js    ★ 演示版适配器（localStorage）              │
│  └── views/         报名/组队/评审/榜单/段位/战绩卡/三池       │
└───────────────────────────┬───────────────────────────────────┘
                            │ fetch + SSE（EventSource）
┌───────────────────────────▼───────────────────────────────────┐
│  src/server.js  单进程 Node（仅标准库）                         │
│  ├── http/     router · body · static · sse                    │
│  ├── auth/     scrypt 密码 · session · 角色与行级权限           │
│  ├── domain/   ★ 纯函数规则引擎（无 IO，可单测）                │
│  │   scoring · ranking · points · visibility                   │
│  │   registration · solvability                               │
│  ├── services/ 用例编排（报名/组队/评审/发榜/签字）              │
│  ├── db/       node:sqlite + 迁移 + 各实体仓储                 │
│  └── audit/    审计日志 + 计算快照                              │
└───────────────────────────┬───────────────────────────────────┘
                            │ node:sqlite（单文件，WAL）
┌───────────────────────────▼───────────────────────────────────┐
│  data/app.db                                                    │
└───────────────────────────────────────────────────────────────┘
```

**关键分界线**：`domain/` 是纯函数，**不碰数据库、不碰 HTTP、不读时钟**。它吃「配置 + 数据」，吐「结果 + trace」。这样规则引擎可以脱离整个系统单独测试，且规则逻辑在代码评审时可完整阅读。

### 4.2 运行时与依赖

| 决策 | 取值 | 依据 |
|---|---|---|
| 运行时 | Node ≥ 22.5 | `node:sqlite` 最低版本要求 |
| **npm 依赖** | **0 个** | R-OPS-01/02：不能依赖联网 `npm install` |
| 数据库 | `node:sqlite`（内置） | 无原生编译、跨平台、单文件 |
| 前端框架 | 无。原生 ESM + 哈希路由 | 同上 |
| 测试 | `node:test`（内置） | 同上 |
| 密码哈希 | `node:crypto` `scrypt` | 已实测可用 |
| 实时推送 | SSE（`text/event-stream`） | 单向推送够用；已实测零依赖可用 |
| 会话 | HttpOnly Cookie + 服务端 session 表 | 同上 |

**已实测验证**（非推断）：

| 能力 | 结果 |
|---|---|
| `node:sqlite` 事务 / `user_version` 迁移 / JSON 函数 / 窗口函数 / CTE / WAL | ✅ 全可用 |
| `VACUUM INTO` 一致性备份 | ✅ 可用 |
| `scrypt` 密码哈希 / `randomBytes` token / HMAC / `timingSafeEqual` | ✅ 可用 |
| SSE 零依赖推送 | ✅ 可用 |

**为什么不用 Express / Fastify / React**：每一个第三方依赖都在"移植性"这条约束上扣分。Express 简单，但要 `npm install`；React 要装依赖 + 构建。**对一个要交给组员、交给组委会、交给下一届城市联络员的系统，"别人跑不起来"是最大的实际风险**，而它恰恰是这类技术栈最常见的失败模式。

> 这不是"越轻越好"的洁癖。**可移植性的真实成本不在写代码时，在别人接手时。**

### 4.3 目录结构

```
platform/
├── package.json              {"type":"module","scripts":{"start":"node src/server.js","test":"node --test"}}
├── src/
│   ├── server.js
│   ├── http/       router.js  respond.js  body.js  static.js  sse.js
│   ├── auth/       password.js  session.js  permissions.js
│   ├── domain/     scoring.js  ranking.js  points.js  visibility.js
│   │               registration.js  solvability.js
│   ├── services/   registration.js  team.js  review.js  leaderboard.js
│   │               enterprise.js  workflow.js  pools.js
│   ├── db/         sqlite.js  migrations/  repo/
│   └── audit/      log.js  snapshot.js
├── rules/          ★ 声明式规则配置（JSON，改这里 = 改规则）
│   ├── scoring-initial.json      初赛权重表
│   ├── scoring-final.json        决赛权重表
│   ├── tiebreak.json             ★ 有序破同分链（【冲突】C-03）
│   ├── ranks.json                段位表 D/C/B/A/S
│   ├── behavior-points.json      行为分明细与达标线
│   ├── visibility.json           ★ 分层公开策略（【冲突】C-02）
│   ├── registration-scoring.json SABC 3 维权重与阈值
│   ├── solvability.json          六维可解性分级
│   └── milestones.default.json   默认里程碑清单模板
├── web/            index.html  app.js  router.js  store.js
│                   api.js  api.demo.js  views/  styles.css
├── seed/           demo-data.json
├── scripts/        migrate.js  seed.js  backup.js  audit-scan.js
└── deploy/         heikesong.service  nginx.conf  docker-compose.yml  install.sh
```

---

## 5. 数据模型

### 5.1 实体清单

```
edition (届期) ──┬── city (城市) ──── task_package (任务卡/赛题)
                 │        │                    │
                 │        │              solvability (六维评估)
                 │        │                    │
                 │        └────── team (战队) ─┴── team_member
                 │                 │
                 │                 ├── milestone ─── milestone_signoff
                 │                 ├── stage_review (评委打分)
                 │                 ├── peer_review  (互评)
                 │                 ├── behavior_event (行为分)
                 │                 └── enterprise_confirmation (企业席评分+双签)
                 │
                 ├── user ── user_role (角色 × 作用域)
                 ├── stage (赛段) ── stage_result ── computation_snapshot
                 └── pool: projects / talents / resources
```

### 5.2 关键表设计

```sql
-- 身份与权限
CREATE TABLE users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
  mba_status TEXT NOT NULL,           -- 一堂MBA在籍 / 会员 / 其他
  org TEXT, created_at TEXT NOT NULL
);
CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                 -- admin|captain|member|judge|enterprise|observer|enterprise_admin
  scope_type TEXT NOT NULL,           -- edition|city|task_package|team|enterprise
  scope_id TEXT,
  PRIMARY KEY (user_id, role, scope_type, scope_id)
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

-- 报名
CREATE TABLE registrations (
  id TEXT PRIMARY KEY, edition_id TEXT NOT NULL, user_id TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  raw_score REAL,                     -- 3 维加权原始分（可复算）
  dimension_scores_json TEXT,         -- {direction:5, capability:4, collaboration:5}
  level TEXT,                         -- S|A|B|C
  level_final TEXT,                   -- 组委会复核后
  decided_by TEXT, decided_at TEXT, decision_note TEXT,
  created_at TEXT NOT NULL
);

-- 战队
CREATE TABLE teams (
  id TEXT PRIMARY KEY, edition_id TEXT NOT NULL, name TEXT NOT NULL,
  captain_id TEXT NOT NULL REFERENCES users(id),
  task_package_id TEXT REFERENCES task_packages(id),
  tier TEXT,                          -- 当前段位 D/C/B/A/S
  created_at TEXT NOT NULL
);
CREATE TABLE team_members (
  team_id TEXT NOT NULL, user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL, left_at TEXT,
  PRIMARY KEY (team_id, user_id)
);

-- 里程碑与企业签字（★ 客观事实）
CREATE TABLE milestones (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  title TEXT NOT NULL, fixed_at TEXT NOT NULL,   -- 报名时固定，不可自行新增（R-PTS-10）
  requires_signoff INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE milestone_signoffs (
  id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL REFERENCES milestones(id),
  enterprise_id TEXT NOT NULL, signatory_user_id TEXT REFERENCES users(id),
  department TEXT NOT NULL,           -- 技术部门 vs 业务部门（★ 段位 S 档只认业务部门）
  content TEXT NOT NULL,              -- ★ 签字必须有内容：解决哪个环节/落地时间/我方角色（R-JDG-14）
  signed_at TEXT NOT NULL, revoked_at TEXT
);

-- 评审（★ 主观评价，与上表是不同实体）
CREATE TABLE stage_reviews (
  id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, judge_id TEXT NOT NULL,
  team_id TEXT NOT NULL, dimension TEXT NOT NULL, raw_score REAL NOT NULL,
  submitted_at TEXT NOT NULL, calibrated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE enterprise_confirmations (
  id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, team_id TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  dimension TEXT NOT NULL,            -- 企业确认
  raw_score REAL NOT NULL,
  cross_judge_id TEXT,                -- ★ R2 双签：跨领域评委
  signatory_user_id TEXT,             -- ★ R2 双签：出题企业签字
  created_at TEXT NOT NULL
);
CREATE TABLE peer_reviews (
  id TEXT PRIMARY KEY, stage_id TEXT NOT NULL,
  from_team_id TEXT NOT NULL, to_team_id TEXT NOT NULL,
  score REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE behavior_events (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT,
  type TEXT NOT NULL, points REAL NOT NULL, evidence TEXT, created_at TEXT NOT NULL
);

-- 计算快照（★ 可复算的载体）
CREATE TABLE computation_snapshots (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,   -- stage_score|rank|segment|tier
  edition_id TEXT, stage_id TEXT, team_id TEXT,
  rule_version TEXT NOT NULL,               -- 规则配置版本
  input_json TEXT NOT NULL, output_json TEXT NOT NULL, trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail_json TEXT, created_at TEXT NOT NULL
);
```

### 5.3 【决策】两种"企业签字"必须分表

**这是本设计最容易做错、后果最严重的一处。**

S7 §5 修正② 原文：

> | | 企业确认权重 `w_E = 25%` | B 榜企业签字认定 |
> |---|---|---|
> | 是什么 | 评委体系内的一个**打分维度** | 企业对**商业里程碑**的**事实确认** |
> | 进不进总分 | ✅ 进 | ⛔ 不进 |
> | 决定什么 | 赛段名次 + 奖金 | 完赛认定 + 资源解锁资格 |
> | 评分者 | 企业席 + 评委席，**双签** | 企业单方签字，**不评分** |
>
> **一句话区分**：**`w_E` 是「企业觉得这个做得好不好」，B 榜签字是「这件事到底发生了没有」。**

**【决策】** 拆成两张表：`enterprise_confirmations`（主观评分，双签，进总分） vs `milestone_signoffs`（客观事实确认，单签，不进总分）。

**为什么这样落地**：
- 两者**共用「企业签字」这一个数据源**，但**不共享任何一条规则**（S10 §4 原文）。同源但异表，正好表达"同源不共规则"。
- 若合表，必然出现一个字段同时被两个算法读取——而 S10 §8 第三条风险原文是：「**分轨必须是算法层面的，不是纪律层面的**」。合表就是纪律层面分轨，会破。
- 表名直接对应原文用词：`confirmations`（评价）/ `signoffs`（事实确认）。看代码的人不需要翻文档就知道哪个是哪个。

**【决策】段位 S 档必须区分签字部门**：`milestone_signoffs.department` 存"业务部门/技术部门"，段位计算只认业务部门签字（R-PTS-03：「技术部门签字只说明"方案能接"，业务部门签字才说明"这件事值得做"」）。

### 5.4 三池底座

```sql
CREATE TABLE pool_projects (id TEXT PRIMARY KEY, edition_id TEXT, team_id TEXT, ...);
CREATE TABLE pool_talents (id TEXT PRIMARY KEY, user_id TEXT, edition_id TEXT, total_points REAL, ...);
CREATE TABLE pool_resources (id TEXT PRIMARY KEY, enterprise_id TEXT, kind TEXT, ...);
```

一期只建表 + 提供仓储接口，**不建前台页面**（§1.2）。`pool_talents.total_points` 由个人积分聚合而来，天然可从积分事件派生，不做冗余存储（派生值由计算快照统一产出，避免两处算出不同结果——这正是本项目"同一动作在两份材料里被标成一手与二手"的同构风险）。

---

## 6. 规则引擎（核心）

### 6.1 【决策】三条设计原则

| # | 原则 | 为什么 |
|---|---|---|
| 1 | **配置驱动** | 56 条机制件级需求待组委会确认。硬编码 = 改一次数值就要改代码 |
| 2 | **纯函数** | 规则逻辑可脱离系统完整阅读与单测；评审时能逐行核对 S7/S10 原文 |
| 3 | **每次计算留 trace** | 榜单必须可复算（S-1）；且降级状态必须可见（S-5） |

### 6.2 评分算法（对应 S7 §3）

```js
export function scoreStage({ config, judges, submissions, enterpriseConfirmations, peerReviews })
```

**Step 1｜分组**：按维度收集所有评委的原始分 `s[i][d]`（0–100）。

**Step 2｜逐评委归一化**（S7 §3.1 原文口径）：
```
mean(i,d)  = 评委 i 在维度 d 上、对全部参赛队给出的打分的均值
stdev(i,d) = 同上标准差
z[i][d]    = (s[i][d] − mean(i,d)) / stdev(i,d)
样本数 < config.minSamplesForJudgeNormalization（默认 5）→ 退回全局均值/标准差
stdev = 0 → 该评委该维度无区分度 → z = 0，并在 warnings 中记录
```
> ⚠️ **注意口径**：均值/标准差是「**该评委在该维度上的全部打分的**均值」——归一化的是**评委的宽严**，不是队伍的分数。这一条极易实现错，代码注释必须写明。

**Step 3｜去极值**（S7 §3.2）：同维度内去掉一个最高 z、一个最低 z 后取均值；要求该维度有效评委数 ≥ 5，不足则不去极值。

**Step 4｜评委席得分**：
```
P = Σ_d ( weight_d × mean_over_j( z[j][d] ) )     // d 仅限评委维度
```

**Step 5｜企业席得分 E**（0–100，含 R1–R3 约束）：
- **R1 分赛道**：企业评委给非本企业题目打分时，该队该项权重自动降为 0（由跨领域评委代打）
- **R2 双签生效**：需「出题企业签字 + ≥1 名跨领域评委签字」，缺任一 → 该项按 0 分计，并记 warning
- **R3 上限封顶**：企业评委合计权重 ≤ 25%

**Step 6｜总分**（S7 §3.1）：
```
总分 = (1 − w_E) × P + w_E × E
w_E：决赛 0.25 / 初赛 0.10   ← 【冲突】C-01 已裁决，初赛取 10%
```

**Step 7｜自评测差异检测**（S7 §4.3）：
```
d = 自评分 − 评委分（归一化到同一尺度）
|d| ≤ 10 → 无影响
d > 10   → 触发复核：要求团队书面说明自评理由；不成立则自评分对齐评委分（不加分）
d < −10  → 触发复核：评委向团队提问（只提问，不改分）
```

**Step 8｜互评**：仅在破同分链中生效（S10 §0.4）。互评资格校验：该赛段有真实交付物的队伍才可参与互评（R-RNK-07）。

**Step 9｜破同分链**：见 §6.4。

**Step 10｜【决策】行为分完全不参与本函数**。
> S10 §8 第三条风险原文：「行为分被当成主评分……⭐ **算法层面强制分离**（《评分机制 S7》§3.1 总分公式不含 B 项），不依赖人的自觉」「**分轨必须是算法层面的，不是纪律层面的**」。

**【决策】实现方式**：`scoreStage()` 的入参对象类型中**根本不存在行为分字段**。调用方即使传入也会被丢弃。同时加一条单元测试断言"行为分变化不影响总分"。

### 6.3 名次与积分

**赛段名次积分**：任务包内全量战队排名，第一/二/三名 = 10/8/5（任务书 §七）。
**MVP**：4 赛段总积分 + S4 路演评审综合，每个任务包 1 个。
**个人积分**：赛段积分 + MVP 投决积分，**终生上榜**（任务书 §七）。

### 6.4 【冲突】C-03 破同分链（有序，可配）

```json
{
  "chain": [
    { "key": "total",           "desc": "总分" },
    { "key": "tiebreak_extra",  "desc": "加时陈述复议分", "stage": "final", "manual": true },
    { "key": "peer",            "desc": "互评分",       "only_when": "tied" },
    { "key": "enterprise_raw",  "desc": "企业确认原始分", "only_when": "tied" },
    { "key": "behavior",        "desc": "行为分",        "only_when": "tied" },
    { "key": "team_id",         "desc": "队伍编号",      "desc2": "最终确定性兜底" }
  ]
}
```

**为什么这样排**：三条原规则各自说了一个不同层级的破同分手段，原文档没给它们排序，所以「互评是唯一破同分依据」与「行为分也可以用」才矛盾。排序依据**强度递降**：人工复议 > 评审互评 > 单一维度原始分 > 过程参与度。最后一条 `team_id` 是**新增的**——三份文档都没写，但没有它，同分且全部分数相同时排序不确定，榜单不可复算，违反 S-1。它不影响任何实质名次（走到这一步本身就是并列）。

**状态**：⛔ 待组委会确认。若组委会坚持「互评是唯一」，则移除 `enterprise_raw` 与 `behavior` 两项。

### 6.5 段位与行为分

**段位（锚定企业签字的里程碑数）**：

| 段位 | 里程碑数 | 附加条件 |
|---|---|---|
| D · 出题 | 0（报名即入档） | — |
| C · 立项 | 1 | — |
| B · 原型 | 2 | — |
| A · 接入 | 3 | 含 ≥1 项数据接入或原型交付 |
| S · 验证 | 5 | 含 ≥1 项**企业业务部门**签字 |

**【决策】段位可降级**（S10 §2.3 要点 2）：里程碑被撤回签字 → 降回对应档；连续 14 天零提交且无合理说明 → 降 1 档并公示。
**【决策】段位只影响同分排序，不制造额外名额**（S10 §2.3 要点 3：「否则段位就变成了准货币」）。

**行为分明细**（S10 §3.1）：每周进度 2 / workshop+课后产出 3 / 按时交付里程碑 5 / 完成企业对接会 5 / 首次 Demo 10。达标线 60 → 完赛认定。
**【决策】行为分只做"垫底排序"**（S10 §3.3）：决赛名次 0%；同分时的**最后**排序依据可用；同分时的**第一**排序依据不可用；奖金无关。

### 6.6 可见性策略（分层公开）

| 内容 | 公开范围 | 来源 |
|---|---|---|
| A 榜赛段名次与滚动总榜 | 全员公开 | 任务书 §七 明文 |
| B 榜商业里程碑达成情况 | 公开 | S10 §0.3 |
| B 榜具体评分与签字人 | **不公开** | S10 §0.3（避免私下公关 + 逼出人情分） |
| 段位榜队名 | C 段及以上 | 【冲突】C-02 已裁决 |
| D 段 | 只公示个人进度，不公示排名 | 同上 |
| 企业名（段位公示时） | 不公示 | S10 §8 |
| 互评来源 | 不公示 | S10 §0.4 |

**【决策】可见性在 API 层过滤，不在前端隐藏**。前端隐藏 = 数据已经发到浏览器 = 任何人都能看到。前端只能拿到「有权看到的部分」。

### 6.7 配置清单

| 文件 | 内容 | 变更影响 |
|---|---|---|
| `scoring-initial.json` | 初赛 6 维权重、`w_E`、`minSamples` | 改后需重算该赛段 |
| `scoring-final.json` | 决赛 6 维权重、`w_E` | 同上 |
| `tiebreak.json` | 有序破同分链 | 同上 |
| `ranks.json` | 段位门槛、额外条件、降级规则 | 改后需重算段位 |
| `behavior-points.json` | 行为分明细、达标线、占比上限 | 改后需重算完赛认定 |
| `visibility.json` | 分层公开规则 | 即时生效（读时过滤） |
| `registration-scoring.json` | SABC 3 维权重、阈值、等级映射 | 改后需重算报名分级 |
| `solvability.json` | 六维权重、A/B/C/D 分级、一票否决项 | 改后需重算任务卡分级 |
| `milestones.default.json` | 默认里程碑清单模板 | 影响新报名队 |

**【决策】配置校验 fail-fast**：加载配置时校验权重合计 = 100%、阈值单调、段位门槛递增。**任一不满足则拒绝启动并报错**，不降级为默认值。
> 这条直接防住【冲突】C-01 类错误：若有人把初赛 `w_E` 改成 20%，配置校验会在启动时就失败，而不是安静地算出一个错位的榜单。

---

## 7. 权限模型

**角色**：`admin`（组委会）｜`captain`（队长）｜`member`（组员）｜`judge`（评委席）｜`enterprise`（企业席）｜`observer`（观察员，**无投票权**）｜`enterprise_admin`（企业管理员）

**作用域**：`scope_type ∈ {edition, city, task_package, team, enterprise}` —— 角色与作用域绑定，而非全局。

**关键行级规则**：

| 规则 | 实现 |
|---|---|
| 企业席只能评本企业出的题（R1） | 计算时校验 `team.task_package.enterprise_id === judge.enterprise_id`，否则该队企业确认项权重置 0 |
| 观察员无投票权 | 提交评分接口拒绝 `observer`；读接口允许 |
| 回避（R5） | 评分前校验评委是否为该作品的供应方/投资方/前雇主；回避记录写 `audit_log` |
| D 段不公示排名 | 榜单 API 按 §6.6 过滤；本人可见自身进度 |
| B 榜签字人不公开 | 战绩卡接口只返回里程碑达成状态，不返回签字人与评分 |
| 企业评委合计权重 ≤25%（R3） | 计算时封顶 |
| 组委会可查全部审计 | `admin` 读 `computation_snapshots` 与 `audit_log` |

**会话**：`HttpOnly` + `SameSite=Lax` Cookie；服务端 session 表；`scrypt` 存密码。

---

## 8. API 设计

```
认证
  POST   /api/auth/login              {phone,password} → session
  POST   /api/auth/logout
  GET    /api/me                       → user + roles + scopes

报名与组队
  POST   /api/registrations            提交报名 → 自动算分分级
  GET    /api/registrations/:id        组委会看可解释明细
  POST   /api/registrations/:id/level  复核/申诉改级
  POST   /api/teams                    建队（认领任务包）
  POST   /api/teams/:id/members        加入 / 退出 / 汰换
  PATCH  /api/teams/:id                改队名 / 换任务包

企业侧
  POST   /api/task-packages            企业提交任务卡
  POST   /api/task-packages/:id/solvability   六维可解性评估
  POST   /api/task-packages/:id/approve       分级 + 签约类型
  POST   /api/signoffs                 企业签字里程碑（带内容 + 部门）
  POST   /api/signoffs/:id/revoke      撤回签字 → 触发段位降级

评审
  POST   /api/stages/:stageId/reviews       评委批量打分
  GET    /api/stages/:stageId/review-state  评分进度 / 缺谁
  POST   /api/stages/:stageId/calibration   校准打分（不计入）
  POST   /api/stages/:stageId/peer-reviews  互评
  POST   /api/stages/:stageId/self-review    自评测
  POST   /api/stages/:stageId/compute       ★ 计算 → 结果 + trace

榜单
  GET    /api/leaderboard/:stageId?scope=rank|business|personal
  GET    /api/teams/:id/performance-card     项目商业战绩卡
  GET    /api/teams/:id/tier                 段位与权益

工作流（S2/S3）
  GET    /api/workflows/:id/tasks
  POST   /api/tasks/:id/claim                自主领取

审计
  GET    /api/audit/computations/:id         计算快照（可复算）
  GET    /api/audit/log                      审计日志
  GET    /api/events                         ★ SSE 实时事件流
```

**【决策】`compute` 是显式动作，不自动触发**。发榜是一个有后果的动作（影响奖金），必须有明确的操作者与时间戳，自动触发会让"谁在什么时候改了什么"不可追。

---

## 9. 前端信息架构

```
未登录 → 登录
  ↓
选手视角                        组委会视角                    企业视角
├─ 报名（SABC 3 维问卷）        ├─ 报名筛选台（含可解释明细）  ├─ 任务卡提交
│  + 筛选标准明示               │  + 复核/申诉/改级            │  + 六维可解性自评
├─ 我的战队                     ├─ 战队总览                    ├─ 里程碑签字
│  + 组队/汰换                  │  + 任务包与配比 70/30         │  + 战绩卡
├─ 赛段与任务清单               ├─ 赛段配置与权重表            ├─ 我的赛道评测
│  + 自主领取任务               │  + 评委池与校准              └─ 资源池（企业侧）
├─ 榜单（A 榜 / B 榜 / 个人）   ├─ 计算与发榜（含 trace 抽屉）  评委视角
├─ 段位与权益                   │  + 审计与复算                ├─ 我的待评作品
├─ 战绩卡                       │  + 三池底座                   ├─ 打分界面（含回避提示）
└─ 合规同意与授权               └─ 部署与备份                   └─ 互评（同分破同分用）
```

**关键界面**：

| 界面 | 关键设计 |
|---|---|
| **报名问卷** | 每题显示该题所属维度与分值；**明示筛选标准**（R-REG-09）；提交后展示"你被判为 X 级"及**可解释明细** |
| **评审打分** | 逐队逐维度；**企业席页面显示"你只能评本赛道"**；回避自动提示；显示当前样本量与是否已归一化 |
| **发榜页** | 榜单 + **trace 抽屉**（点任一队伍 → 展开每一步：原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分）；**降级告警置顶** |
| **战绩卡** | 7 类里程碑勾选式（企业问题确认 / 真实数据接入 / 可演示原型 / 试点合同 / 业务迭代 N 轮 / 意向客户 M 家 / 确认收入 ¥X），企业签字标识，**不显示签字人** |
| **段位榜** | C 段及以上显示队名与名次；D 段只显示本人进度卡 |

---

## 10. 三条主数据流

### 流 1｜报名 → 分级 → 组队
```
选手提交 answers
  → domain/registration.score()  3 维加权 → total 0–100 → level S/A/B/C
  → 组委会复核 / 申诉 → level_final
  → 队长建队 → 认领任务包 → 成员加入
  → 校验：队长 MBA ✅｜人数 ≥2 ✅｜任务包可解性已分级 ✅
```

### 流 2｜评审 → 计算 → 名次
```
赛段开始 → 评委池就位 → 校准打分（不计入）
  → 评委逐队逐维度打分
  → 企业席打分（受限本赛道）+ 双签校验（R1/R2/R3）
  → 自评测 → 差异检测 → 触发复核
  → 互评（限有交付物的队伍）
  → POST /compute
      → domain/scoring.scoreStage()  ★纯函数
      → 写 computation_snapshot（input + output + trace）
      → domain/ranking.rank()  破同分链
      → 写 stage_results
  → SSE 广播
```

### 流 3｜里程碑 → 段位 → 权益
```
企业签字（含部门 + 内容）→ signoffs 生效
  → milestone 达成
  → domain/points.tier(team) → D/C/B/A/S
  → 行为分累计 → ≥60 → 完赛认定 + 完赛证明
  → 权益解锁（仅影响同分排序，不产生额外名额）
```

---

## 11. 错误处理与失效防护

> 对应项目自身教训：**「静默的空产出比报错更危险——它不触发任何异常，流程照常往下走，最后交付一份缺了一块、且没人发现的材料。」**

| 失败场景 | 处理 |
|---|---|
| 配置权重合计 ≠ 100% | **启动即失败**（fail fast），不降级为默认值 |
| 配置缺项 / 非法值 | 同上，错误信息指明文件与字段 |
| 评委样本不足 | 用配置指定的 fallback；在 `trace.normalization` 标记；榜单页**显式提示**「本轮该维度未做评委宽严归一化（样本不足 5）」 |
| 某维度无人打分 | 该维度权重记 0 并列入 warnings，**不静默当 0** |
| 企业双签缺一 | 该队该项按 0 分计（R2 原文），记 warning |
| 某队没有任何评分 | 该队不参与排名，列入 warnings，**不排到末位假装有分** |
| 批量提交返回空 | 接口返回 4xx，**绝不返回空成功** |
| 数据库写入失败 | 事务回滚，无部分写入 |
| SSE 断连 | 客户端指数退避重连；服务端清理连接 |
| 并发写同一队伍 | SQLite 事务 + `BEGIN IMMEDIATE`；同实体写串行化 |

---

## 12. 审计与可复算

**每次计算产出三件套**：

```js
{
  rule_version: "scoring-final@2026-10-20",
  input:  { /* 参与计算的原始数据快照 */ },
  output: { /* 每队每维度的分数与最终名次 */ },
  trace: {
    normalization: {
      "创新性": { normalized: true, fallbackReason: null,
                  judgeSampleSizes: { "j1": 8, "j2": 8 } },
      "技术可行性": { normalized: false,
                      fallbackReason: "judge_sample_too_small" }   // ★ 显式暴露
    },
    steps: [ { step: "trim", dimension: "创新性",
               removed: { max: "j3", min: "j7" } } ],
    weights: { "创新性": 0.20, ... },
    perTeam: { "t1": { raw: {...}, z: {...}, seatP: 71.2, seatE: 80.0, total: 73.3 } }
  }
}
```

**复算入口**：`GET /api/audit/computations/:id` → 前端可一键"用同一输入重算"并 diff。
**这直接服务 S7 §4.2「赛后 6 个月可查」**，也服务 S10 §4.1「TOP 名单事后电话回访」——回访时能当场调出当时的原始分与归一化过程。

---

## 13. 测试策略

**用 `node:test`（Node 内置）→ 零依赖。**

| 层 | 覆盖 |
|---|---|
| **配置校验** | 权重合计 ≠100% 必须抛错（防【冲突】C-01 类回归）；阈值单调；段位门槛递增 |
| **评分引擎** | 已知评委矩阵 → z 值、去极值结果、P/E 加权；`stdev=0` 分支；样本不足 fallback |
| **分轨断言** | ⭐ **行为分变化不影响总分**（S-3 的自动化保证）；`scoreStage` 入参含行为分时被丢弃 |
| **破同分链** | 构造同分场景，验证链顺序生效；全同分时落到 `team_id` 兜底且结果稳定 |
| **段位** | 边界：3 项含接入 → A；5 项含业务部门签字 → S；技术部门签字不计入 S |
| **可见性** | D 段不出现在榜单；B 榜响应体不含签字人；观察员不能提交评分 |
| **企业约束** | R1 非本赛道权重置 0；R2 缺签计 0；R3 合计封顶 25% |
| **报名分级** | SABC 3 维加权 → 阈值边界（79/80、59/60、39/40） |
| **数据层** | 迁移幂等；事务回滚；并发写不产生脏读 |
| **端到端** | 报名→组队→打分→计算→发榜→战绩卡 全链路（用种子数据） |

---

## 14. 部署

### 14.1 本地 / 内网
```bash
cd platform
node scripts/migrate.js     # 建库 + 迁移
node scripts/seed.js        # 种子数据（可选）
node src/server.js          # 默认 http://127.0.0.1:8080
```
环境变量：`PORT` `DATA_DIR` `SESSION_TTL_DAYS` `BASE_PATH`

### 14.2 云主机
- `deploy/heikesong.service`（systemd 守护）
- `deploy/nginx.conf`（反代 + TLS + 静态资源缓存）
- `deploy/docker-compose.yml`
- `deploy/install.sh`（一键：装 Node → 写 service → 配 nginx → 建库 → 初始化管理员账号）
- `scripts/backup.js`（`VACUUM INTO` 一致性备份 + 保留策略 + 定时）

### 14.3 公网演示版（现在就能拿到的 URL）
前端代码 **100% 复用**，只换数据层：
- `web/api.js` → 真实 HTTP 客户端
- `web/api.demo.js` → `localStorage` 适配器 + `seed/demo-data.json`

**演示版能做什么**：完整走一遍报名 → 打分 → 发榜 → 段位 → 战绩卡的流程，所有规则引擎**在浏览器里真实运行**（不是假数据硬编码的结果）。
**演示版不能做什么**：数据不跨人共享（各自浏览器独立）。这是当前无云主机条件下的客观边界。

> **【兜底】** 正式系统与演示版**共用同一套规则引擎与前端视图**。这意味着演示版演示出来的算法行为，与正式系统一致——不会出现"演示好看，正式不一样"。

---

## 15. 实施路线

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0 地基** | 仓库骨架、SQLite 封装、迁移机制、配置加载 + 校验、HTTP 路由、认证会话 | 能登录的空系统 |
| **P1 报名与组队** | SABC 算分分级、注册流程、战队与成员、任务卡与六维准入 | 报名到组队全链路 |
| **P2 评审引擎** | 评分界面、z-score、去极值、双签、回避、自评检测、互评 | 能真实算分 |
| **P3 榜单与积分** | 破同分链、A/B/个人榜、段位、行为分、战绩卡、可见性过滤 | 能真实发榜 |
| **P4 审计与可复算** | 计算快照、trace 抽屉、审计日志、复算 diff、扫描闸 | 榜单可复算 |
| **P5 工作流与三池** | 任务清单与领取、三池底座接口 | 数据沉淀 |
| **P6 部署** | 部署资产、备份恢复、演示版适配器、静态站发布 | 公网 URL + 云主机就绪 |

**排序理由**：P2/P3 是这个平台**不可替代的核心价值**（S7/S10 的算法只有我们实现了），必须最扎实。P5 的三池放到后面，因为它是派生数据。P6 的演示版在 P3 完成后即可发布，不必等全部完工。

---

## 16. 风险与已知边界

| # | 风险 / 边界 | 说明 | 缓解 |
|---|---|---|---|
| 1 | **规则本身待组委会确认** | 56 条机制件级需求未确认 | 全部配置化；配置版本随快照留档 |
| 2 | **【冲突】C-01~C-06 未追认** | 我方文档内部矛盾 | 已在 `rule-decisions.md` 裁决并标注来源；配置可改 |
| 3 | **z-score 可能长期不生效** | 任务包只有 2–3 队，样本 <5 → 走全局回退（C-05） | 显式暴露降级状态；建议专家席跨包评分 |
| 4 | **企业愿不愿配合签里程碑** | S10 §10 自陈：「这是整个设计成立的前提，但没有证据」 | 平台侧做成"签字成本可配置 + TOP 回访任务" |
| 5 | **公网正式版需云主机** | 当前无云账号/隧道/Docker | 部署资产一次交齐；演示版先上线 |
| 6 | **规则引擎由 AI 实现** | 规则理解可能有偏差 | 每条规则在代码注释里**引用原文定位**；配置校验 + 单元测试双保险 |
| 7 | 未做端到端压测 | 数据量小（~50 人） | 瓶颈在网络；预留 SSE 与静态缓存 |

---

## 17. 附录：证据与不确定性

### 17.1 本设计的事实基础

| 结论 | 来源等级 | 独立源数 | 敢兜底吗 |
|---|---|---|---|
| 平台三模块（报名/榜单/评审） | 【权威】任务包 T1 原文 | 1 | Y |
| 初赛/决赛双权重 + z-score + 去极值 | 【权威】S7 §2–§3（我方机制件） | 1 | Y（作为"我方规则"） |
| 双榜并列、三层分离、段位锚企业签字 | 【权威】S10 §0–§4（我方机制件） | 1 | Y（作为"我方规则"） |
| SABC 3 维 100 分与四级 | 【机制件】SABC v1 草稿 | 1 | Y（作为"我方规则"） |
| 六维可解性与一票否决 | 【机制件】顶层文档 §3.2 | 1 | Y（作为"我方规则"） |
| `node:sqlite` / SSE / scrypt 可用 | 【实测】本机 Node 22.23 | 1 | Y |
| AGPL-3.0 §13 网络服务义务 | 【官方】gnu.org 许可证原文 | 1 | Y |
| 开源项目可借鉴清单 | 【多源】§3 待回填 | — | — |

> ⚠️ **诚实声明**：S7 / S10 / SABC / 顶层文档**全部出自同一团队**，**不构成多方独立互证**。它们是"我们自己的规则"，不是"行业已验证的规则"。凡标 `我方假设` 的条目，实现时必须留可调参数与回测接口。
> ⚠️ **AGPL 提示**：JunctionApp、Hackerspace3 为 AGPL-3.0。AGPL §13 原文：「**if you modify the Program**, your modified version must prominently offer all users interacting with it remotely … an opportunity to receive the Corresponding Source」。**学习其设计并自写代码不受此限；复制其代码并部署为网络服务则触发开源义务。** 凡拟复用代码的候选，一律只选 MIT/Apache 系。

### 17.2 待补内容

- [ ] §3 开源调研回填（4 条轴）
- [ ] 截图位（沿用一页纸的 4 张惯例）
- [ ] 组委会对本设计的确认（尤其 §6.4 破同分链、§6.2 初赛 `w_E`）
- [ ] 脱敏核对：本文档涉及内部项目路径与合作方信息

---

*本文档随规则变更同步更新。每次发版在 `computation_snapshots` 留 `rule_version`，可回溯"当时用的是哪版规则"。*

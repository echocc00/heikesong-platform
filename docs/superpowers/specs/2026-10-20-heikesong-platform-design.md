# AI 商业黑客松赛事平台 · 设计文档

| 项 | 值 |
|---|---|
| **日期** | 2026-10-20 |
| **状态** | 待评审 |
| **作者** | 零号备战组（T1 第 2 组）· MCode 协作产出 |
| **仓库** | `/Users/mac/soft/AI/orca/heikesong` |
| **代码目录** | `platform/` |
| **配套文档** | [`docs/requirements-traceability.md`](../../requirements-traceability.md)（需求溯源表，96 条）<br>[`docs/rule-decisions.md`](../../rule-decisions.md)（规则冲突登记表，6 条） |

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
| S-7 | **规模达标** | 首届 ≥ 4 支队完成报名并建队（M1 试赛底线）；正式届按当届目标报名数 |
| S-8 | **评审无漏评** | 每个赛段 × 每支参赛队伍 × 每个投票维度都有分；评委池合规；归一化降级不成为常态路径 |
| S-9 | **按时发榜** | 赛段结束后 72 小时内发榜（写 `leaderboard_snapshots` + `points_ledger`）；按时发榜率 ≥ 90% |
| S-10 | **闭环时效与产出** | 申诉 72 小时内裁决；企业签字数 = 里程碑达成数；**完赛认定数 > 0**（完赛线在真实赛程内可达） |

#### 1.3.1 业务验收指标（S-7 ~ S-10）：怎么量、今天有没有机器检查

⚠️ **这四条是业务指标，不是测试数**（M0-7，2026-10-26）。前六条（S-1~S-6）判定的是「系统做得对不对」，
这四条判定的是「赛事办成了没有」⇒ **只能由真实赛事数据回答，测试再绿也证明不了**。

| 标准 | 数据来源 | 今天有没有**能自动失败**的检查 | 缺口 |
|---|---|---|---|
| S-7 规模达标 | `teams` / `registrations` 行数 | ⚠️ **部分**（E181）：**队伍数**可算并已进就绪度汇总（`GET /api/readiness` 的 `s7` 段：队伍数 vs 门槛） | 「**报名数**」口径（`registrations` 行数与去重规则）仍需真实赛事数据校准；⚠️ 队伍数达标**不等于**报名数达标（报名可能一人多报/被刷掉） |
| S-8 评审无漏评 | `stage_reviews` 空缺 + 计算 trace 的 `normalization` 段 | ✅ **有**（E181）：**漏评覆盖率汇总闸**已落地（`src/services/readiness.js`）：应交 = 有投票权席位数 × 赛段名册队数 × 评委席维度数；已交取自 `stage_reviews`（软删与校准分已排除）；覆盖率 < 门槛 ⇒ **不达标**并给出漏评清单 | 覆盖率**闸**已补；仍缺「漏评**责任人**通知」链路（谁没交、通知谁、补交后是否自动重判）—— 属 M2 待办中心的事 |
| S-9 按时发榜 | `leaderboard_snapshots.created_at` vs 赛段 `ends_at` | ✅ **有**（E181）：**超期未发榜告警**已落地（`src/services/readiness.js`）：从赛段 `ends_at` 起算到**首次**发榜快照的 `created_at`；超时限 ⇒ 计入超期清单。⚠️ **E182 修正**：`never_published`（一次都没发过）与 `late`（发过但晚）**同一把尺** —— 两者都按 `delayHours > publishDeadlineHours` 判（修复前 `never_published` 是**无条件**超期 ⇒ 赛段结束 1 小时没发榜就报红，而已发榜的同一时刻要 >72h 才算 late ⇒ **同一条 SLA 两种不对称判定**，试赛第一天就会误报一片红） | 告警只**产出清单**，**不触发通知**（零通知能力是已知边界）；「重发榜」的口径已定（取**首次**发榜时刻，重发不掩盖首发的按时性） |
| S-10 闭环时效与产出 | `appeals`（SLA 字段已入库）+ `milestone_signoffs` + 行为分完赛认定 | ✅ **部分**（E181 补上可算的那部分）：申诉 SLA（72h）已由 `rules/compliance.json` 驱动并写进审计与裁决队列；**完赛线可达性已有开机机器闸**（`src/config.js`：赛程内行为分上限 < 完赛线 ⇒ 拒绝启动）；就绪度汇总的 `s10` 段**显式声明**「完赛认定数 > 0」与「按时发榜率 ≥ 90%」**需要真实赛事数据 ⇒ 本闸不判定** | 「完赛认定数 > 0」需真实赛事数据；⚠️ 就绪度汇总**故意不判定**这两项（不假装能算） |

⚠️ **口径纪律**：这些指标的阈值（72 小时、90%、4 支队）**目前是本平台自定的待确认值**（源文档未给），
与 `rule-decisions.md` 的 C-01~C-07 同款 ⇒ **一律配置化、可改、且明确标注「待组委会确认」」。
⚠️ E181 起，这三个阈值统一落在 `rules/compliance.json` 的 **`readiness` 段**
（`minReviewCoveragePercent` / `publishDeadlineHours` / `minTeamsForScale`）⇒ 改它们**只改配置、不改代码**。
⚠️ **不许把「测试全绿」当业务达标**：S-7~S-10 的验收依据是**真实办赛数据**，不是 CI 状态。
⚠️ **不许把「不可判定」说成「达标」**：赛段名册未登记（还没开打）⇒ 覆盖率返回 `not_applicable` + `coveragePercent: null`，
**绝不返回 100%**（那是把「没开始」说成「全都交了」）。

---

### 1.3.2 业务就绪度端点（E181）

`GET /api/readiness`（**只对组委会开放**：`audit:read` 能力点；未登录 401、无能力点 **403** —— ⛔ 不是 200 + 空集，
空集会被读成「各项都达标」）。

返回四段：

| 段 | 说什么 | 数据来源 |
|---|---|---|
| `s7` | 队伍数 vs 规模门槛 | `teams` 行数（`registrations` 口径待校准） |
| `s8` | **每个赛段**的评审覆盖率、是否达标、漏评清单 | `stage_reviews` + `stage_team` + `stage_judges` + `rules/scoring-*.json` 的维度 |
| `s9` | **每个赛段**的发榜时限、是否超期 | `stages.ends_at` + `leaderboard_snapshots.created_at` |
| `s10` | 显式声明哪些**判不了**（需真实赛事数据） | —— |

⚠️ **口径复用**：`s8` 的「应交/已交/缺谁」直接复用 `services/review.js` 的 `getReviewState`（管理员口径），
**不另起一套** ⇒ 闸里的数与评审工作台上显示的进度**永远是同一个数**。
⚠️ **S-8 / S-9 用的是赛段级名册（`stage_team`）**，不是届期级兜底名册 ⇒
「没登记名册的赛段」= **还没开打** ⇒ 覆盖率 `not_applicable`、发榜时限 `no_roster`（不计入超期）。
⚠️ **预演数据**：本轮另备了一套**预演数据集**（`platform/db/preview/preview-dataset.js`）装在**临时库**里
（schema 由**生产同款迁移**建出 ⇒ 表结构逐字一致）⇒ 用途是**评审功能行为是否符合预期**；
真实赛事数据到位后**直接灌进同一套表** ⇒ **闸的代码一行都不用改**。

---

## 2. 需求溯源（索引）

完整溯源表见 [`docs/requirements-traceability.md`](../../requirements-traceability.md)。
**逐条落地对照**（每条需求落在哪个阶段的哪个 Task、哪个文件、由哪条验收标准钉住）见
[`docs/requirement-implementation-map.md`](../../requirement-implementation-map.md) —— 该表的每一格都由
**代码里的溯源注释**与各阶段计划的验收标准表机器抽取生成，可重跑复核。
此处只给结论：

**分母声明**：需求全集 = **96 条**｜来源 = 任务书 2.0 + S7 + S10 + SABC + 顶层文档 + 项目自身复盘（6 类一手文档）｜独立源数 = 6（**同一作者体系，非独立互证**）

| 状态 | 条数 | 对实现的含义 |
|---|---|---|
| 已定 | 19 | 硬编码行为不可改 |
| **机制件（待组委会确认）** | **60** | **必须配置化** |
| 我方假设 / 待验证 | 8 | 必须留可调参数与回测接口 |
| 规则空白 | 2 | 需组委会拍板 |
| 非功能（推导） | 8 | 由用户决策直接推导 |

> **⭐ 贯穿全表的第一条设计结论**
> **60 条机制件级需求全部来自我们自己尚未被组委会确认的设计。硬编码 = 委员会改一次数值就要改代码、重新部署、重新验证。**
> → 核心规则全部走**声明式配置 + 纯函数引擎 + 计算留痕**。**换一次规则 = 改一份 JSON。**

> **⭐ 第二条设计结论**
> 对 S7/S10 做一致性审计，查出 **6 条自相矛盾或跨文件冲突**（`rule-decisions.md`）。其中 **C-01（初赛 `w_E` 10% vs 20%）若硬编码，初赛榜单会整体错位且不报错**——名次看起来仍然合理，不会有人发现。
> → 规则引擎必须额外做到 **每次计算留 trace + 降级状态显式暴露**。

---

## 3. 开源调研与借鉴结论

### 3.1 调研方法与分母

**分母声明**：本次分母 = **11 个黑客松/竞赛管理平台 + 9 个 headless 后端 + 8 个评分/表单/权限类项目**，共 28 个候选仓库｜来源 = GitHub API 元数据 + 各仓库源码 tarball 逐文件精读 + 官方许可证原文 + 官方文档站｜独立源数 = 28（**均为独立仓库，非同一来源复制**）

**检索方式**：`dribdat/awesome-hackathon`（311★，策展清单）作为入口 → GitHub API 检索（受限时改用 `raw.githubusercontent` 与 `codeload.github.com` tarball）→ 逐仓库读源码、读 LICENSE 原文、读官方部署文档。

### 3.2 一句话结论

> **没有任何一个开源项目能整体直接用；也没有必要整体 fork。**
> 但它们把三件最难从零想清楚的事给出了**可直接照抄的 MIT 实现**；而我们的差异化（双签 / 归一化 / 段位 / 滚动榜 / 匿名 / 回避）**全行业都是空白，必须自建**。

**决定性证据**：对 11 个黑客松平台全仓检索 `z_score / standardize / winsor / outlier / percentile` —— **零命中**。
**S7 设计的评委宽严归一化，在全行业开源项目里没有先例。** 这既证明必须自建，也印证了 S7 §7 自陈的「无先例、须首届后回测」。

### 3.3 零件级借鉴清单（这才是"不重复造轮子"的答案）

> **【决策】不 fork 任何整仓，只移植以下零件级实现。**

| # | 零件 | 来源 | 许可证 | 移植成本 | 照搬前必须改的 |
|---|---|---|---|---|---|
| 1 | **并列名次算法**（同分同名次，1224 式） | `HackSC/hibiscus` `libs/calculateRankings.ts` | MIT | 0.5d | ⚠️ 上游 `calculatePoints.ts` 的 `switch` **无 break 穿透**，实际是 18/8/3/1 而非 10/5/2/1，相对顺序不变但数值错——**抄时必须修** |
| 2 | **赛事分 / 行为分双列 + 行为分发放日志** | `HackSC/hibiscus` `leaderboard` / `bonus_points` 表 | MIT | 0.5d | ⚠️ 其 `getRank` 排序时又 `bonus_points + event_points` **相加** → 与"行为分不进总分"直接冲突，**必须改成只按 event_points 排** |
| 3 | **评审数据模型三件套**（多评委×多维度） | `deltahacks/portal` `prisma/schema.prisma` | MIT | 2–3d | 加 `Dimension{weight}`、匿名映射表、企业双签字段；其聚合层有 **bug**：按 trackId 过滤时 `generalScore` 因 `question.trackId === null` 恒假而恒为 0 |
| 4 | **贝叶斯评委宽严模型**（140 行纯 Python 自实现 digamma/lgamma，零第三方依赖） | `hack-the-back` `app/services/crowd_bt.py` | MIT | 1–2d | 改为 JS/TS 实现；作为 **z-score 的并行备选策略**，用于评委少、样本少的场景（见 C-05） |
| 5 | **幂等 + 行锁 + 只接受当前分配** | `hack-the-back` `app/services/judging.py` | MIT | 0.5d | 加"同一账号多设备协同投票"检测 |
| 6 | **破同分双保险**（同分先到者胜 + **行 ID 兜底**） | `CTFd/CTFd` `utils/scores/__init__.py` | Apache-2.0 | 0.5d | 保留双保险：不同数据库时间精度不同，只用一个时间字段会不稳 |
| 7 | **限频三层**（滑动窗口计数 + SETNX 提交锁 + INCR 每分钟配额） | `CTFd/CTFd` `api/v1/challenges.py` | Apache-2.0 | 0.5d | 键名换成维度 ID；再加**评委级配额**（每人每小时打分次数上限） |
| 8 | **可见性分档 + 受众白名单** | `CTFd/CTFd` `utils/config/visibility.py` + `Audiences`/`AudienceMembers` | Apache-2.0 | 1d | CTFd 只有「整档位 + 受众白名单」，**没有按名次区间分层** → 我们要新增 `min_visible_rank` + `min_visible_tier` |
| 9 | **规则引擎三态语义**（200+空集 / 404 / 403） | `pocketbase` Collection API Rules | MIT | 0.5d | 把 PocketBase 的过滤表达式 DSL 换成我们的 scope 谓词生成器 |
| 10 | **Admin Dashboard 三段式 + API Preview** | `pocketbase` | MIT | 1d | 三段导航改成「项目池/人才池/资源池」；API Preview 改成"当前用户在这条记录上能看什么" |
| 11 | **加权算分公式**（`percentile = (avg+shift)/(max+shift)`，`Σ percentile × weight` → 0–1） | `AmericanAirlines/Hangar` `api/criteriaJudgingSession/id/results/get.ts` | MIT | 0.5d | ⚠️ Hangar **只校验单个 weight∈[0.1,1]，没有校验权重和=1**（原作者留了 TODO）→ **我们必须自己加**（见 §6.7 fail-fast） |
| 12 | **rubric 不可变快照 + hash 去重** | `edx/edx-ora2` `base.py` | AGPL-3.0 ⚠️ | 0.5d | ⛔ **只读思路，代码独立实现**。snapshot 表结构我们自建 |
| 13 | **复核/申诉分阶段状态机**（含幂等守卫：只处理首次 edit） | `openreview/openreview-py` `*/process/*` | MIT | 1d | 状态改为我们的 `SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED`，加分叉 `FLAGGED`/`REJECTED` |
| 14 | **冲突申报**（venue 级策略 + 自动/自报双路径） | `openreview/openreview-py` `compute_conflicts_process.py` | MIT | 0.5d | OpenReview 是**分配前剔除**，我们要的是**评审后作废 + 留档** → 另加 `recusal_records` 表 |
| 15 | **赛段定义 + 阶段准入校验**（YAML 加载、字段级 min/max/test） | `dribdat/dribdat` `user/constants.py` `PR_STAGES` | MIT | 1d | 我们要把"阶段准入校验"改成"赛段窗口 + 结算条件" |
| 16 | **公开榜单 API + 赛程 iCal 订阅** | `dribdat/dribdat` `public/api.py` | MIT | 0.5d | 加鉴权分级（公开只读 vs 机器人写） |
| 17 | **赛制设计 SOP + 评委人数公式 + stack ranking** | `MLH/mlh-hackathon-organizer-guide` | CC-BY-4.0 | 0.5d | ⚠️ 复制文字**须署名**（MLH + 链接 + 改动说明）。stack ranking **只能作备选**——它丢失分差信息，与我们的「\|d\|>10 触发复核」冲突 |
| 18 | **组队 MILP 撮合**（Pyomo/HiGHS） | `dribdat/dribdat` `matching.py` | MIT | 3–5d | ⚠️ **HiGHS 需独立安装，违反零依赖 → 二期再做**。一期用「选手自选 + 组队长确认 + 组委会兜底配对」 |

**总计：18 个零件可移植，其中 14 个在一期落地（#4 与 #18 归入二期的算法备选与组队优化）。**

### 3.4 全行业空白清单（必须自建的部分，也是我们的护城河）

| # | 能力 | 全 11 个平台的现状 |
|---|---|---|
| 1 | **企业签字双签工作流**（双主体、各自签名、任一缺失即"部分生效"的状态机 + 审计） | ❌ 零实现。portal 的 `signature` 是参赛同意书与监护人签字，不是评审双签 |
| 2 | **z-score 归一化 + 去极值 + 百分位** | ❌ 零实现（全仓关键词检索零命中）。实际聚合只有三种：贝叶斯 μ 排序 / 名次映射成分数再平均 / 评委间算术平均 |
| 3 | **段位体系**（档位阈值 + 升降级 + 权益映射） | ❌ 零实现。hibiscus 的 battlepass 只有"积分 + 排行榜"，前三名是皇冠图标，**无档位阶梯** |
| 4 | **滚动榜**（赛段时间序列快照） | ❌ 所有榜单都是终态快照，无按赛段存储的历史榜单模型 |
| 5 | **匿名评审映射**（作品编号 ↔ 真实队伍） | ❌ 三个有评审的项目都实名存 `judgeId` 并直接展示作品名 |
| 6 | **利益冲突矩阵 + 回避改派** | ⚠️ 只有 JunctionApp 的 `allowVoteOnOwnProject` 与 hackerspace3 的 `cannot_judge_your_own_team`（仅"自己队"），无同校/同公司/同赛道 |
| 7 | **完整防刷分**（多账号协同投票检测） | ⚠️ Gavel 系做了配对/幂等/节流，但**无任何项目做多账号协同检测**；dribdat 的行为分榜是纯计数、零防刷 |
| 8 | **可解释评分回执**（选手能看到"我为什么得这个分"） | ❌ 零实现 |

> **⭐ 这 8 条就是本平台真正的护城河。** 它们不是"我们没找到"，是**全行业都没做**。

### 3.5 明确不借鉴的清单及理由

| 项目 | 不借鉴的理由 |
|---|---|
| **JunctionApp**（AGPL-3.0） | AGPL §13 网络服务即触发开源义务；根 `package.json` 固定 **Node 12.3.1（已 EOL）**；Auth0 需自建 Authorization Extension 并手工 PUBLISH RULES；210 open issues |
| **Hackerspace3**（AGPL-3.0） | AGPL；Rails 栈与我们的移植目标不符；GraphQL API 只是骨架（`resolve_type` 直接 raise） |
| **halo** | ⚠️ **仓库无 LICENSE 文件**（README 声称 MIT，API `license=None`）→ 法务不清不可抄码；且评审/榜单完全为零 |
| **OpenHackathon-service** | ⚠️ **后端仓无任何许可证** → 后端代码不可复用，只能看设计 |
| **Formbricks** | 主体 **AGPLv3** + `apps/web/modules/ee/` 为 **EE 商业许可**；⚠️ 根 LICENSE 声称 `packages/js`/`packages/api` 为 MIT，但**这两个目录在当前 main 分支已不存在**（404）；真正承载问卷运行时的 `packages/surveys` 不在 MIT 清单内 → 按根 LICENSE 措辞应视为 AGPLv3 |
| **Directus / NocoDB** | **许可证已变**：Directus = 自定义 MSCL-1.0-GPL（source-available，禁商业竞品用途）；NocoDB **2026-01-09 起从 AGPL-3.0 切换为 Sustainable Use License**（限内部/非商业）。且都需联网装依赖、自带数据库 |
| **Baserow / Strapi / Payload / Appwrite / Hasura** | 全部需联网安装或拉镜像；Baserow/Hasura **强制 Postgres**；Appwrite **需 Postgres + Redis + 多容器**；Strapi 的 EE 目录是商业许可 |
| **deltahacks/portal 的聚合层** | ⚠️ 已知 bug：按 trackId 过滤时 `generalScore` 恒为 0（通用维度被静默丢弃）。**只抄 schema，不抄聚合** |
| **hibiscus 的 `getRank`** | 排序时把 `bonus_points + event_points` **相加** → 与"行为分不进总分"直接冲突。**只抄名次算法与表结构，不抄排序** |
| **dribdat 的 `calculate_score()`** | 是"资料完整度"启发式（progress + 字段填写加分），**不是评审分**，绝不能当评审用 |
| **scipy / numpy** | 它们是 Python 生态，我们零依赖路线用不到。z-score 原语在 JS 里 20 行可写（且**我们的口径与 `scipy.stats.zscore` 不同**：我们对「评委×维度」归一化，不是对轴归一化） |

### 3.6 诚实记录：一个值得正面回应的反论

MLH 的组织者指南明确建议：**不要自建评审系统，用 Gavel 或 Google Sheet 更稳**。

**这条建议在多数情况下是对的，我们为什么仍要自建**：

| MLH 的前提 | 我们的情况 |
|---|---|
| 评审是多评委**排序**即可 | 我们要**加权维度分** + 企业签字双签 + 可签名的分数语义 |
| 评委可以跨赛道打分 | 企业席受 R1 限制只能评本赛道，样本量天然小 |
| 榜单 = 一次排序结果 | 我们要**双榜并列不合并** + **段位** + **分层公开** + **行为分隔离** |
| 用 Sheet 意味着规则改动即时生效 | 我们的规则有 60 条待组委会确认 —— Sheet 无法承载配置化 + 可复算 + 审计留档 |

**但这条建议提醒我们一件重要的事**：**不要低估"简单"的收益**。
→ 因此本设计把规则引擎做成**可切换的归一化策略**（z-score / median / trimmed-mean / 贝叶斯），首届后按实际数据回测选型，而不是一上来就锁死一种。

### 3.7 一个必须正面承认的取舍

调研也带来一条**与我们原设想冲突**的信息：**MLH 的 stack ranking 是一种更稳健的评委宽严归一化方案**——它只关心评委给出的**相对顺序**，天然消除宽严差异，且实现极简。

**但我们不能直接用它**，因为 S7 §4.3 的自评测差异检测依赖**绝对分差**（`d = 自评分 − 评委分`，\|d\| > 10 触发复核）。stack ranking 丢弃分差信息，会让这条复核机制失效。

**【决策】归一化策略做成配置项，四选一，首届时按实际数据回测**：

| 策略 | 出处 | 适合场景 |
|---|---|---|
| `zscore`（默认） | S7 §3.1 原文 | 评委数充足、样本量够 |
| `median` | ORA 思路（只读，独立实现） | 评委少、极端评委多时更稳健 |
| `trimmed` | Hangar 思路（20 次随机 + 截尾均值） | 顺序偏见明显时 |
| `bayes` | hack-the-back `crowd_bt.py`（MIT） | 样本极少时的兜底 |

**当前仍按 S7 原文实现 `zscore` 为默认**，但把策略切换的成本在 P2 阶段就做掉——避免首届结束后才发现要重写聚合层。

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
| 运行时 | Node ≥ 22.16.0 | `node:sqlite` 免 `--experimental-sqlite` 的下限 22.13.0 与 `sqlite.backup()` 的下限 22.16.0，取**并集** |
| **npm 依赖** | **0 个** | R-OPS-01/02：不能依赖联网 `npm install` |
| 数据库 | `node:sqlite`（内置） | 无原生编译、跨平台、单文件 |
| 前端框架 | 无。原生 ESM + 哈希路由 | 同上 |
| 测试 | `node:test`（内置） | 同上 |
| 密码哈希 | `node:crypto` `scrypt` | 已实测可用 |
| 实时推送 | SSE（`text/event-stream`） | 单向推送够用；已实测零依赖可用 |
| 会话 | HttpOnly Cookie + 服务端 session 表 | 同上 |

**已实测验证**（本机 Node 22.23.2，非推断）：

| 能力 | 结果 |
|---|---|
| `node:sqlite` 事务 / `user_version` 迁移 / JSON 函数 / 窗口函数 / CTE / WAL | ✅ 全可用 |
| **`sqlite.backup()` 一致性备份 API** | ✅ 可用（Node ≥22.16.0 引入）——**优于 `VACUUM INTO`，官方推荐** |
| `scrypt` 密码哈希 / `randomBytes` token / HMAC / `timingSafeEqual` | ✅ 可用 |
| SSE 零依赖推送 | ✅ 可用 |

**【决策】目标运行时 Node ≥ 22.16.0，开发与测试锚定本机 22.23.2**。
**理由**：Node 22.18+ 起默认开启 TypeScript type stripping（`.ts` 可直接 `node server.ts`），所以**后端也能零构建**，不只前端。

**版本下限为什么是 22.16.0（事实性修正，2026-10-20）**：初稿写的 `22.5` 是**错的** —— 22.5.0 只是 `node:sqlite` 的「引入版本」，不是「可用版本」。依据 Node v22 官方文档 SQLite 页的 History 表（<https://nodejs.org/docs/latest-v22.x/api/sqlite.html>）：

| 版本 | 官方原文 | 对本项目的含义 |
|---|---|---|
| v22.5.0 | `Added in: v22.5.0` | 引入 `node:sqlite`，但**必须**加 `--experimental-sqlite` 才能 import |
| v22.13.0 | `SQLite is no longer behind --experimental-sqlite but still experimental` | **免 flag 的真实下限** —— 本项目全程不用该 flag，故 22.5.0–22.12.x 会在 `import { DatabaseSync } from 'node:sqlite'` 处直接抛错 |
| v22.16.0 | `sqlite.backup(sourceDb, destination[, options])` — `Added in: v22.16.0` | §14 备份方案所依赖的一致性备份 API 的下限 |

`package.json` 的 `engines` 是**项目级**单一声明，应表达整个系统的运行时下限，因此取两个下限的**并集** = max(22.13.0, 22.16.0) = **22.16.0**。声明一个跑不起来的版本比声明一个略严的版本更糟：前者让用户以为 22.5 可用、装完才炸；后者只是提前挡掉 22.13–22.15（这三个小版本早已无人使用，22.16.0 发布于 2025-02）。生产仍推荐 Node 24。

**Node 24 是推荐的生产运行时，但本设计不使用任何 Node-24-only API**：
- Node 22 没有 `URLPattern`（Node 24 才有）→ **路由手写约 100 行**，不因此抬高运行时门槛
- 生命周期：Node 22 EOL **2027-04-30**；Node 24 EOL **2028-04-30**（2026-10-20 进维护期）
- **开赛前把版本写死，不用 `latest`**。生产建议 Node 24，但代码在 22 与 24 上都能跑——这正是可移植性的含义

**【决策】三条来自 SQLite 官方文档的硬约束**（sqlite.org 原文，非印象）：

| 约束 | 原文依据 | 对我们的含义 |
|---|---|---|
| **单写者** | 「There can only be a single writer at a time」 | ⛔ **禁止多 Node worker 进程同时写同一个 SQLite 文件**——这是 `SQLITE_BUSY` 的真正来源。扩容只能加读，不能加写进程 |
| **WAL 同主机** | 「All processes using a database must be on the same host computer; WAL does not work over a network filesystem」 | 一旦要**多机部署**，必须换 Postgres，没有第三条路 |
| **NFS 不可用** | fcntl 锁在 NFS 上不可靠 | 数据库文件不能放网络盘 |

**【决策】`node:sqlite` 是同步 API，慢查询会阻塞 event loop**（官方：「All APIs exposed by this class execute synchronously」）。
→ 全部 SQL **预编译 statement + 参数化**；**报表与大导出绝不放在请求路径**，放定时任务。

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

-- 增量统计（★ z-score 的输入，避免每次全量重算）
CREATE TABLE score_stats (
  judge_id TEXT NOT NULL, dimension TEXT NOT NULL,
  n INTEGER NOT NULL, mean REAL NOT NULL, sum_sq REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (judge_id, dimension)
);

-- 一票破同分（加时陈述）
CREATE TABLE tiebreak_round (
  id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, tied_group_key TEXT NOT NULL,
  statement_deadline TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE tiebreak_votes (
  tiebreak_round_id TEXT NOT NULL REFERENCES tiebreak_round(id),
  voter_id TEXT NOT NULL, team_id TEXT NOT NULL, score REAL NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (tiebreak_round_id, voter_id, team_id)   -- ★ 唯一约束保证一人一票
);

-- 人工复核与防作弊
CREATE TABLE flagged_reviews (
  id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, submission_id TEXT,
  kind TEXT NOT NULL,      -- self_vs_judge | burst_submit | identical_peer_pattern | low_variance
  detail_json TEXT, status TEXT NOT NULL,   -- open | confirmed | rejected
  reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE recusal_records (       -- ★ 回避留档（S7 §4.2 赛后 6 个月可查）
  id TEXT PRIMARY KEY, stage_id TEXT, judge_id TEXT NOT NULL, team_id TEXT,
  reason TEXT NOT NULL, source TEXT NOT NULL,   -- self_declared | detected
  declared_at TEXT NOT NULL, audit_by TEXT, action TEXT NOT NULL  -- drop_score | reassign
);
```

**【决策】评分记录只增不改（追加式日志），删除一律软删除**。
理由：Gavel 的 admin 删除逻辑在有投票后改为提示用 "disable" 而非硬删；CTFd 也有 `Discards` 概念。这条直接服务 S7 §4.2「赛后 6 个月可查」——**要能查，就必须不能被悄悄改掉**。

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
| 1 | **配置驱动** | 60 条机制件级需求待组委会确认。硬编码 = 改一次数值就要改代码 |
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
>
> ⛔ **不要用 `scipy.stats.zscore` 的语义**。那是「对给定轴做标准化」，我们的是「对评委的宽严做标准化」，两者数学形式相似、口径不同。

**【决策】归一化策略可切换（4 选 1）**：`zscore`（默认，S7 原文）｜`median`（ORA 思路，只读独立实现）｜`trimmed`（Hangar 思路：多次随机 + 截尾均值）｜`bayes`（hack-the-back `crowd_bt.py`，MIT 可直接移植）。
**为什么**：S7 §7 自陈「归一化算法……在本赛事场景下的效果未验证」。若把 z-score 写死，首届后发现不合适就要重写聚合层。**做成配置项后，换策略 = 改一份 JSON。**

**【决策】`mean`/`stdev` 增量维护，不在计算时全量重算**：
`score_stats(judge_id, dimension, n, mean, sum_sq)` 表在每次打分提交时更新，`stdev` 由 `sum_sq` 现算。
**为什么**：CTFd 的做法是 60 秒 memoize + 事件驱动 `clear_standings()`；我们的 z-score 需要每个评委×每个维度的统计量，若每次发榜都全表重算，成本随评委数与队伍数**相乘**增长。数据量虽小，但**架构上留成增量的**，避免首届数据量上来后被迫重构。
**但**：**每次发榜仍做一次全量重算并落快照**——因为"可复算"要求榜单能从原始数据重放，增量统计只用于加速与展示。

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

**【决策】第 6 条用「行 ID 兜底」而不是时间戳兜底**。
借自 CTFd 的破同分写法：`ORDER BY score DESC, date ASC, id ASC` —— 同分先到者胜，**并用行 ID 兜底**。CTFd 的注释写明了原因：**不同数据库的时间精度不同**，只用一个时间字段会不稳。我们把 `date` 换成「该维度首次达到该分的时间戳」，`id` 换成打分记录的自增 ID，**双保险都保留**。

**【决策】加时陈述用独立表 + 唯一约束**。
`tiebreak_round`（同分组 + 陈述截止时间）+ `tiebreak_votes`（`PRIMARY KEY(tiebreak_round_id, voter_id, team_id)`）。
**为什么用唯一约束而不是应用层判断**：一人一票必须由数据库保证。应用层的"先查再插"在并发下会插出两票——**这正是我们项目自己的教训 5「静默的空产出比报错更危险」的同构版本**。

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
| `visibility.json` | 分层公开规则 | 读时过滤（不需重算数据）；改文件需重启服务 |
| `registration-scoring.json` | SABC 3 维权重、阈值、等级映射 | 改后需重算报名分级 |
| `solvability.json` | 六维权重、A/B/C/D 分级、一票否决项 | 改后需重算任务卡分级 |
| `milestones.default.json` | 默认里程碑清单模板 | 影响新报名队 |
| `team-formation.json` | 组队人数上下限、组长资格、任务包配额 | 改后只影响**之后**的组队动作（已有战队不变） |
| `schedule.json` | 5 个赛段时间轴、晋级率与决赛 TOP32 | 改后需重算赛段 |
| `points.json` | 名次积分、MVP、个人积分口径、奖金配比 | 改后需重算积分与榜单 |
| `criteria.json` | 段位附加条件、MVP 决胜链、行为证据要求、企业合规 | 改后需重算段位与 MVP |
| `pools.json` | 三池派生、公开 token、任务领取方式 | 改后需重算池与公开榜 |
| `compliance.json` | IP 归属、合规红线、同意记录 | 改后需重算报名与任务卡 |
| `audit.json` | 限频三层、防作弊检测、留存期、复核状态 | 改后需重算审计判定 |

> ⚠️ **规则只在进程启动时加载一次**（`platform/src/server.js` 的 `loadRules(rulesDir)`，无热重载）⇒ **改任何一份 `rules/*.json` 都必须重启服务**才生效。
> 「变更影响」一列说的是**除重启之外**还要做什么（要不要重算、重算哪一块）—— 可见性那一行的「读时过滤」指的是**机制**（在读时过滤、不是写时物化），不是「不用重启」。

**【决策】配置校验 fail-fast**：加载配置时校验权重合计 = 100%、阈值单调、段位门槛递增。**任一不满足则拒绝启动并报错**，不降级为默认值。
> 这条直接防住【冲突】C-01 类错误：若有人把初赛 `w_E` 改成 20%，配置校验会在启动时就失败，而不是安静地算出一个错位的榜单。

---

## 7. 权限模型

**角色**：`admin`（组委会）｜`captain`（队长）｜`member`（组员）｜`judge`（评委席）｜`enterprise`（企业席）｜`observer`（观察员，**无投票权**）｜`enterprise_admin`（企业管理员）

### 7.1 【决策】权限不靠角色枚举，靠「能力 + 授权记录」

```
capability        能力点字符串：task_package:read / score:write / team:manage / signoff:create …
role_capability   (role_id, capability)                       ← RBAC 部分（角色 → 能力）
assignment        (user_id, capability, scope_type, scope_id) ← 资源级 / 行级部分
scope_type ∈ {global, edition, city, task_package, team, enterprise}
```

**判定只有一个入口**：
```
can(user, capability, ctx) →
  1. user.is_superadmin                             → true
  2. role_capability 命中该能力                      → true
  3. assignment 中存在该用户该能力且 scope 匹配 ctx    → true
  4. 否则 → false
```

**为什么不用「角色 + 直接枚举」**：企业席评委"只能评自己出的题"这条规则，用 if 写会散落在每一个 handler 里；用 assignment 表写就是**一行数据**：
`assignment(user_id='judge_u42', capability='score:write', scope_type='task_package', scope_id='tp_7')`。
加一条授权 = INSERT，撤销 = DELETE，审计 = 查这张表。**规则变了不用改代码。**

**落库形态**：⛔ 不要在 SQL 里存 scope_id 数组；用独立 `assignment` 表。

### 7.2 【决策】四条工程硬约束（这才是省事的关键）

| # | 约束 | 为什么 |
|---|---|---|
| 1 | **所有 SQL 收进 repository 层**，handler 里禁止裸 SQL | 否则换库和加权限都要翻遍代码 |
| 2 | **权限过滤必须生成到 WHERE 子句**，不能"先查全量再在 JS 里 filter" | 否则 `GET /api/score/123` 会绕过列表过滤导致越权 |
| 3 | **每个查询强制传 `scopeCtx`**，repository 方法内部自动拼 scope 谓词 | 写错一处就是越权 |
| 4 | **行级权限模板统一为 EXISTS 子查询** | 跨表 join 授权（评委↔任务包↔战队）一次写对 |

```sql
WHERE EXISTS (SELECT 1 FROM assignment a
  WHERE a.user_id = ? AND a.capability = 'task_package:read'
    AND ( (a.scope_type = 'global')
       OR (a.scope_type = 'task_package' AND a.scope_id = tp.id)
       OR (a.scope_type = 'team'       AND a.scope_id = tp.team_id) ))
```

### 7.3 【决策】三态状态码，不泄露资源存在性

| 情形 | 返回 | 理由 |
|---|---|---|
| 列表查询，权限不满足 | **200 + 空集** | 不暴露"有但不给看" |
| 单条读取，权限不满足 | **404** | 不泄露该记录是否存在（比 403 更安全） |
| 规则本身被禁用 | 403 | 这是"机制没开"，不是"你没权限" |

> 借自 PocketBase 的 Collection API Rules 设计：**同一条规则同时承担授权与数据过滤**（它不是布尔开关，是过滤表达式），且三态语义被明确区分。这比"先查出来再过滤"的常见写法更安全，也更省心。

### 7.4 关键行级规则

| 规则 | 实现 |
|---|---|
| 企业席只能评本企业出的题（R1） | 计算时校验 `team.task_package.enterprise_id === judge.enterprise_id`，否则该队企业确认项权重置 0 |
| 观察员无投票权 | 提交评分接口拒绝 `observer`；读接口允许 |
| 回避（R5） | 评分前校验评委是否为该作品的供应方/投资方/前雇主；回避记录写 `audit_log` |
| D 段不公示排名 | 榜单 API 按 §6.6 过滤；本人可见自身进度 |
| B 榜签字人不公开 | 战绩卡接口只返回里程碑达成状态，不返回签字人与评分 |
| 企业评委合计权重 ≤25%（R3） | 计算时封顶 |
| 组委会可查全部审计 | `admin` 读 `computation_snapshots` 与 `audit_log` |

### 7.5 认证

| 项 | 做法 |
|---|---|
| 密码 | `node:crypto` `scrypt`（Node 默认 N=16384, r=8, p=1）；每用户独立 16 字节随机 salt；存储格式 `scrypt$N$r$p$<salt_b64>$<hash_b64>`；比对用 `timingSafeEqual` |
| 会话 | 32 字节随机 token；**数据库只存 SHA-256 哈希，不存明文 token**；Cookie `HttpOnly` + `SameSite=Lax` + `Secure`(生产) + `Path=/`；绝对过期 + 滑动续期 |
| 强制下线 | `POST /api/auth/logout-all` 吊销该用户全部 session |
| ⛔ 不做无状态 JWT | 难撤销、难审计、难强制下线。服务端 session 表可撤销、可审计 |
| 预留 | `identity_provider` 表 + OIDC client 模式（企业微信/钉钉/LDAP）。**现在只留接口不实现**——手写 OIDC authorization-code flow 约 150 行，仍可零 npm |

### 7.6 【决策】后台要有「权限预览」

借自 PocketBase Admin Dashboard 的 **API Preview**：编辑一条记录时，实时显示**当前这个用户在这条记录上能看到哪些字段、能不能写、能不能删**。
**为什么必须有**：行级权限最大的调试成本在这里，缺了它，一次权限 bug 要靠翻代码定位。抄这个能省一两天。

---

## 8. API 设计

> ⚠️ **下面是实施后的真实 API 面**（**58 个端点** = router 里注册的 **57** 个
> + **不挂 router** 的 SSE 流 **1** 个），逐条从代码里抽出来的，不是设计期的手写清单。复算：
> `grep -rhoE "router\.add\('[A-Z]+',\s*'[^']+'" platform/src/ | sort -u`
> ⇒ 57 个；SSE 那条在 `src/http/sse.js` 里按路径匹配（见下方「实时」段），
> **不在 `router.add` 的输出里** —— 这是「SSE 不挂 router」的既定决策（它要长期持有连接，
> 不能像普通 handler 那样「写完就结束响应」）。
>
> 变更史：本节原为设计期的 28 个端点；P0–P4 按计划实现，P5 追加了工作流 / 三池 / 公开榜
> （+15）、P4 追加了复核与申诉（+11），P5 Task 5 追加了 iCal 日历订阅（+1），
> P6 补上了 §7.5 早就规格化却一直没实现的**强制下线**，并追加了**改口令**（+2）。
> **逐条需求的落点与验收**见
> [`../requirement-implementation-map.md`](../requirement-implementation-map.md)（机器生成）；
> **跨阶段签名与表结构的唯一事实来源**是
> [`../superpowers/plans/INTERFACES.md`](../superpowers/plans/INTERFACES.md)。

```
健康
  GET    /api/health

认证
  POST   /api/auth/login              {phone,password} → session
  POST   /api/auth/logout
  POST   /api/auth/password           {oldPassword,newPassword} → 改口令（吊销其它设备的会话）
  POST   /api/auth/logout-all         → 强制下线（吊销该用户全部 session）
  GET    /api/me                       → user + roles + scopes

报名与组队
  POST   /api/registrations            提交报名 → 自动算分分级
  GET    /api/registrations            组委会列表
  GET    /api/registrations/:id        组委会看可解释明细
  POST   /api/registrations/:id/level  复核/申诉改级
  GET    /api/registration-criteria    筛选标准（对外透明）
  POST   /api/teams                    建队（认领任务包）
  GET    /api/teams                    队伍列表
  GET    /api/teams/:id                单队详情
  POST   /api/teams/:id/members        加入 / 退出 / 汰换
  PATCH  /api/teams/:id                改队名 / 换任务包
  POST   /api/teams/:id/behavior-events 行为事件（进行为分，**不进总分**）

企业侧
  GET    /api/task-packages            任务卡列表
  POST   /api/task-packages            企业提交任务卡
  POST   /api/task-packages/:id/solvability   六维可解性评估
  POST   /api/task-packages/:id/approve       分级 + 签约类型
  POST   /api/milestones/:id/signoff          企业签字里程碑（客观事实，**不进总分**）
  POST   /api/milestones/:id/signoff/withdraw 撤回签字 → 触发段位降级

评审
  POST   /api/stages/:stageId/reviews       评委批量打分
  GET    /api/stages/:stageId/review-state  评分进度 / 缺谁
  POST   /api/stages/:stageId/calibration   校准打分（不计入）
  POST   /api/stages/:stageId/peer-reviews  互评
  POST   /api/stages/:stageId/self-review    自评测
  POST   /api/stages/:stageId/recusals      回避 / 撤销回避
  POST   /api/stages/:stageId/enterprise-confirmations  企业席主观确认（进总分）
  POST   /api/stages/:stageId/compute       ★ 计算 → 结果 + trace
  GET    /api/stages/:stageId/computations/:computationId  某次计算的可复算快照

榜单
  GET    /api/leaderboard/:stageId?scope=rank|business|personal
  GET    /api/leaderboard/rolling      滚动榜
  GET    /api/leaderboard/tier         段位榜
  GET    /api/teams/:id/performance-card     项目商业战绩卡
  GET    /api/teams/:id/tier                 段位与权益

工作流与三池（P5）
  POST   /api/workflows                 建工作流
  GET    /api/workflows/:id/tasks       任务清单
  POST   /api/workflows/:id/tasks       建任务
  POST   /api/tasks/:id/claim           自主领取（**唯一**入口，无岗位制）
  POST   /api/tasks/:id/release         释放领取
  POST   /api/tasks/:id/complete        完成任务（须给可运行证据，**且不加分**）
  GET    /api/pools/projects            项目池
  GET    /api/pools/talents             人才池
  GET    /api/pools/resources           资源池
  POST   /api/pools/sync                三池同步（幂等）

公开接口（P5，**无需登录**，用 public_tokens 鉴权）
  GET    /api/public/leaderboard        公开榜单（显式过可见性过滤 + 字段白名单）
  GET    /api/public/calendar.ics       赛程日历订阅（iCal，零依赖手写）

审计与复核（P4）
  GET    /api/audit/computations/:id         计算快照（可复算）
  GET    /api/audit/computations/:id/diff    复算 diff
  GET    /api/audit/log                      审计日志
  GET    /api/audit/flags                    异常标记
  POST   /api/audit/flags/:id/resolve        标记处置
  GET    /api/appeals                        申诉列表
  POST   /api/appeals                        发起申诉
  POST   /api/appeals/:id/decide             申诉裁决

实时
  GET    /api/stages/:stageId/events     ★ SSE 实时事件流（**不带 judgeId**）
       ⚠️ 路径**逐赛段**（不是设计期草稿里的 `/api/events`）——
          评审进度是「某个赛段的」，事件流按赛段分流才不用在每个事件里重复带赛段号。
       ⚠️ 这条**不挂 router**（`src/http/sse.js` 按路径匹配）⇒ 上面那个 `router.add`
          复算命令**看不到它** —— 这是既定决策，不是漏实现。

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

### 11.1 防刷分与防串通（调研带回来的可落地组合）

| 目标 | 做法 | 出处 |
|---|---|---|
| 重复提交 / 并发灌分 | 幂等键（`request_id` 唯一）+ 行锁 + 只接受当前分配的那一份 | hack-the-back `judging.py`（MIT） |
| 评委刷分（高频） | 三层限频：滑动窗口计数 + 提交锁 + 每分钟配额；再加**评委级配额**（每人每小时打分次数上限） | CTFd `api/v1/challenges.py`（Apache-2.0） |
| 互评串通 | **同一企业同一时刻只分配一位评委**；评委互相不可见打分；分配记录写日志 | Gavel `preferred_items()` 的 busy 排除（AGPL，**只读思路独立实现**） |
| 串通识别 | 检测"两位评委对全部重叠项目给出完全相同的相对顺序"→ 进人工复核队列 | Gavel 追加式决策日志思路 |
| 评委宽严异常 | 某评委 stddev 异常小/大、与其他评委相关性为负 → **告警但不自动处罚** | 我们自己的 `score_stats` |
| 结束前抢跑（先看榜再改分） | 评分入口在封榜时间后锁定提交；或记录"提交时可见的榜单版本号"用于回溯 | CTFd 的 freeze 时间戳思路 |
| 事后篡改 | 评分**只增不改**；删除 = 软删除；重算走新 `revision`，不覆盖历史 | Gavel 软禁用 + 追加日志 |

**⚠️ 全行业空白**：没有任何一个开源项目做**多账号协同投票检测**。我们至少要做到"同一手机号/同一企业注册的多个账号"可被识别。

### 11.2 人工复核与申诉状态机

```
SUBMITTED ──→ PENDING_REVIEW ──→ CONFIRMED ──→ FINALIZED
                  │                    ↑              ↑
                  ├──→ REJECTED ─(选手申诉)───────────┘
                  └──→ FLAGGED（疑似刷分/串通）→ REJECTED | CONFIRMED
```

| 规则 | 说明 |
|---|---|
| `PENDING_REVIEW` 的分数**对其他评委/企业不可见** | 借自 OpenReview 的 `nonreaders` 思路——防止未定稿的分数外泄影响后续打分 |
| 每次状态迁移写 `audit_log(actor, from_state, to_state, reason, at)` | 状态机必须有完整迁移日志，否则申诉无法复盘 |
| 幂等守卫 | 借自 OpenReview 的"只处理首次 edit"——重复触发不产生二次迁移 |
| 申诉触发 `revision + 1` 重算 | **不覆盖历史**。旧 `revision` 保留，供复盘 |
| 申诉范围 | 企业只能对"已 FINALIZED 且处于低可见档"的条目申诉 |

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
| **配置校验** | 权重合计 ≠100% 必须抛错（防【冲突】C-01 类回归）；阈值单调；段位门槛递增；**权重和校验是我们补上的**（Hangar 上游只校验单个 weight∈[0.1,1]，留了 TODO） |
| **评分引擎** | 已知评委矩阵 → z 值、去极值结果、P/E 加权；`stdev=0` 分支；样本不足 fallback；**归一化策略四选一各自的结果一致性** |
| **分轨断言** | ⭐ **行为分变化不影响总分**（S-3 的自动化保证）；`scoreStage` 入参含行为分时被丢弃 |
| **破同分链** | 构造同分场景，验证链顺序生效；全同分时落到 `team_id` 兜底且结果稳定；**同分先到者胜 + 行 ID 兜底**（CTFd 双保险） |
| **并列名次** | 同分同名次（1224 式），奖金共享总额不变；**回归测试：修正后的 `calculatePoints` 必须是 10/8/5 而非上游的 18/8/3/1** |
| **段位** | 边界：3 项含接入 → A；5 项含业务部门签字 → S；技术部门签字不计入 S |
| **可见性** | D 段不出现在榜单；B 榜响应体不含签字人；观察员不能提交评分；**200+空集 / 404 / 403 三态** |
| **企业约束** | R1 非本赛道权重置 0；R2 缺签计 0；R3 合计封顶 25% |
| **报名分级** | SABC 3 维加权 → 阈值边界（79/80、59/60、39/40） |
| **幂等与并发** | 同一 `request_id` 重复提交只生效一次；一人一票（`tiebreak_votes` 唯一约束）；并发提交不产生双票 |
| **数据层** | 迁移幂等；事务回滚；并发写不产生脏读；**`sqlite.backup()` 产出的备份可独立打开且数据一致** |
| **端到端** | 报名→组队→打分→计算→发榜→战绩卡 全链路（用种子数据） |

**【决策】回归测试要专门盯住"抄来的代码"**。
理由：调研发现上游有 **2 个可复算的 bug**（hibiscus switch 穿透、portal `generalScore` 恒为 0）。**移植的每一段外部代码都必须配一个"我们的预期值"测试**，否则 bug 会被一起搬进来，且没人发现。

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
- `scripts/backup.js`（一致性备份 + 保留策略 + 定时）

**【决策】备份用 `sqlite.backup()` API，不用 `cp`**
SQLite 官方 `backup.html` 列出 cp 方式的三个缺点：备份期间其他写者须等锁释放；不能用于内存库；**复制过程中掉电可能导致备份损坏**。`backup()` 是增量拷贝、源库只在真正读取的瞬间短暂加锁、结果是源库的 bit-wise identical snapshot。**已实测本机可用（Node ≥22.16.0）。**
⚠️ **WAL 模式下只 cp `.db` 不 cp `-wal` 会丢数据**——已提交但未 checkpoint 的事务还在 WAL 文件里。

**【决策】迁移用纯 `.sql` 文件 + `schema_migrations(version, applied_at)` 表，启动时单事务串行执行**
⛔ 不赌原生 `ALTER TABLE` 的能力边界（`DROP COLUMN` 需 3.35+、`RENAME COLUMN` 需 3.25+，而 `node:sqlite` 捆绑的 SQLite 版本未核实）→ **一律"新表 + 迁移"，expand-contract 三步走**（先加新表/新列双写 → 切读 → 确认无流量再清理）。

**【决策】单写者约束写进部署文档**
⛔ **禁止多 Node worker 进程同时写同一个 SQLite 文件**（SQLite 官方：single writer at a time）。这是 `SQLITE_BUSY` 的真正来源。
✅ 扩容只能加**读**（静态资源交给 nginx 直出，几百并发静态请求根本不进 Node 进程）。
⚠️ WAL 要求所有进程**在同一台主机**；**一旦要多机部署，必须换 Postgres，没有第三条路**。

**【决策】nginx 配置要点**
```
proxy_set_header Connection '';  proxy_http_version 1.1;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# SSE 必须关闭缓冲：
proxy_buffering off;  proxy_read_timeout 360s;  add_header X-Accel-Buffering no;
```
审计日志要读真实客户端 IP，所以这两个头必须透传。

**【决策】实时推送用 SSE，不用 WebSocket**
- 量级：几十个用户、每分钟几次更新。CTFd 自己的做法是 **5 分钟轮询**；我们用 SSE + 30–60 秒轮询兜底即可
- SSE 走普通 HTTP，穿透代理/CDN 容易，浏览器 `EventSource` **自带断线重连**
- WebSocket 是"单向推榜单"的过度设计；只有评委工作台需要亚秒级同步（新任务分配、加时倒计时）才值得上
- ⚠️ **HTTP/1.1 同源连接数限制（约 6 条）本轮未从 MDN 原文核实** → 上线前实测

**【决策】报表与大导出走定时任务，不进请求路径**
`node:sqlite` 是**同步 API**，慢查询会阻塞 event loop（官方：All APIs execute synchronously）。全部 SQL 预编译 + 参数化；导出用 `node:zlib` + 系统 `tar`（Mac/Linux/Windows10+ 都有 bsdtar），零 npm。

### 14.3 公网演示版（现在就能拿到的 URL）
前端代码 **100% 复用**，只换数据层：
- `web/api.js` → 真实 HTTP 客户端
- `web/api.demo.js` → `localStorage` 适配器 + `seed/demo-data.json`

**演示版能做什么**：完整走一遍报名 → 打分 → 发榜 → 段位 → 战绩卡的流程，所有规则引擎**在浏览器里真实运行**（不是假数据硬编码的结果）。
**演示版不能做什么**：数据不跨人共享（各自浏览器独立）。这是当前无云主机条件下的客观边界。

> **【兜底】** 正式系统与演示版**共用同一套规则引擎与前端视图**。这意味着演示版演示出来的算法行为，与正式系统一致——不会出现"演示好看，正式不一样"。

---

## 15. 实施路线

| 阶段 | 内容 | 借鉴的零件 | 产出 | 实施状态 |
|---|---|---|---|---|
| **P0 地基** | 仓库骨架、SQLite 封装、迁移机制、配置加载 + 校验、HTTP 路由、认证会话、capability/assignment 权限骨架 | CTFd 破同分双保险；PocketBase 三态语义 | 能登录的空系统；配置改错会启动失败 | ✅ 已落地 |
| **P1 报名与组队** | SABC 算分分级、注册流程、战队与成员、任务卡与六维准入、报名状态机 + 变更审计 | hack-the-back 报名状态机 + `ApplicationStatusHistory`；dribdat `PR_STAGES` | 报名到组队全链路 | ✅ 已落地 |
| **P2 评审引擎** | 评分界面、z-score、去极值、双签、回避、自评检测、互评、**归一化策略可切换** | portal 评审 schema 三件套；Hangar 加权算分；hack-the-back `crowd_bt.py`（备选策略）；ORA rubric 快照思路 | 能真实算分，且换归一化策略不改代码 | ✅ 已落地 |
| **P3 榜单与积分** | 破同分链、加时陈述、A/B/个人榜、段位、行为分、战绩卡、可见性过滤 | hibiscus 并列名次 + 双列（**修 bug**）；CTFd 可见性分档 | 能真实发榜；行为分在 schema 层隔离 | ✅ 已落地 |
| **P4 审计与防作弊** | 计算快照、trace 抽屉、审计日志、复算 diff、限频三层、幂等、复核状态机、扫描闸 | CTFd 限频三层；OpenReview 复核状态机 + 冲突申报 | 榜单可复算；刷分可拦截 | ✅ 已落地 |
| **P5 工作流与三池** | 任务清单与领取、三池底座接口、公开榜单 API + iCal | dribdat 开放 API / iCal | 数据沉淀 | ✅ **已全部落地**（Task 1–6：工作流 / 三池 / 公开榜 + token 鉴权 / iCal 日历导出 / 前端任务清单页） |
| **P6 部署与演示版** | 部署资产、备份恢复、演示版适配器、静态站发布 | —— | 公网 URL + 云主机就绪 | ✅ **Task 1–8 全部落地**（部署资产、备份恢复、扫描闸、种子、适配器、静态站构建、运维手册、端到端与跨平台验收；部署资产经两轮修复 + 独立复核）；⏳ **只差公网发布**（需云主机 + 用户明确确认） |
| **二期** | 组队 MILP 撮合、贝叶斯归一化主用 | dribdat `matching.py`（HiGHS） | — | ⬜ 未开始 |

> **「实施状态」这一列是实况**（2026-10-21）：每个阶段的**缺陷台账 / 变异检验 / 计划块逐字核验**
> 都在各自的计划文档末尾；逐条需求的落点见
> [`../requirement-implementation-map.md`](../requirement-implementation-map.md)。

**排序理由**：
- **P2/P3 是不可替代的核心价值**（S7/S10 的算法只有我们实现了），必须最扎实
- **P3 的行为分分离要在 schema 层做**（hibiscus 的教训：字段分列了，但排序时又相加）——所以 P3 不能等到 P4
- **P4 的限频与幂等不能推后**：刷分一旦发生，榜单的历史就要作废
- **P5 的三池放到后面**，因为它是派生数据
- **P6 的演示版在 P3 完成后即可发布**，不必等全部完工

**【决策】第一天就把这两个零件做成可运行的单元**：
① `crowd_bt.py`（MIT，140 行）——归一化策略的第二条路，早做早知道值不值得
② `calculateRankings.ts`（MIT，修掉 switch 穿透 bug 后）——名次算法
理由：这两个是"看起来最像锦上添花、实际最容易在后面拖住整体"的模块。

---

## 16. 风险与已知边界

| # | 风险 / 边界 | 说明 | 缓解 |
|---|---|---|---|
| 1 | **规则本身待组委会确认** | 60 条机制件级需求未确认 | 全部配置化；配置版本随快照留档 |
| 2 | **【冲突】C-01~C-06 未追认** | 我方文档内部矛盾 | 已在 `rule-decisions.md` 裁决并标注来源；配置可改 |
| 3 | **z-score 可能长期不生效** | 任务包只有 2–3 队，样本 <5 → 走全局回退（C-05） | ① 显式暴露降级状态 ② **归一化策略可切换**（zscore/median/trimmed/bayes）③ 建议专家席跨包评分、每队 ≥3 评委（借 MLH 赛制设计） |
| 4 | **z-score 全行业无先例** | 11 个平台全仓检索零命中 | 这既说明必须自建，也说明必须首届后回测 → 策略可切换 + 记录实际样本量分布 |
| 5 | **企业愿不愿配合签里程碑** | S10 §10 自陈：「这是整个设计成立的前提，但没有证据」 | 平台侧做成"签字成本可配置 + TOP 回访任务" |
| 6 | **公网正式版需云主机** | 当前无云账号/隧道/Docker | 部署资产一次交齐；演示版先上线 |
| 7 | **规则引擎由 AI 实现** | 规则理解可能有偏差 | 每条规则在代码注释里**引用原文定位**；配置校验 + 单元测试双保险；每条规则配一个可追溯的样例用例 |
| 8 | **`node:sqlite` 尚未 2.0 Stable** | Node 22 = Stability 1.1，Node 24 = 1.2 (RC) | 用薄封装隔离 API 变动；已实测所需能力全部可用 |
| 9 | **HTTP/1.1 同源连接限制未核实** | SSE 多连接可能受限 | 上线前实测；若受限改用单连接 + 版本号增量推送 |
| 10 | **未做端到端压测** | 数据量小（~50 人） | 瓶颈在网络；预编译 statement + 静态资源 nginx 直出 |
| 11 | **Windows 上没有零依赖守护方案** | Node 进程不是 Windows 服务 | 组员本地手动起进程；云主机一律 Linux + systemd |
| 12 | **组队 MILP 撮合需 HiGHS** | 违反零依赖 | 移到二期；一期用"自选 + 组队长确认 + 组委会兜底配对" |

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
| **全行业无 z-score / 去极值 / 段位 / 双签 / 匿名 / 回避实现** | 【多源】11 仓源码级全仓关键词检索 + 逐文件精读 | 11（各自独立仓库） | Y（**缺失性结论**：检索面广，但只能证明"这 11 个仓没有"，不能证明"全世界没有"） |
| CTFd 破同分 = 时间 + 行 ID 双保险 | 【官方】源码 + 官方文档站 | 2 | Y |
| CTFd 冻结榜 = 时间戳过滤，管理员看实时榜 | 【官方】源码 + 官方文档站 | 2 | Y |
| SQLite 单写者 / WAL 同主机 / NFS 不可用 / 备份用 backup API | 【官方】sqlite.org 原文 | 1 | Y |
| `node:sqlite` 稳定性 1.1(22)/1.2 RC(24)；`backup()` 需 ≥22.16.0 | 【官方】Node 文档 | 1 | Y |
| Node 22 EOL 2027-04-30；Node 24 EOL 2028-04-30 | 【官方】nodejs/Release schedule.json | 2 | Y |
| **Directus 已改自定义 MSCL；NocoDB 2026-01-09 起改 Sustainable Use License** | 【官方】仓库 LICENSE 原文 | 各 1 | Y（各读原文） |
| **Formbricks MIT 声明指向不存在的路径；`packages/surveys` 按根 LICENSE 应视为 AGPLv3** | 【官方】仓库 LICENSE + 目录清单 404 实测 | 1 | Y |
| **halo 仓库无 LICENSE 文件；OpenHackathon-service 后端无许可证** | 【官方】tarball 清单 + API license=None | 各 2 | Y |
| hibiscus `calculatePoints` switch 穿透 bug；portal `generalScore` 恒为 0 | 【一手源码推导】 | 各 1 | Y（逻辑必然，可复算） |

> ⚠️ **诚实声明**：S7 / S10 / SABC / 顶层文档**全部出自同一团队**，**不构成多方独立互证**。它们是"我们自己的规则"，不是"行业已验证的规则"。凡标 `我方假设` 的条目，实现时必须留可调参数与回测接口。
> ⚠️ **AGPL 提示**：JunctionApp、Hackerspace3、ORA 为 AGPL-3.0。AGPL §13 原文：「**if you modify the Program**, your modified version must prominently offer all users interacting with it remotely … an opportunity to receive the Corresponding Source」。**学习其设计并自写代码不受此限；复制其代码并部署为网络服务则触发开源义务。** 凡拟复用代码的候选，一律只选 MIT/Apache 系。

### 17.2 待补内容

- [x] §3 开源调研回填（4 条轴，28 个候选仓库）
- [ ] 组委会对本设计的确认（尤其 §6.4 破同分链、§6.2 初赛 `w_E`）
- [ ] 截图位（沿用一页纸的 4 张惯例）
- [ ] 脱敏核对：本文档涉及内部项目路径与合作方信息
- [ ] `rules/*.json` 的初版配置（按 §6.7 清单落地，附 `conflictRef` 字段回指 `rule-decisions.md`）

### 17.3 调研中未能验证的事项（不作为结论使用）

| # | 事项 | 状态 |
|---|---|---|
| 1 | Gavel 原始上游 `anishathalye/gavel` 的许可证未核实 | ⚠️ 若要直接搬原始实现必须单独查证。**本设计改用 MIT 版 `hack-the-back/crowd_bt.py`，规避此风险** |
| 2 | HTTP/1.1 同源连接数限制（约 6 条） | ⚠️ 本轮未从 MDN 原文核实 → 上线前实测 |
| 3 | Hasura EE 的许可证条款 | ⚠️ 仓库内 EE LICENSE 路径全部 404，未能结案（不影响本设计，Hasura 已被排除） |
| 4 | Baserow `premium/` 与 `enterprise/` 许可原文 | ⚠️ 仅从根 LICENSE 确认"有独立许可"，未读原文（不影响本设计，已排除） |
| 5 | `node:sqlite` 捆绑的 SQLite 具体版本号 | ⚠️ 未核实 → 因此迁移一律"新表 + 迁移"，不赌 `ALTER TABLE` 能力边界 |
| 6 | `PRAGMA user_version` 作为迁移载体 | ⚠️ 未读 sqlite.org pragma 原文 → 改用 `schema_migrations` 表，更稳妥 |
| 7 | 各候选项目的真实生产使用规模 | ⚠️ 除 dribdat 官方自述外均无第二来源 → **不作为选型依据** |
| 8 | 活跃度数字（stars / open issues） | ⚠️ GitHub API 单次快照，会漂移 → **不作为选型依据** |
| 9 | hibiscus battlepass 是否有段位定义 | ⚠️ grep 只命中图标颜色，未见档位表 → **不能断言"它有段位"** |

---

*本文档随规则变更同步更新。每次发版在 `computation_snapshots` 留 `rule_version`，可回溯"当时用的是哪版规则"。*

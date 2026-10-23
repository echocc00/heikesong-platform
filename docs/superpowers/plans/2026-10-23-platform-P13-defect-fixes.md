# P13 · 审计缺陷全量修复（2026-10-23）

## 0. 一句话

P0–P12 把平台「做出来」了；2026-10-23 的一轮**全量审计**查出 **47 条缺陷**
（Critical 2 / High 18 / Medium 21 / Low 6），其中 **24 条有红灯回归用例**
（28 个 test 声明：27 红 + 1 对照组绿）。
本阶段**把这 47 条全部修完**，然后才以 `0.1.0` 发第一个 release。

> ⛔ **本阶段的硬纪律**（来自项目既有约束，不是新增口味）：
> - **计划是规格 ⇒ 代码块逐字一致**：改既有文件 ⇒ 必须用 `docs/tools/plan-block-sync.mjs`
>   把当前实现**逐字回写**到 **owning 阶段**的计划块（C-RW 必须清零）。
> - **改测试去迁就实现 = 违规**；测试夹具不符合契约时可更新，但**必须保持判别性**（修前仍红）。
> - **变异检验存活必须修**：补判别性场景，**不得改生产代码迁就测试**。
> - **规则集 16 份配置必须同版本**（版本进 `computation_snapshots.rule_version`，
>   被 `recomputeAndDiff` 用来判定「规则版本已变更」⇒ 不升版 ⇒ 规则漂移永远检测不到）。

---

## 1. 背景与口径

### 1.1 审计产物

| 文件 | 用途 | 规模 |
|---|---|---|
| `内部审计报告` | 修复者主文档 | 2040 行 |
| `内部审计报告` | 详版附录（完整代码引用 / 探针输出 / 方法学） | 1572 行 |
| `platform/test/audit-findings.test.js` | 红灯回归用例（审计时点 28 个 test 声明） | — |

> ⛔ **两份报告不进公开仓**（用户决定）⇒ 后续脱敏镜像必须
> `--invert-paths` 一并排除这两个路径。

### 1.2 编号规则

- `F<n>` 是**稳定 ID**：红灯用例名带同一编号，两边靠编号对齐。
- `F39` 是**编号空洞**（报告里没有这一条）⇒ **不得补号、不得复用**。
- 报告 §2 速查表 47 行 / §3 详情节 47 节；每节 5 字段齐全
  （现象 / 根因 / 怎么测出来的 / 修法 / 验收）。

### 1.3 台账

- `docs/deployment.md` §19 是**变更台账**，编号**不重号**。
- 本阶段从 **E170** 起（E167 = 第 1 批、E168 = 第 2 批、E169 = 第 3 批）。
- 不在任何计划块内的文件（新建文件之外的散改）**只记台账**（P6 约定）。

---

## 2. 批次划分（按**根因**聚类，不按编号顺序）

| 批次 | 缺陷 | 根因簇 | 状态 |
|---|---|---|---|
| 第 1 批 | F16 F18 F14 F29 F41 F15 F31 F32 F34 | **越权（角色授权无行级过滤）** + 不可解档位 + URL 解码崩溃 | ✅ `0086ef8` |
| 第 2 批 | F3 F3b F3c F6 F4 | **闸静默失效（假绿）** + CI 只跑 1 道闸 + 限频 profile 生产零引用 | ✅ `275b0fe` |
| 第 3 批 | F5 F5b F13 | **单写者约束只写在 README 上** | ✅ `01d84d3` |
| 第 4 批 | F7 F12 F36 F37 | **发榜 / 状态机**（名次没落库、无结果也能发榜、没人推进 FINALIZED、发榜非原子） | 本文档 |
| 第 5 批 | F10 F19 F38 F35 + **F8** | **检测器单位错配 / 限频被回滚 / 行为分可无限刷 / 浮点分桶 / 事务快照冲突** | 本文档 |
| 第 6 批 | F1 F2 F11 F17 | **错误语义（500 而非 401）** + 前端 / 可见性 | 待办 |
| 第 7 批 | F9 F20–F28 F30 F33 F40 F42 F43–F48 | **其余 23 条**（F30 / F33 / F40 / F42 需**先补判别性用例**） | 待办 |

---

## 3. 根因簇详解

### 3.1 越权簇（第 1 批，F14 F29 F30 F32 F40 F41 F42 F33 共用一个根因）

**根因**：`src/auth/permissions.js` 对**角色授权**不做行级过滤 ——
`INTERFACES.md:22` 明文写着「超管 / role_capability 授权一律不做行级过滤」
⇒ **角色授权全局是项目自己的设计决定，不是缺陷**。

**⇒ 不得改 `can()` 的角色分支。** 越权的正确修法是**三件套**：

1. `isCommitteeActor(db, user)` —— **身份**（是不是组委会）。
2. `canScoped(user, capability, ctx, db)` —— **assignments**（分工范围）。
3. **领域事实** —— `teams.captain_id` / `team_members` / `users.org` / `task_packages.enterprise_id`。

修完 8 条共用根因里修掉的 5 条（F14 F29 F41 F15 F34），
F30 / F33 / F40 / F42 留在第 7 批（需先补判别性用例）。

### 3.2 假绿簇（第 2 批，F3 F3b F3c F6）

**根因**：三个扫描脚本的「主程序判定」用**裸字符串比较**（`__filename.endsWith(...)`）
⇒ 在不同路径下**认不出自己是主程序** ⇒ **静默不跑、退出码 0** ⇒ 假绿。
修法照抄同目录 `scripts/audit-scan.js` 的 `realPathOrSelf` 正范。

**F6（CI）**：`.github/workflows/ci.yml` 原来只跑 1 道闸。
重写后新增 `release-gates` job 跑齐 4 道闸
（`audit-scan.js` / `temp-leak-scan.js` / `bash-var-scan.js` / `dead-service-scan.mjs`），
**三档 Node**（`22.16.0` / `22.x` / `24.x`）；
每道闸加两道护栏：「退出码非 0 ⇒ 报错」+「**输出为空 ⇒ 报错**」。

> ⚠️ **CI 语义坑**：GitHub Actions 默认 shell 是 `bash -eo pipefail`
> ⇒ 命令替换里 grep 无匹配 ⇒ 整条管道非 0 ⇒ `set -e` 当场掐断步骤
> ⇒ **判空前必须 `|| true`**，闸步骤必须 `set +e` 先取 CODE 再判。

### 3.3 单写者簇（第 3 批，F5 F5b F13）

**根因**：单写者约束**只写在 README 上** ⇒ 没有机器强制 ⇒ 两个实例可同时开库。

- **F5**：`src/server.js` 启动**最前面**（**开库之前**）加单写者闸 ——
  读 pid 文件 → `isProcessAlive` 为真 ⇒ 拒绝启动 + 人话报错 + 退出码 1；
  pid 指向**已死**进程 ⇒ 判为崩溃残留、允许接管。
- **F5b**：停服时 server 会删 pid 文件 ⇒ 「服务停了」与「pid 文件没了」**外观相同**
  ⇒ 简单「缺 pid ⇒ fail closed」会让正常恢复永远需要 `--force`。
  ⇒ 扩展端口文件（`app.port` 记**实际**监听端口）+ **主动探测 `/api/health`**
  （`src/runtime/service-probe.js`，同步、子进程跑一次 fetch，~40ms、零依赖、跨平台）。
- **F13**：`writePidFile` / `writePortFile` **挪到 listen 成功之后**；
  给 server 加 `'error'` 处理器（人话报错 + 退出码 1）。

> ⚠️ **变异检验的教训**：「写 pid 挪回 listen 之前」这个变异**存活**了
> —— 因为同 DATA_DIR 的第二个实例**被单写者闸提前拦掉**，走不到那段代码。
> ⇒ 按纪律**补判别性场景**（**不同 DATA_DIR、同一端口**的实例 C
> ⇒ 能通过单写者闸 ⇒ 真走到 listen ⇒ 断言它没留下 pid 文件、报错是人话）
> ⇒ 变异随即被杀。

### 3.4 发榜 / 状态机簇（第 4 批，F7 F12 F36 F37）

**已证事实**（本批的修复依据）：

- `stage_results.rank / tied_with / points` 三列 P2 建表时留空、约定「P3 填」，
  P3 **从未填** ⇒ 全仓唯一碰它们的 SQL 是 `resetStageResults` 的 `SET ... = NULL`；
  `listStageResults` 与 `listStageResultsWithTeams` 都 `ORDER BY sr.rank, sr.team_id`
  ⇒ rank 为 NULL 时排序退化成 team_id 序（**低分队排第一**）。
- `stage_results.tied_with` 是 **INTEGER** ⇒ 落「**并列队伍数**」（0/1/2…），
  领域层 `rankTeams` 给的是「并列组里**除自己外**的队 id 数组」。
- `fileAppeal` 查的状态是 **`subjectType='stage_result'` + `subjectId=stageId`（按赛段，不按队伍）**。
- `REVIEW_TRANSITIONS` 允许 `CONFIRMED → FINALIZED`，
  但修复前全仓**无任何生产点**（仅 `decideAppeal` 内两处 `from:'FINALIZED'` 在消费）。
- `buildStageRanking` **不读** `stage_results.rank/points` ⇒ 回写名次**不改变排名计算** ⇒ 幂等性不受影响。

**修法**：

| 缺陷 | 修法 |
|---|---|
| **F7** | `src/db/repo/leaderboard.js` 新增 `updateStageResultRanking`（回写 `rank`/`tied_with`/`points`）；`publishLeaderboard` 发榜时回写名次 |
| **F12** | `publishLeaderboard` 加前置检查 —— 判据用「**`stage_results` 非空**」而不是「有计算快照」（重算中途失败时旧快照还在、结果已清空 ⇒ 只看快照会放行**空榜**）；无结果 ⇒ `409 STAGE_NOT_COMPUTED` |
| **F36** | **新增 `src/services/review-state-core.js`**（状态机内核：迁移表 + `transition` + `monotonicAt` + `finalizeStageResult`）；`review-state.js` 改为 import + 再导出（**对外 API 不变**）；`finalizeStageResult` 显式写 `SUBMITTED→PENDING_REVIEW→CONFIRMED→FINALIZED`，**含字面量 `to: 'FINALIZED'`**；发榜时随终稿原子写入（状态按**赛段**记：`subjectType='stage_result'` + `subjectId=stageId`） |
| **F37** | `publishLeaderboard` 整体包进 `withTransaction`（`src/db/tx.js`，SAVEPOINT 语义） |

> ⚠️ **架构回归（本批踩到的坑）**：静态 import `review-state.js` 会破坏
> 「**模块可缺失**」契约（路由层 `loadOptionalModule` 动态加载；模块不在 ⇒ 申诉端点 503，
> 但**平台必须照常启动**）⇒ 任何**始终在场**的代码路径**不得静态 import** 它。
> ⇒ 内核必须抽到独立 core 模块。

### 3.5 检测器单位 / 事务回滚 / 频次约束簇（第 5 批，F10 F19 F38 F35 F8）

| 缺陷 | 病根 | 修法要点 |
|---|---|---|
| **F10** | `stage_reviews` 的粒度是「队伍 × 维度」⇒ 一次正常提交写 10 行 ⇒ 拿**行**当「提交事件」喂突发检测器 ⇒ 阈值 5 必然撞穿 ⇒ **正常评审被判刷分** | 检测器的**单位改成「提交动作」**：事件必须带 `actionId`（= `request_id`）；同一个动作只算一次；**没有动作标识的事件不计入**（不猜）并回报 `unidentified`。调用方（`compute.js`）按 `request_id` 归并。告警另带**稳定标识** `findingKey`（不含时间戳）⇒ 重算不再刷屏 |
| **F19** | 限频计数写在**业务事务**里 ⇒ 业务一抛错，`ROLLBACK TO` 把它一起回滚 ⇒ **加个 `requestId` 就能绕过唯一的限频端点** | `src/db/tx.js` 引入**回滚日志**：`durableWrite(db, fn)` 让写入**立即执行**（并发可见、判定原子）**并登记** ⇒ 事务回滚后**重放**一次 ⇒ 计数存活；提交则日志作废（不重复计数） |
| **F38** | 5 个行为事件里只有 1 个有 `once` ⇒ 其余**无上限** ⇒ 40 次 `weekly_progress` = 80 分 > 完赛线 60 ⇒ 且行为分是破同分链倒数第二键 ⇒ **刷分 = 决定名次 = 决定钱** | 每个事件都要有**次数约束**（`once` + 可选 `cadence` 滚动窗口）；领域层执行、写入层**连历史一起算**并显式 409；配置层 **fail-fast**（没有次数约束 ⇒ 拒绝启动） |
| **F35** | 破同分分桶键用 `String(value)` ⇒ `70` 与 `70.00000000000001`（差 1 ULP）被判成两组 ⇒ **不同名次 + 不同积分** | 数值键改成「排序 + 相邻差 ≤ 1e-9 的归同桶」（不用量化取整：大数会丢精度） |
| **F8** | `withTransaction` 用 deferred SAVEPOINT ⇒ 先读快照、后升级为写 ⇒ 撞 `SQLITE_BUSY_SNAPSHOT`(517)，而 **busy_timeout 不覆盖该错误码** ⇒ 0ms 硬失败 | 外层无事务时改用 **`BEGIN IMMEDIATE`**（本仓 `review.js` / `compute.js` 早就是这么做的，注释里写明理由）；517/5/6 归类为**可重试** ⇒ HTTP 层回 **503 + Retry-After** 而不是 500 |

> ⚠️ **F38 的 `maxWeightShare` 为什么落成「机器闸」而不是「运行时截断」**：
> S10 §3.3「行为分占比 ≤10%」与 S10 §3.2「达标线 60」在数学上**互相打架**
> （一次性事件满分 25 分 > 100 分制总分的 10%）⇒ 若按「把行为分截断到 10%」实现，
> 真实数据上「行为分高者排前」这条既有契约会**整体失效**
> ⇒ 本平台把它落地成它**真正**保证的那件事：**行为分从不进入总分** ⇒ 贡献占比恒为 **0 ≤ maxWeightShare**，
> 并用机器闸钉住（一旦有人把行为分加进总分 ⇒ 闸立刻红）。



### 4.1 Task 3 —— 服务存活探测（第 3 批 F5b）

**Step 3: 创建 src/runtime/service-probe.js**

同步探测「服务还在不在应答」—— 停服时 server 会删 pid 文件，
⇒ 「服务停了」与「pid 文件没了」**外观相同** ⇒ 恢复闸需要**主动问一句**。

`platform/src/runtime/service-probe.js`：

```javascript
// src/runtime/service-probe.js — 同步探测「服务还在不在应答」
//
// 为什么需要它（E169 / F5b）：
//   「服务确实停了（正常退出时 server.js 会删掉 pid 文件）」与
//   「服务还在跑、只是 pid 文件没了（被误删 / 被第二个实例覆盖）」——
//   **只看 pid 文件时这两种情况长得一模一样**，
//   而恢复的后果天差地别：
//     · 前者 ⇒ 恢复正是该做的事；
//     · 后者 ⇒ 恢复会把正在被写入的库文件换掉 ⇒ 丢数据 / 库损坏。
//   ⇒ 唯一的分辨证据是「服务还在不在应答」—— 本模块提供它。
//
// ⚠️ 为什么是**同步**的：`scripts/restore.js` 与它的调用方（含既有回归用例）
//    全部是同步的 ⇒ 探测也必须同步。Node 没有同步 HTTP 客户端，
//    ⇒ 用「起一个子进程跑一次 fetch」来实现（零第三方依赖、跨平台、~40ms）。
//
// ⚠️ 为什么探测的是 /api/health 而不是「端口能不能连上」：
//    连得上只能证明「那儿有个东西」，不能证明「那是本平台的服务」；
//    /api/health 会返回 `{ ok: true }` ⇒ 能确认是我们自己的服务。
//    （顺带避免「端口被别的进程占了」造成误判。）
import { spawnSync } from 'node:child_process';
import { readPortFile } from './pidfile.js';

const HOST = '127.0.0.1';

/**
 * 探测数据目录上的服务是否还在应答。
 *
 * @param {string} dataDir 数据目录（端口文件所在处）
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {{ alive: boolean, port: number|null, reason: string }}
 */
export function probeService(dataDir, { timeoutMs = 5000 } = {}) {
  const port = readPortFile(dataDir);
  if (!port) {
    // 没有端口文件 ⇒ 本数据目录上**从未**有服务登记过监听端口 ⇒ 没服务在跑。
    return { alive: false, port: null, reason: '没有端口文件（本数据目录上没有服务登记过监听端口）' };
  }
  const url = `http://${HOST}:${port}/api/health`;
  // 子进程里的脚本：拿到 200 且 body.ok === true 才算「活着」。
  const code = `
    const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(${Math.max(500, timeoutMs - 500)}) });
    const b = await r.json().catch(() => null);
    process.exit(r.ok && b && b.ok === true ? 0 : 1);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.error) {
    // 探测本身失败（起不来子进程 / 超时）⇒ **不能据此断言服务已停**
    // ⇒ 按「活着」处理（保守 fail closed），但要说明是探测失败。
    return { alive: true, port, reason: `探测 ${url} 失败（${res.error.code ?? res.error.message}）—— 拿不到「服务已停」的证据` };
  }
  if (res.status === 0) {
    return { alive: true, port, reason: `探测 ${url} 有应答且 /api/health 返回 ok ⇒ 服务仍在运行` };
  }
  return { alive: false, port, reason: `探测 ${url} 无应答（退出码 ${res.status}）⇒ 服务未在运行` };
}
```

### 4.2 Task 4 —— 状态机内核抽出（第 4 批 F36）

**Step 4: 创建 src/services/review-state-core.js**

`review-state.js` 是**可选模块** ⇒ 内核必须独立，否则「始终在场」的发榜路径
静态依赖它 ⇒ 破坏「模块可缺失」契约（平台起不来）。

`platform/src/services/review-state-core.js`：

```javascript
// src/services/review-state-core.js — 复核状态机的**内核**（迁移表 + 迁移写入 + 终稿推进）
//
// 依据：设计文档 §11.2（人工复核与申诉状态机）
//   SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED
//               ↘ REJECTED ←（选手申诉）──┘
//               ↘ FLAGGED（疑似刷分/串通）→ REJECTED | CONFIRMED
//
// ⚠️ 为什么把内核从 `src/services/review-state.js` 里**抽出来**（E170 / F36）：
//   `review-state.js` 是一个**可选模块** —— 路由层用 `loadOptionalModule` 动态加载它，
//   模块不在时申诉端点回 503 `REVIEW_STATE_UNAVAILABLE`（fail closed），
//   **但整个平台必须照常启动**（见 test/audit-api.test.js 的「终审修正 M-5」活体用例：
//   它删掉副本里的 review-state.js 后，副本的 server.js 仍必须能起来）。
//   ⇒ 而 F36 的修复要求「发榜时生产 FINALIZED」，发榜路径（services/leaderboard.js）
//     **必须**静态依赖这个能力 —— 静态 import 一个可能不存在的模块 ⇒ 整个平台起不来。
//   ⇒ 所以把**状态机内核**（永远存在的那部分）拆到这里：
//     · 本模块：迁移表 + 迁移写入 + 终稿推进 —— 依赖的都是**始终存在**的仓储与工具；
//     · review-state.js：申诉队列 / 报名类申诉 / 档位判定 —— 那才是「可能还没落地」的部分。
//   ⇒ 两边共用**同一份** `transition()` 实现 ⇒ 不会出现「两个写入方各写一套规则」的漂移。
//
// 三条硬规则（与原 review-state.js 文件头一致）：
//   ① PENDING_REVIEW 的分数对其他评委/企业不可见 → 必须在【API 层】过滤，前端隐藏 = 已泄露
//   ② 每次状态迁移写 audit_log(from, to, reason, at) → 否则申诉无法复盘
//   ③ 幂等守卫：重复触发不产生二次迁移
import { findLatestTransition } from '../db/repo/audit-log.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { writeAuditLog } from '../audit/log.js';
import { badRequest, conflict } from '../errors.js';

export const REVIEW_STATES = ['SUBMITTED', 'PENDING_REVIEW', 'CONFIRMED', 'FINALIZED', 'REJECTED', 'FLAGGED'];

// 合法迁移表。REJECTED → PENDING_REVIEW 是"选手申诉后重新复核"；
// FINALIZED → REJECTED 是"申诉成立、撤销终稿"，随后走 revision + 1 重算。
export const REVIEW_TRANSITIONS = {
  SUBMITTED: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['CONFIRMED', 'REJECTED', 'FLAGGED'],
  CONFIRMED: ['FINALIZED'],
  REJECTED: ['PENDING_REVIEW', 'CONFIRMED'],
  FLAGGED: ['REJECTED', 'CONFIRMED'],
  FINALIZED: ['REJECTED'],
};

export function getSubjectState({ db, subjectType, subjectId }) {
  const latest = findLatestTransition(db, subjectType, subjectId);
  if (!latest || !latest.to) return null;
  return latest.to;
}

/**
 * 把迁移时间戳单调化：同一 subject 的相邻迁移必须**严格递增**。
 *
 * ⚠️ 为什么要有这个（2026-10-21 Task 5 实跑发现的 Critical 缺陷）：
 *   「当前状态」的真值来源是 audit_log 里最后一条 `review_state.transition`。
 *   ⚠️ **这条注释里的根因描述已被 P4 终审修正（2026-10-21）** ——
 *   原先写的是「仓储层排序是 `created_at DESC, id DESC`」，**与实际代码不符**：
 *   仓储层 `findLatestTransition` 的破并列键**早已改成 SQLite 隐式 `rowid`**
 *   （P4-13 根因修复，提交 `fba7b6e`；`id` 是 randomUUID()，同毫秒内次序随机）。
 *   当时的缺陷（实测三条迁移共用同一 created_at 时，200 次里有 135 次读到**过期**状态；
 *   `decideAppeal` 连续两次迁移用同一个 now → 约 50% 概率假报 409）因此**已治本**：
 *     · 根因修复：仓储层 `ORDER BY created_at DESC, rowid DESC`；
 *     · 双保险（本函数）：本模块是 `review_state.transition` 的**唯一写入方**，
 *       自己写出去的时间戳严格递增 ⇒ 正常调用根本不会出现并列。
 *   本函数**保留**：① 兼容「同毫秒内多条迁移」的外部写入；② 防止将来有人
 *   把仓储层的 ORDER BY 改回去时，静默退化回随机次序。
 *   只有「时间戳完全相同」时才 +1ms，正常调用**不动**调用方的 now。
 */
function monotonicAt(db, subjectType, subjectId, now) {
  const prev = findLatestTransition(db, subjectType, subjectId);
  if (!prev || !prev.at) return now;
  const prevMs = Date.parse(prev.at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(prevMs) || !Number.isFinite(nowMs)) return now;
  if (nowMs > prevMs) return now;
  return new Date(prevMs + 1).toISOString();
}

/**
 * 状态迁移。三条硬规则见文件头注释。
 * @returns {{ applied: boolean, from: string, to: string, state: string, at: string }}
 */
export function transition({
  db, subjectType, subjectId, from, to, actorId = null, reason,
  idempotencyKey = null, now = new Date().toISOString(),
}) {
  if (!subjectType || !subjectId) throw badRequest('状态迁移必须给 subjectType 与 subjectId');
  if (!REVIEW_STATES.includes(from)) throw badRequest(`未知状态: ${from}`);
  if (!REVIEW_STATES.includes(to)) throw badRequest(`未知状态: ${to}`);

  // 幂等守卫：同一 idempotencyKey 重复触发不产生二次迁移
  if (idempotencyKey) {
    const scope = `review_state:${subjectType}:${subjectId}`;
    const existing = findIdempotency(db, { key: idempotencyKey, scope });
    if (existing) {
      const stored = existing.response_json ? JSON.parse(existing.response_json) : {};
      return { ...stored, applied: false, replayed: true };
    }
  }

  const allowed = REVIEW_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`非法迁移：${from} → ${to}（允许：${allowed.join(' / ') || '无'}）`);
  }

  const current = getSubjectState({ db, subjectType, subjectId }) ?? 'SUBMITTED';
  if (current !== from) {
    throw conflict(`状态冲突：当前是 ${current}，本次声明 ${from}`);
  }

  const at = monotonicAt(db, subjectType, subjectId, now);
  writeAuditLog(db, {
    actorId,
    action: 'review_state.transition',
    entity: subjectType,
    entityId: subjectId,
    detail: { from, to, reason, at, idempotencyKey },
    now: at,
  });

  const result = { applied: true, from, to, state: to, at, replayed: false };

  if (idempotencyKey) {
    const scope = `review_state:${subjectType}:${subjectId}`;
    insertIdempotency(db, {
      key: idempotencyKey,
      scope,
      requestId: idempotencyKey,
      response: result,
      now: at,
    });
  }

  return result;
}

/**
 * 把**赛段结果**的复核状态推进到 FINALIZED（E170 / F36）。
 *
 * ⚠️ 为什么必须有这个函数（缺陷 F36）：
 *   `fileAppeal` 要求赛段结果处于 FINALIZED 才受理申诉，而
 *   `REVIEW_TRANSITIONS` 里 `CONFIRMED → FINALIZED` 本来是允许的 ——
 *   但**全仓没有任何一处生产它**：仅有的两处 `transition()` 调用都在 `decideAppeal` 内部，
 *   且都是 `from: 'FINALIZED'`（**消费** FINALIZED，不**生产**它）⇒ 状态机是个闭环
 *   ⇒ 「提交申诉 → 裁决 → 撤销终稿 → 重算」这条链在生产上**完全不可达**。
 *   ⇒ 终稿落库（发榜）时必须把这条迁移写出来。
 *
 * ⚠️ 状态是**按赛段**记的（subjectType='stage_result' + subjectId=stageId），
 *   不是按队伍 —— 与 `fileAppeal` / `filterVisibleScores` 的取法**完全一致**（见那两处）。
 *
 * ⚠️ 迁移是**显式写死**每一步的（而不是「沿转移表自动找路径」）：
 *   ① 每一步都能在 `REVIEW_TRANSITIONS` 里查到（自动找路径会把「REJECTED → PENDING_REVIEW
 *      还是 REJECTED → CONFIRMED」这种选择变成隐式约定）；
 *   ② 「谁在生产 FINALIZED」在源码里**一眼可见**（审计的 F36 就是查这个字面量）。
 *
 * @returns {{ applied: object[], state: string }} 已生效的迁移与最终状态
 */
export function finalizeStageResult({
  db, stageId, actorId = null, reason = '发榜终稿', now = new Date().toISOString(),
}) {
  const subjectType = 'stage_result';
  const subjectId = String(stageId);
  const applied = [];
  let current = getSubjectState({ db, subjectType, subjectId }) ?? 'SUBMITTED';

  const step = (from, to) => {
    applied.push(transition({ db, subjectType, subjectId, from, to, actorId, reason, now }));
    current = to;
  };

  // ① 进入复核（首次发榜：SUBMITTED → PENDING_REVIEW；申诉被裁决成立并撤销终稿后：
  //    REJECTED → PENDING_REVIEW ⇒ 重新进入复核）
  if (current === 'SUBMITTED') step('SUBMITTED', 'PENDING_REVIEW');
  if (current === 'REJECTED') step('REJECTED', 'PENDING_REVIEW');
  // ② 复核通过 ⇒ CONFIRMED（FLAGGED 是「有冲突待裁决」，裁决通过后走 CONFIRMED）
  if (current === 'PENDING_REVIEW') step('PENDING_REVIEW', 'CONFIRMED');
  if (current === 'FLAGGED') step('FLAGGED', 'CONFIRMED');
  // ③ 终稿落库 ⇒ FINALIZED（**这一条就是 F36 指认的、此前根本不存在的生产者**）
  if (current === 'CONFIRMED') {
    applied.push(transition({
      db,
      subjectType,
      subjectId,
      from: 'CONFIRMED',
      to: 'FINALIZED',
      actorId,
      reason,
      now,
    }));
    current = 'FINALIZED';
  }
  return { applied, state: current };
}
```

### 4.3 Task 5 —— 审计回归用例全集

**Step 5: 新建 platform/test/audit-findings.test.js**

红灯用例 + 逐批补的运行时判别性用例。

`platform/test/audit-findings.test.js`：

```javascript
// platform/test/audit-findings.test.js — 本次系统性测试新增的回归用例
//
// 覆盖 2026-10-23 全量审计确认的 4 个缺陷（每个都是**先复现、后修复**）：
//   F1  POST /api/stages/:stageId/enterprise-confirmations 未登录 ⇒ 500（应为 401）
//       review.js:304 在鉴权前解引用 ctx.user.id
//   F2  POST /api/workflows 传入不存在的 editionId/taskPackageId ⇒ 500（应为 404）
//       外键原文漏到 HTTP 层（与 server.js「三态状态码」契约冲突）
//   F3  scripts/build-demo.js / bash-var-scan.js / temp-leak-scan.js 的主程序判定
//       用裸字符串比较 ⇒ 经软链调用时**静默不跑、退出码 0**（E166 同款病根，
//       audit-scan.js 已用 realpath 修好，这三个没修）
//   F4  rules/audit.json 里的 reviewSubmit / judgeHourly 两个限频 profile
//       **从未被任何生产代码引用** ⇒ 评审提交无限频
//
// ⚠️ 用例全部走**真实调用链**（起 HTTP 服务 / 跑真脚本），不做「直接调函数」的假验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertUserRole, insertRole } from '../src/db/repo/roles.js';
import { insertRoleCapability, insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');
const webDir = join(platformDir, 'web');
const scriptsDir = join(platformDir, 'scripts');

// ── 起一个真服务器 ────────────────────────────────────────────────
async function withServer(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-find-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, db });
  } finally {
    await new Promise((r) => server.close(r));
    close();
  }
}

async function call(base, method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // ⚠️ headers 一并返回：限频用例要验 429 的 **Retry-After** 头（不静默丢包）。
  const out = {};
  res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return { status: res.status, text, headers: out };
}

// ══════════════════════════════════════════════════════════════════
// F1：未登录访问企业确认写端点 ⇒ 500，不是 401
// ══════════════════════════════════════════════════════════════════
test('F1 未登录 POST 企业确认端点必须返回 401，不得 500', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'POST', '/api/stages/any-stage/enterprise-confirmations', {
      body: { teamId: 't1', dimension: 'enterprise', rawScore: 80, content: 'x' },
    });
    // 修复前：ctx.user.id 在鉴权前解引用 ⇒ TypeError ⇒ 500
    assert.equal(r.status, 401, `未登录必须是 401，实际 ${r.status}：${r.text}`);
    assert.match(r.text, /UNAUTHENTICATED/);
  });
});

test('F1b 未登录访问其它写端点也是 401（对照组：不是全局都 500）', async () => {
  await withServer(async ({ base }) => {
    const paths = [
      '/api/stages/s/reviews',
      '/api/stages/s/calibration',
      '/api/stages/s/peer-reviews',
      '/api/stages/s/self-review',
      '/api/stages/s/recusals',
      '/api/stages/s/compute',
      '/api/stages/s/publish',
      '/api/appeals',
      '/api/workflows',
      '/api/teams',
    ];
    for (const p of paths) {
      const r = await call(base, 'POST', p, { body: {} });
      assert.notEqual(r.status, 500, `${p} 未登录返回了 500：${r.text}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// F2：外键原文漏到 HTTP 层 ⇒ 500（应为 404 / 400）
// ══════════════════════════════════════════════════════════════════
test('F2 建工作流时传入不存在的 editionId 不得返回 500', async () => {
  await withServer(async ({ base, db }) => {
    // 建一个超管用户 + 会话
    insertCapability(db, 'task_package:read', 'x');
    insertRole(db, 'admin', '组委会');
    insertRoleCapability(db, 'admin', 'task_package:read');
    const u = createUser(db, { name: 'A', phone: '13900000091', password: 'pw' });
    insertUserRole(db, u.id, 'admin');
    setSuperadmin(db, u.id);
    const { token } = createSession(db, u.id);

    const r = await call(base, 'POST', '/api/workflows', {
      cookie: `hk_session=${token}`,
      body: { editionId: 'no-such-edition', taskPackageId: 'no-such-package', name: 'W' },
    });
    // 修复前：FOREIGN KEY constraint failed ⇒ 500（外键原文漏到 HTTP 层）
    assert.notEqual(r.status, 500, `外键错误漏成 500：${r.text}`);
    assert.ok(r.status === 404 || r.status === 400, `期望 404/400，实际 ${r.status}：${r.text}`);
    // 且响应体绝不能含 SQLite 原文
    assert.doesNotMatch(r.text, /FOREIGN KEY constraint failed/i);
  });
});

// ══════════════════════════════════════════════════════════════════
// F3：脚本经软链调用时静默不跑（E166 同款病根）
// ══════════════════════════════════════════════════════════════════
test('F3 build-demo.js 经软链调用必须真的构建（不能静默退出 0）', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'hks-demo-'));
  const link = join(outDir, 'build-link.js');
  symlinkSync(join(scriptsDir, 'build-demo.js'), link);
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [link, '--out', outDir], { encoding: 'utf8' });
  // 修复前：isMain 判定为 false ⇒ 什么都不做、退出码 0、产物为空
  assert.ok(
    existsSync(join(outDir, 'index.html')),
    `build-demo.js 经软链调用没有产出 index.html（静默假绿）。stdout=${res.stdout} stderr=${res.stderr}`,
  );
});

test('F3b bash-var-scan.js 经软链调用必须真的扫描（不能静默退出 0）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-bv-'));
  const link = join(dir, 'bv-link.js');
  symlinkSync(join(scriptsDir, 'bash-var-scan.js'), link);
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  // 修复前：无任何输出、退出码 0（闸静默失效 = 假绿）
  assert.match(
    res.stdout + res.stderr,
    /bash-var-scan/,
    `bash-var-scan.js 经软链调用没有任何输出（闸静默失效 = 假绿）。stdout=${res.stdout}`,
  );
});

test('F3c temp-leak-scan.js 在含空格的路径下必须真的扫描', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hks-tl-'));
  const spaced = join(dir, 'with space');
  mkdirSync(spaced, { recursive: true });
  const copy = join(spaced, 'temp-leak-scan.js');
  writeFileSync(copy, readFileSync(join(scriptsDir, 'temp-leak-scan.js'), 'utf8'));
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [copy], { encoding: 'utf8' });
  // 修复前：import.meta.url 含 %20 而 argv[1] 含空格 ⇒ 主程序判定为 false ⇒ 静默不跑
  assert.match(
    res.stdout + res.stderr,
    /temp-leak-scan/,
    `temp-leak-scan.js 在含空格路径下没有任何输出（闸静默失效 = 假绿）。stdout=${res.stdout}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F5：单写者约束（README 的头号架构承诺）在启动时**没有任何强制**
// ══════════════════════════════════════════════════════════════════
test('F5 同一 DATA_DIR 起第二个实例必须被拒绝（单写者约束）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-writer-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  close();

  const { spawn } = await import('node:child_process');
  const start = (port) => spawn(process.execPath, [join(platformDir, 'src/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const a = start(19301);
  let aOut = '';
  a.stdout.on('data', d => { aOut += d; });
  a.stderr.on('data', d => { aOut += d; });
  await new Promise(r => setTimeout(r, 2500));

  const b = start(19302);
  let bOut = '';
  b.stdout.on('data', d => { bOut += d; });
  b.stderr.on('data', d => { bOut += d; });
  await new Promise(r => setTimeout(r, 2500));

  try {
    // 修复前：第二个实例照常启动（B 与 A 共用同一个库文件）
    assert.ok(
      b.exitCode !== null || /已在运行|拒绝|refus|already/i.test(bOut),
      `同一 DATA_DIR 起第二个实例没有被拒绝（单写者约束失效）。B 输出：${bOut.trim().slice(0, 200)}`,
    );
  } finally {
    a.kill('SIGTERM');
    b.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
});

test('F5b pid 文件缺失但服务还在跑时，恢复闸必须判为「还在跑」（fail closed）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-guard-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  close();

  const { spawn } = await import('node:child_process');
  const { checkServiceState } = await import('../scripts/restore.js');
  const proc = spawn(process.execPath, [join(platformDir, 'src/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '19303' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise(r => setTimeout(r, 2500));

  try {
    // 正常态：pid 文件在 → 必须判为 running
    assert.equal(checkServiceState({ dataDir }).running, true, 'pid 文件在时必须判为还在跑');

    // 异常态：pid 文件没了（第二个实例覆盖后删掉 / 被误删 / 残留清理）
    //   而服务**还在跑** —— 恢复闸必须 fail closed（拒绝恢复）
    const pidFile = join(dataDir, 'app.pid');
    if (existsSync(pidFile)) rmSync(pidFile);
    const health = await fetch('http://127.0.0.1:19303/api/health');
    assert.equal(health.status, 200, '前提：服务确实还在跑');
    // 修复前：判为 running=false ⇒ 允许恢复 ⇒ 恢复时服务正在写被替换的库
    assert.equal(
      checkServiceState({ dataDir }).running, true,
      'pid 文件缺失但服务还在跑时，恢复闸必须 fail closed（判为还在跑）',
    );
  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
});

// ══════════════════════════════════════════════════════════════════
// F7：stage_results.rank / points / tied_with **从来没有被写入过**
//     ⇒ 公开榜单接口返回 rank:null，且排序退化成 team_id 序（低分队排第一）
// ══════════════════════════════════════════════════════════════════
test('F7 发榜后公开榜单必须带有名次与积分（stage_results.rank/points 不得为 NULL）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  db.exec(`INSERT INTO users (id,name,phone,password_hash,mba_status,org,is_superadmin,active,created_at) VALUES ('u1','U','13800000001','x','mba',NULL,1,1,'${now}')`);
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
  // 队伍 id 的字典序与分数序【相反】：tm_aaa 低分、tm_zzz 高分
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_aaa','ed1','低分队','u1','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_zzz','ed1','高分队','u1','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s1','st1','tm_aaa','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s2','st1','tm_zzz','${now}')`);
  db.exec(`INSERT INTO stage_judges (stage_id,user_id,seat,scope_type,scope_id,assigned_at) VALUES ('st1','u1','judge','global',NULL,'${now}')`);
  for (const [team, score] of [['tm_aaa', 20], ['tm_zzz', 90]]) {
    for (const dim of ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']) {
      db.prepare(`INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,request_id,calibrated,submitted_at) VALUES (?,?,?,?,?,?,?,0,?)`)
        .run(`r_${team}_${dim}`, 'st1', 'u1', team, dim, score, `req_${team}_${dim}`, now);
    }
  }

  try {
    const { computeStage } = await import('../src/services/compute.js');
    const { publishLeaderboard } = await import('../src/services/leaderboard.js');
    computeStage({ db, stageId: 'st1', actorId: 'u1', now, rules });
    publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: 'u1', now, rules });

    // ① stage_results 的名次/积分列必须被填上
    const rows = db.prepare('SELECT team_id, total, rank, points FROM stage_results WHERE stage_id = ?').all('st1');
    assert.equal(rows.length, 2, '应有 2 行赛段结果');
    for (const r of rows) {
      assert.notEqual(r.rank, null, `stage_results.rank 未被写入（队伍 ${r.team_id}）`);
      assert.notEqual(r.points, null, `stage_results.points 未被写入（队伍 ${r.team_id}）`);
    }

    // ② 公开榜单接口必须给出名次，且高分队排在前面
    db.exec(`UPDATE tier_records SET tier = 'C'`);   // 抬到 C 段，绕过 D 段不公示的规则
    const mod = await import('../src/services/public-api.js');
    const created = mod.createPublicToken({ db, scope: 'all', editionId: 'ed1', expiresAt: null, ttlDays: 7, rules, now });
    const pub = await mod.getPublicLeaderboard({ db, editionId: 'ed1', rules, token: created.token });
    const pubRows = pub.stages[0].rows;
    assert.equal(pubRows.length, 2, '公开榜单应有 2 行');
    for (const r of pubRows) {
      assert.notEqual(r.rank, null, `公开榜单返回了 rank:null（队伍 ${r.teamName}）`);
    }
    assert.ok(
      pubRows[0].total >= pubRows[1].total,
      `公开榜单顺序错乱：第一行 total=${pubRows[0].total} < 第二行 total=${pubRows[1].total}（排序退化成 team_id 序）`,
    );
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F8：src/db/tx.js 用 SAVEPOINT（DEFERRED），WAL 下撞 SQLITE_BUSY_SNAPSHOT(517)
//     且 busy_timeout 不覆盖 517 ⇒ 0ms 硬失败
// ══════════════════════════════════════════════════════════════════
test('F8 withTransaction 在并发写下不得因 517 硬失败（WAL 快照升级）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-wal-'));
  const A = openDatabase({ dataDir });
  const B = openDatabase({ dataDir });
  A.db.exec('CREATE TABLE t (v TEXT)');
  A.db.exec("INSERT INTO t VALUES ('init')");

  const { withTransaction } = await import('../src/db/tx.js');
  let err = null;
  try {
    withTransaction(A.db, () => {
      A.db.prepare('SELECT count(*) AS n FROM t').get();  // 先读 ⇒ 取到快照
      B.db.exec("INSERT INTO t VALUES ('from B')");         // 另一连接提交（WAL 前移）
      A.db.exec("INSERT INTO t VALUES ('from A')");         // 升级写锁 ⇒ 517
    });
  } catch (e) { err = e; }
  A.close(); B.close();

  // 修复前：errcode=517（SQLITE_BUSY_SNAPSHOT），busy_timeout 对它无效
  assert.ok(
    !err || err.errcode !== 517,
    `withTransaction 撞了 SQLITE_BUSY_SNAPSHOT(517)：${err?.errstr ?? ''}（busy_timeout 不覆盖该错误码）`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F10：突发提交检测器把「评分格子」当「提交动作」⇒ 正常评审被误判为刷分
// ══════════════════════════════════════════════════════════════════
test('F10 正常评审（1 评委 2 队 5 维度）不得触发 burst_submit 误报', async () => {
  const { detectBurstSubmission } = await import('../src/domain/anticheat.js');
  const auditCfg = JSON.parse(readFileSync(join(rulesDir, 'audit.json'), 'utf8'));
  const burst = auditCfg.antiCheat.burst;

  // compute.js 喂进去的 events 是 stage_reviews 的每一行（= 每队×每维度一行）
  const now = Date.parse('2026-10-23T10:00:00.000Z');
  const events = [];
  for (let i = 0; i < 10; i++) {           // 1 评委 × 2 队 × 5 维度 = 10 个格子
    events.push({ subjectId: 'u_judge_A', at: new Date(now + i * 1000).toISOString() });
  }
  const r = detectBurstSubmission({ events, windowSeconds: burst.windowSeconds, threshold: burst.threshold });
  // 修复前：flags.length = 1（count 6 > threshold 5）⇒ 正常评审被判为刷分
  assert.equal(
    r.flags.length, 0,
    `正常的 2 队评审被误判为 burst_submit（${JSON.stringify(r.flags)}）—— 检测器的输入应是「提交动作」不是「评分格子」`,
  );
});

// ═══ F8b：517 必须归类为「可重试」（而不是 500 级内部错误）═══
test('F8b SQLite 并发冲突（517/5/6）必须归类为可重试，其它错误不得误判', async () => {
  const { isRetryableDbError } = await import('../src/db/tx.js');
  assert.equal(
    isRetryableDbError({ errcode: 517, code: 'ERR_SQLITE_ERROR', message: 'database is locked' }),
    true, '517（SQLITE_BUSY_SNAPSHOT）必须可重试',
  );
  assert.equal(isRetryableDbError({ errcode: 5 }), true, '5（SQLITE_BUSY）必须可重试');
  assert.equal(isRetryableDbError({ errcode: 6 }), true, '6（SQLITE_LOCKED）必须可重试');
  assert.equal(
    isRetryableDbError({ errcode: 19, message: 'UNIQUE constraint failed' }),
    false, '唯一约束冲突不是并发冲突 ⇒ 不得误判成可重试（否则真错误会被当成「稍后再说」）',
  );
  assert.equal(isRetryableDbError(new Error('普通错误')), false);
});

// ══════════════════════════════════════════════════════════════════
// F11：告警裁剪漏了 errors/stats ⇒ 评委 ID 泄漏给匿名访客
// ══════════════════════════════════════════════════════════════════
test('F11 匿名访客看到的告警里不得含评委 ID', async () => {
  const { checkJudgePool } = await import('../src/domain/judge-pool.js');
  const { applyWarningVisibility } = await import('../src/domain/visibility.js');

  const pool = checkJudgePool({
    judges: [
      { judgeId: 'u_judge_A', seat: 'judge' },
      { judgeId: 'u_judge_A', seat: 'judge' },   // 重复 ⇒ error.message 里带原始 judgeId
      { judgeId: 'u_judge_B', seat: 'judge' },
    ],
    config: {
      votingSeats: ['judge'], nonVotingSeats: ['observer'],
      minJudgesPerDimension: 7, minEnterpriseSeatShare: 0.3, maxExpertSeatShare: 0.6,
    },
  });
  assert.equal(pool.ok, false, '前提：评委池应被判为不合规');

  const warning = {
    code: 'judge_pool_invalid',
    message: `评委池不合规（${pool.errors.length} 项）：${pool.errors.map((e) => e.code).join(', ')}`,
    errors: pool.errors,
    stats: pool.stats,
  };
  // 匿名访客（没有 audit:read）
  const visible = applyWarningVisibility([warning], { canAudit: false });
  const text = JSON.stringify(visible);
  assert.ok(
    !text.includes('u_judge_A') && !text.includes('u_judge_B'),
    `匿名访客的告警里泄漏了评委 ID：${text.slice(0, 300)}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F12：发榜前必须检查「算过没有」⇒ 不能发一个空榜
// ══════════════════════════════════════════════════════════════════
test('F12 没计算过的赛段不得发榜（必须 409 而不是发一个空榜）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-nopub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  db.exec(`INSERT INTO users (id,name,phone,password_hash,mba_status,org,is_superadmin,active,created_at) VALUES ('u1','U','13800000001','x','mba',NULL,1,1,'${now}')`);
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);

  try {
    const { publishLeaderboard } = await import('../src/services/leaderboard.js');
    let err = null;
    try {
      publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: 'u1', now, rules });
    } catch (e) { err = e; }
    assert.ok(err, '没算过的赛段竟然发榜成功了');
    assert.ok(
      err.status === 409 || err.status === 400,
      `期望 409/400（未计算），实际 ${err.status}：${err.message}`,
    );
    // 且不得留下「已发榜」的痕迹
    const snaps = db.prepare('SELECT COUNT(*) AS n FROM leaderboard_snapshots WHERE stage_id = ?').get('st1');
    assert.equal(snaps.n, 0, '未计算的赛段不该留下榜单快照');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F13：启动失败（端口被占）会留下陈旧 pid 文件 ⇒ 恢复闸误判「服务没在跑」
//     （server.js:583 先写 pid 文件，591 才 listen；listen 无 'error' 处理器）
// ══════════════════════════════════════════════════════════════════
test('F13 启动失败（端口被占）不得留下陈旧 pid 文件', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-bind-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  close();

  const { spawn } = await import('node:child_process');
  const pidFile = join(dataDir, 'app.pid');
  const start = (port) => spawn(process.execPath, [join(platformDir, 'src/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const a = start(19411);
  let aOut = '';
  a.stdout.on('data', d => { aOut += d; });
  await new Promise(r => setTimeout(r, 2500));

  try {
    assert.equal(a.exitCode, null, '前提：实例 A 应当已启动');
    const pidA = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : null;
    assert.ok(pidA, '前提：A 应当已写 pid 文件');

    // 实例 B：同一个 DATA_DIR、同一个端口 ⇒ 绑定失败 ⇒ 崩溃
    const b = start(19411);
    let bOut = '';
    b.stdout.on('data', d => { bOut += d; });
    b.stderr.on('data', d => { bOut += d; });
    await new Promise(r => setTimeout(r, 2500));
    assert.notEqual(b.exitCode, null, '前提：B 应当因端口被占而启动失败');

    // 修复前：B 在崩溃前已覆盖写了 pid 文件（写 pid 在 listen 之前），
    //          留下一个指向【已死进程】的陈旧 pid ⇒ 恢复闸判「服务没在跑」
    const pidAfter = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : null;
    assert.ok(
      pidAfter === pidA,
      `启动失败后 pid 文件被覆盖成 ${pidAfter}（原 ${pidA}）—— 陈旧 pid 会让恢复闸误判「服务没在跑」`,
    );

    // 并且恢复闸必须仍然判定「还在跑」（A 还活着）
    const { checkServiceState } = await import('../scripts/restore.js');
    assert.equal(
      checkServiceState({ dataDir }).running, true,
      'A 还活着但恢复闸判成「没在跑」⇒ 恢复会在服务正在写库时进行',
    );

    // ⚠️ 追加场景（E169 变异检验发现的判别性缺口）：
    //    同一个 DATA_DIR 的实例 B 现在会被**单写者闸**提前拦掉 ⇒ 它根本走不到
    //    「写 pid 文件 → listen 失败」那段 ⇒ 上面那条断言已经**不再判别**
    //    （把「写 pid 挪回 listen 之前」这个变异注入进去，本用例如然全绿 ⇒ 变异存活）。
    //    ⇒ 补一条**不同 DATA_DIR、同一端口**的场景：C 能通过单写者闸（它自己的目录
    //    里没有 pid 文件）⇒ 于是真的走到 listen ⇒ 绑定失败 ⇒ 它**不得留下 pid 文件**。
    const dataDir2 = mkdtempSync(join(tmpdir(), 'hks-bind2-'));
    const { db: db2, close: close2 } = openDatabase({ dataDir: dataDir2 });
    applyMigrations(db2, migrationsDir);
    close2();
    const c = spawn(process.execPath, [join(platformDir, 'src/server.js')], {
      env: { ...process.env, DATA_DIR: dataDir2, PORT: '19411' }, // 同一个端口 ⇒ 必然绑定失败
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cOut = '';
    c.stdout.on('data', d => { cOut += d; });
    c.stderr.on('data', d => { cOut += d; });
    await new Promise(r => setTimeout(r, 2500));
    try {
      assert.notEqual(c.exitCode, null, `前提：C 应当因端口被占而启动失败（C 输出：${cOut.slice(0, 200)}）`);
      const pidPath2 = join(dataDir2, 'app.pid');
      const pidC = existsSync(pidPath2) ? readFileSync(pidPath2, 'utf8').trim() : null;
      assert.equal(
        pidC, null,
        `启动失败后留下了陈旧 pid 文件（${pidC}）—— 指向已死进程 ⇒ 恢复闸会误判「服务没在跑」`,
      );
      // 并且失败信息要人话（不是一坨未捕获异常栈）
      assert.match(cOut, /启动失败|EADDRINUSE|地址已使用/, `启动失败必须给出人话报错（C 输出：${cOut.slice(0, 200)}）`);
    } finally {
      c.kill('SIGKILL');
      rmSync(dataDir2, { recursive: true, force: true });
    }
  } finally {
    a.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 600));
  }
});

// ══════════════════════════════════════════════════════════════════
// F14：can() 对【角色授权】不做作用域判定 ⇒ 任意队长能管理【别人的】队伍
// ══════════════════════════════════════════════════════════════════
test('F14 A 队队长不得汰换 B 队成员（跨队越权）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-xt-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  const { insertCapability, insertRoleCapability } = await import('../src/db/repo/capabilities.js');
  const { insertRole, insertUserRole } = await import('../src/db/repo/roles.js');
  for (const [k, d] of [['team:manage', '管理战队成员'], ['team:read', '读取战队']]) insertCapability(db, k, d);
  for (const [k, d] of [['captain', '队长'], ['member', '组员']]) insertRole(db, k, d);
  insertRoleCapability(db, 'captain', 'team:manage');
  insertRoleCapability(db, 'captain', 'team:read');
  insertRoleCapability(db, 'member', 'team:read');

  const capA = createUser(db, { name: 'A队长', phone: '13800000901', password: 'pw', mbaStatus: 'mba' });
  const capB = createUser(db, { name: 'B队长', phone: '13800000902', password: 'pw', mbaStatus: 'mba' });
  const memB = createUser(db, { name: 'B组员', phone: '13800000903', password: 'pw', mbaStatus: 'mba' });
  const spare = createUser(db, { name: '闲人', phone: '13800000904', password: 'pw', mbaStatus: 'mba' });
  insertUserRole(db, capA.id, 'captain');
  insertUserRole(db, capB.id, 'captain');
  insertUserRole(db, memB.id, 'member');

  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_a','ed1','甲队','${capA.id}','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_b','ed1','乙队','${capB.id}','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_a','${capA.id}','captain','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_b','${capB.id}','captain','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_b','${memB.id}','member','${now}')`);
  for (const u of [capA, capB, memB, spare]) {
    db.exec(`INSERT INTO registrations (id,edition_id,user_id,answers_json,dimension_scores_json,raw_score,level,level_final,status,created_at)
             VALUES ('r_${u.id}','ed1','${u.id}','{}','{}',80,'B','B','accepted','${now}')`);
  }

  try {
    const { replaceMember } = await import('../src/services/team.js');
    let err = null;
    try {
      replaceMember({
        db, teamId: 'team_b', outUserId: memB.id, inUserId: spare.id,
        actorId: capA.id, now, rules,
      });
    } catch (e) { err = e; }
    // 修复前：A 队长成功汰换了 B 队的成员（can() 对角色授权不做作用域判定）
    assert.ok(err, 'A 队队长成功汰换了 B 队成员（跨队越权）—— can() 对角色授权未做作用域判定');
    assert.equal(err.status, 403, `期望 403，实际 ${err.status}：${err.message}`);
    // 且 B 队成员没被动过
    const members = db.prepare('SELECT user_id, role FROM team_members WHERE team_id = ? AND left_at IS NULL').all('team_b');
    assert.equal(members.length, 2, 'B 队成员被改动了');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F15：claimTask 不校验任务归属 ⇒ 跨队抢走别人的任务
// ══════════════════════════════════════════════════════════════════
test('F15 A 队不得领取 B 队的任务（跨队抢任务）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-hj-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();

  const capA = createUser(db, { name: 'A队长', phone: '13800000911', password: 'pw', mbaStatus: 'mba' });
  const capB = createUser(db, { name: 'B队长', phone: '13800000912', password: 'pw', mbaStatus: 'mba' });
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_a','ed1','甲队','${capA.id}','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('team_b','ed1','乙队','${capB.id}','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_a','${capA.id}','captain','${now}')`);
  db.exec(`INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ('team_b','${capB.id}','captain','${now}')`);
  db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
           VALUES ('tp_b','ed1',NULL,'某企业','乙队任务包','p','e','a',0,'${capB.id}','published','{}','${now}')`);
  db.exec(`INSERT INTO workflows (id,edition_id,task_package_id,name,created_at) VALUES ('wf_b','ed1','tp_b','乙队工作流','${now}')`);
  db.exec(`INSERT INTO workflow_tasks (id,workflow_id,title,detail,owner_team_id,status,due_at,created_at) VALUES ('wt1','wf_b','乙队的任务','d','team_b','todo',NULL,'${now}')`);

  try {
    const { claimTask } = await import('../src/services/workflow.js');
    let err = null;
    try {
      claimTask({ db, taskId: 'wt1', userId: capA.id, teamId: 'team_a', now });
    } catch (e) { err = e; }
    // 修复前：A 队成功领取 B 队的任务（claimTask 从不校验任务归属）
    assert.ok(err, 'A 队成功领取了 B 队的任务（跨队抢任务）—— claimTask 未校验任务归属');
    assert.equal(err.status, 403, `期望 403，实际 ${err.status}：${err.message}`);
    // B 队的任务状态没被动过
    const t = db.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get('wt1');
    assert.equal(t.status, 'todo', 'B 队的任务状态被改动了');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F16：签级表单在【第一次评估之后】永久失效（packages 投影缺 minScore/maxScore）
// ══════════════════════════════════════════════════════════════════
test('F16 签级表单：评估过一次任务卡后仍必须能签级', async () => {
  const W = join(platformDir, 'web/views/admin-task-packages.js');
  const { solvabilitySpecFromPackages, solvabilitySpecFromRules, gradeTiers } = await import(W);
  const rules = JSON.parse(readFileSync(join(rulesDir, 'solvability.json'), 'utf8'));

  // 评估前：没有任务卡带 explain ⇒ 走规则投影 ⇒ 档位齐
  const before = solvabilitySpecFromPackages([{ id: 'p1', status: 'submitted' }])
    ?? solvabilitySpecFromRules(rules);
  assert.equal(gradeTiers(before).complete, true, '前提：评估前签级档位应就绪');

  // 评估后：那一张卡带上了 meta.solvability.explain **与服务端投影的完整档位定义**
  //   （服务端修复后会把 grades 一并投影进 meta.solvability —— 见 services/taskPackage.js）
  const serverGrades = rules.grades.map((g) => ({
    key: g.key,
    minScore: g.minScore,
    maxScore: g.maxScore,
    commitment: g.commitment ?? '',
    agreement: g.agreement ?? '',
  }));
  const after = solvabilitySpecFromPackages([{
    id: 'p1', status: 'assessed', grade: 'B',
    meta: { solvability: { explain: [
      { dimension: 'capability', label: '能力维度', weight: 0.35, max: 5 },
    ], grades: serverGrades } },
  }]) ?? solvabilitySpecFromRules(rules);
  const tiers = gradeTiers(after);
  // 修复前：前端**不读** meta.solvability.grades ⇒ 投影出的 grades 只有 key、没有 minScore
  //        ⇒ gradeTiers 判定「档位未就绪」⇒ 签级控件整片消失（自锁）
  assert.equal(
    tiers.complete, true,
    '评估过一次任务卡后签级档位就绪状态丢失（packages 投影缺 minScore/maxScore）',
  );
  assert.ok(tiers.approve.length > 0, '签级下拉框没有可选项');

  // ⚛️ 另一半的病根也必须钉住：**视图的取规格路径要规则优先**。
  //    只修投影、不修优先级的话：生产环境不挂 /rules/（只有 DEMO_MODE=1）⇒ 规则投影取不到，
  //    而**旧数据**（修复前评估过的卡）没有 grades ⇒ 包投影残缺 ⇒ 照样「档位未就绪」。
  //    视图里那两个解析器曾**相反**（resolveSolvabilitySpec 规则优先 / load() 包投影优先）。
  const viewSrc = readFileSync(join(webDir, 'views', 'admin-task-packages.js'), 'utf8');
  assert.ok(
    viewSrc.includes('resolveSolvabilitySpec({ packages, rules:'),
    '视图必须走 resolveSolvabilitySpec（规则投影优先）—— 包投影优先会让签级自锁',
  );
  assert.ok(
    !/solvabilitySpecFromPackages\(packages\)\s*\?\?/.test(viewSrc),
    '视图里不得再出现「包投影 ?? 规则投影」这种把残缺规格放在前面的写法',
  );
});

// ══════════════════════════════════════════════════════════════════
// F17：演示站「建队」100% 失败（前端不带 memberIds，演示版按人数下限拒）
//      真实后端却接受同样的 body ⇒ 演示与生产漂移
// ══════════════════════════════════════════════════════════════════
test('F17 演示站建队必须与真实后端同口径（前端不发 memberIds 也能建队）', async () => {
  const { demoTeamFormation } = await import('../web/api.demo.js');
  const rules = JSON.parse(readFileSync(join(rulesDir, 'team-formation.json'), 'utf8'));

  // 前端 web/views/team.js:468-472 发的 body：{ editionId, name, taskPackageId }（无 memberIds）
  const team = {
    id: 'team_demo_1', name: '演示战队', packageId: 'tp_demo_1',
    captainId: 'u_mba_1', memberIds: [], tier: 'D', status: 'forming',
  };
  const state = {
    users: [{ id: 'u_mba_1', mbaStatus: 'mba' }],
    taskPackages: [{ id: 'tp_demo_1' }],
  };
  const formation = demoTeamFormation({ team, state, rules });
  // 修复前：size 0 < min 2 ⇒ 400 TEAM_FORMATION_INVALID（演示站建队按钮 100% 失败）
  assert.equal(
    formation.ok, true,
    `演示站建队被拒：${JSON.stringify(formation.errors)}（真实后端接受同样的 body：队长自动成为首个成员）`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F18：前端路由的畸形百分号编码会抛 URIError ⇒ 整页白屏（后端同类问题已修）
// ══════════════════════════════════════════════════════════════════
test('F18 前端路由遇到畸形百分号编码不得抛异常（白屏）', async () => {
  const { route, match } = await import('../web/router.js');
  route('/review/:stageId', () => {});
  route('/audit/:computationId', () => {});
  route('/tiebreak/:stageId', () => {});
  for (const p of ['/review/%E0%A4%A', '/audit/%', '/review/%zz', '/tiebreak/%']) {
    let err = null;
    try { match(p); } catch (e) { err = e; }
    // 修复前：URIError 抛出，而 app.js 的 match() 在 try 之外 ⇒ 错误卡片永远不渲染 ⇒ 白屏
    assert.equal(err, null, `前端路由对 ${p} 抛了 ${err?.name}：${err?.message}（会白屏）`);
  }
});

// ══════════════════════════════════════════════════════════════════
// F19：限频计数被幂等事务回滚 ⇒ 加个 requestId 就能绕过唯一的限频端点
// ══════════════════════════════════════════════════════════════════
test('F19 幂等事务内的限频计数不得被回滚（否则限频可被 requestId 绕过）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rl-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();

  try {
    const { assertRateLimit } = await import('../src/services/rate-limit.js');
    const { withIdempotency } = await import('../src/services/idempotency.js');
    const limits = rules.audit.rateLimit;
    const subjectKey = 'appeal:u1';

    // 连续 6 次：限频在事务内，业务层随后抛错 ⇒ 计数被 ROLLBACK TO 回滚
    for (let i = 0; i < 6; i++) {
      try {
        withIdempotency({ db, key: `r${i}`, scope: 'appeal:u1', requestId: `r${i}`, now }, () => {
          assertRateLimit({ db, subjectKey, rule: 'appealSubmit', now, limits, subjects: { default: subjectKey } });
          throw new Error('业务层失败');
        });
      } catch { /* expected */ }
    }
    const rows = db.prepare('SELECT COUNT(*) AS n FROM rate_limit_events WHERE subject_key = ?').get(subjectKey);
    // 修复前：0（连 5 秒提交锁那一行都被回滚了）⇒ 限频完全失效
    assert.ok(
      rows.n > 0,
      '限频计数被幂等事务的回滚清空了（连提交锁都没有留下）⇒ 加上 requestId 就能无限绕过限频',
    );
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F6：CI 必须真的跑完 5 道机器闸，且 `RW` 提取为空时要报错（不能按 0 放行）
// ══════════════════════════════════════════════════════════════════
test('F6 CI 必须真跑 5 道机器闸，且 RW 提取为空不得按 0 放行', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  // 1) 5 道闸都必须出现在 CI 里
  const gates = [
    'scripts/audit-scan.js',
    'scripts/temp-leak-scan.js',
    'scripts/bash-var-scan.js',
    'docs/tools/dead-service-scan.mjs',
    'docs/tools/plan-block-audit.mjs',
  ];
  const missing = gates.filter((g) => !ci.includes(g));
  assert.deepEqual(missing, [], `CI 缺少这些机器闸：${missing.join(', ')}`);

  // 2) `RW` 提取为空时不能当成 0 放行 —— 现在是 `${RW:-0}`，提取失败就静默按 0 处理
  const rwLine = ci.split('\n').find((l) => l.includes('RW=') && l.includes(':-0'));
  assert.equal(
    rwLine, undefined,
    `CI 的 RW 提取为空时会按 0 放行（假绿）：${rwLine?.trim()}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F4：rules/audit.json 里的限频 profile 必须真的被生产代码引用
// ══════════════════════════════════════════════════════════════════
test('F4 rules/audit.json 里的每个限频 profile 都必须有生产调用方', async () => {
  const auditCfg = JSON.parse(readFileSync(join(rulesDir, 'audit.json'), 'utf8'));
  const profiles = Object.keys(auditCfg.rateLimit ?? {});
  assert.ok(profiles.length > 0, 'audit.json 应当有至少一个限频 profile');

  // 扫 src/ 下所有生产代码，看每个 profile 名有没有被引用
  const { readdirSync, statSync } = await import('node:fs');
  const srcFiles = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) srcFiles.push(p);
    }
  };
  walk(join(platformDir, 'src'));

  const missing = [];
  for (const name of profiles) {
    const used = srcFiles.some((f) => {
      const t = readFileSync(f, 'utf8');
      return new RegExp(`['"\`]${name}['"\`]`).test(t);
    });
    if (!used) missing.push(name);
  }
  // 修复前：reviewSubmit / judgeHourly 从未被引用 ⇒ 评审提交无限频、评委无每小时配额
  assert.deepEqual(
    missing, [],
    `这些限频 profile 配了却没有任何生产代码引用（配置在说谎）：${missing.join(', ')}`,
  );
});

// ══════════════════════════════════════════════════════════════════
// F4（运行时交叉验证）：静态引用只是「配置不再说谎」，
//   **限频到底有没有真的生效**必须用真实请求证明 ——
//   修复前实测：评委连打 40 次评分 → 状态直方图 { '200': 40 } ⇒ 一个 429 都没有。
// ══════════════════════════════════════════════════════════════════

/**
 * 造一个「能打分」的最小现场：届期 + 出题企业 + 任务包 + 队伍 + 赛段 + 评委。
 * 返回评委的 session cookie 与打分所需的 stageId / teamId。
 * ⚠️ 造**两个**评委：正对照要用（限频必须按评委分 subject，不能一刀切全站皆禁）。
 */
function seedJudgeStage(db) {
  const NOW = '2026-10-23T12:00:00.000Z';
  const edition = createEdition(db, {
    name: '限频现场 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900008801', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900008802', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900008804', password: 'pw' });
  insertCapability(db, 'score:write', '写入评分');
  for (const u of [judge, judge2]) {
    grantAssignment(db, {
      userId: u.id, capability: 'score:write', scopeType: 'global', scopeId: null, grantedBy: enterprise.id,
    });
  }
  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: enterprise.id, now: NOW,
  });
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: judge.id, taskPackageId: pkg.id, status: 'active', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });
  return {
    stageId: stage.id,
    teamId: team.id,
    cookie: `hk_session=${createSession(db, judge.id).token}`,
    cookie2: `hk_session=${createSession(db, judge2.id).token}`,
  };
}

test('F4 评审提交端点必须真的限频（连打必须出现 429，不能全是 200）', async () => {
  const { rules } = loadRules(rulesDir);
  const profile = rules.audit.rateLimit.reviewSubmit;
  const max = profile.sliding.max;
  await withServer(async ({ base, db }) => {
    const { stageId, teamId, cookie, cookie2 } = seedJudgeStage(db);
    const statuses = [];
    let last = null;
    for (let i = 0; i < max + 5; i += 1) {
      const res = await call(base, 'POST', `/api/stages/${stageId}/reviews`, {
        cookie,
        body: { items: [{ teamId, dimension: 'innovation', rawScore: 80 }] },
      });
      statuses.push(res.status);
      last = res;
    }
    // 修复前：40 次连打全部 200（实测「一个 429 都没有 ⇒ 限频根本没生效」）
    assert.ok(
      statuses.includes(429),
      `连打 ${max + 5} 次必须出现 429（限频没生效）：${statuses.join(',')}`,
    );
    assert.equal(
      statuses[max], 429,
      `第 ${max + 1} 次必须被限频（滑动窗口 ${max}/${profile.sliding.seconds}s）：${statuses.join(',')}`,
    );
    assert.equal(JSON.parse(last.text).error.code, 'RATE_LIMITED');
    assert.ok(
      last.headers['retry-after'],
      '429 必须带 Retry-After 头（限频触发要告诉调用方等多久，不静默丢包）',
    );
    // ⛔ 正对照：限频是**按评委**算的（subject = 评委 id）——
    //    别的评委必须照常提交。若这里也 429，说明限频接成了「全局一刀切」。
    const other = await call(base, 'POST', `/api/stages/${stageId}/reviews`, {
      cookie: cookie2,
      body: { items: [{ teamId, dimension: 'innovation', rawScore: 80 }] },
    });
    assert.equal(other.status, 200, `别的评委必须照常提交（限频按评委分 subject）：${other.text}`);
  });
});

test('F4 登录端点必须真的限频（连续错误口令必须出现 429）', async () => {
  const { rules } = loadRules(rulesDir);
  const max = rules.audit.rateLimit.loginAttempt.sliding.max;
  await withServer(async ({ base, db }) => {
    const phone = '13900008803';
    createUser(db, { name: '爆破目标', phone, password: 'right-password' });
    // ⛔ 正对照先跑：**成功**的登录不消耗配额
    //    （否则正常用户多设备/多标签页反复登录会被自己的配额挡住 —— 那是误伤）
    for (let i = 0; i < max + 3; i += 1) {
      const ok = await call(base, 'POST', '/api/auth/login', { body: { phone, password: 'right-password' } });
      assert.equal(ok.status, 200, `第 ${i + 1} 次正确登录必须成功（成功不消耗限频配额）：${ok.text}`);
    }
    const statuses = [];
    let last = null;
    for (let i = 0; i < max + 5; i += 1) {
      const res = await call(base, 'POST', '/api/auth/login', { body: { phone, password: 'wrong-password' } });
      statuses.push(res.status);
      last = res;
    }
    // 修复前：30 次错误口令全部 401、零 429 ⇒ 可无限爆破
    assert.ok(
      statuses.includes(429),
      `连续 ${max + 5} 次错误口令必须出现 429（登录端点完全无限频）：${statuses.join(',')}`,
    );
    assert.equal(
      statuses[max], 429,
      `第 ${max + 1} 次错误口令必须被限频（滑动窗口 ${max}/60s）：${statuses.join(',')}`,
    );
    assert.equal(JSON.parse(last.text).error.code, 'RATE_LIMITED');
    assert.ok(last.headers['retry-after'], '429 必须带 Retry-After 头');
  });
});

// ══════════════════════════════════════════════════════════════════
// 第二批（来自 auth / domain 两路审计）：跨队 / 跨企业 / 跨届期的写权限缺口
//   F31 任务卡提交可冒用任意企业主体（enterpriseId 未校验归属）
//   F34 team_result 申诉无归属校验
//   F35 破同分链用 String(value) 分桶 ⇒ 1 ULP 之差被判为不同名次
//   F36 review_state 的 FINALIZED 没有任何生产者 ⇒ team_result 申诉整条链路是死的
//   F37 publishLeaderboard 无事务
//   F38 行为分可无限刷（weekly_progress 无 once / 无节奏 / 无去重）
// ══════════════════════════════════════════════════════════════════

// ── 第二批用的辅助 ───────────────────────────────────────────────
function freshDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-b2-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close };
}

// 角色 ⇒ 能力点 = 全局授权（这正是 F14/F29 的根因：can() 对角色授权不做作用域判定）
function grantRole(db, roleKey, caps) {
  insertRole(db, roleKey, roleKey);
  for (const c of caps) {
    insertCapability(db, c, c);
    insertRoleCapability(db, roleKey, c);
  }
}

// ═══ F31：任务卡提交可冒用任意企业主体 ═══
test('F31 提交任务卡时 enterpriseId 必须属于提交人，不得冒用他人企业', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const { submitTaskPackage } = await import('../src/services/taskPackage.js');
    const now = new Date().toISOString();
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);

    const entA = createUser(db, { name: '企业A', phone: '13900000001', password: 'pw', mbaStatus: 'other' });
    const entB = createUser(db, { name: '企业B', phone: '13900000002', password: 'pw', mbaStatus: 'other' });
    grantRole(db, 'enterprise', ['task_package:submit']);

    const pkg = submitTaskPackage({
      db, userId: entA.id, rules, now,
      payload: {
        editionId: 'ed1', title: '题', painPoint: '痛点',
        expectedDelivery: '交付', acceptanceCriteria: '验收',
        enterpriseId: entB.id,                 // ← 冒用企业B
        enterpriseName: '企业B',
        consent: { accepted: true },
      },
    });
    // 修复前：enterprise_id 变成 entB.id —— 攻击者替别人挂名
    assert.notEqual(
      pkg.enterpriseId, entB.id,
      `任务卡的 enterprise_id 被写成了别人的企业（${pkg.enterpriseId}）—— 冒用成功`,
    );
  } finally { close(); }
});

// ═══ F34：team_result 申诉无归属校验 ═══
test('F34 对他人队伍的结果提交申诉必须被拒（须校验申诉人属于该队）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const { fileAppeal } = await import('../src/services/review-state.js');
    const now = new Date().toISOString();
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    const capA = createUser(db, { name: 'A队长', phone: '13900000011', password: 'pw', mbaStatus: 'mba' });
    grantRole(db, 'captain', ['appeal:write']);
    insertUserRole(db, capA.id, 'captain');

    let err = null;
    try {
      fileAppeal({
        db, filedBy: capA.id, now, rules,
        subjectType: 'team_result',
        subjectId: 'st1:teamB',       // ← 别人的队伍
        reason: 'ha',
      });
    } catch (e) { err = e; }
    // 修复前：不是 403 —— 要么因状态不对 409，要么直接受理（无归属校验）
    assert.equal(
      err?.status ?? 403, 403,
      `对他人队伍结果申诉未被 403 拒绝（实际：${err?.code ?? '受理成功'} ${err?.message ?? ''}）—— 申诉无归属校验`,
    );
  } finally { close(); }
});

// ═══ F36：review_state 的 FINALIZED 没有任何生产者 ═══
test('F36 review_state 必须有 FINALIZED 的生产者（否则 team_result 申诉整条链路是死的）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const srcDir = join(platformDir, 'src');
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(srcDir);

  // 缺陷的本质：**没有任何代码把 review_state 推进到 FINALIZED**。
  //   转移表里 CONFIRMED → FINALIZED 是允许的，但 src/ 里没有一处 transition({... to: 'FINALIZED' })。
  //   现有的两处 transition() 调用（review-state.js:359/364）都写着 from: 'FINALIZED'，
  //   也就是说它们【消费】FINALIZED，却【不生产】它 —— 状态机是个闭环。
  // ⇒ fileAppeal 对 team_result 永远 409，decideAppeal 的「撤销终稿 → 重算」分支永远不可达。
  const producers = files.filter((f) => {
    const s = readFileSync(f, 'utf8');
    return /to\s*:\s*['"]FINALIZED['"]/.test(s);
  });
  assert.ok(
    producers.length > 0,
    `没有任何代码把 review_state 推进到 FINALIZED（找到的写入方：${producers.join(', ') || '无'}）`
    + ' —— 转移表允许 CONFIRMED → FINALIZED，但 src/ 里没有一处 transition({..., to: \'FINALIZED\' })。'
    + '发布/计算终稿时必须写这条迁移，否则 fileAppeal 对 team_result 永远 409、'
    + 'decideAppeal 的撤销终稿分支永远不可达',
  );
});

// ═══ F36（运行时）：发榜后 team_result 申诉必须真的能被受理 ═══
// ⚠️ 上面那条用例只是**静态扫描**（查源码里有没有 `to: 'FINALIZED'` 字面量）——
//    它能抓住「生产者根本不存在」，但抓不住「生产者写了、却写错了状态/主体/时机」。
//    ⇒ 这里补一条**端到端**用例：真的发一次榜，然后真的去提交一条 team_result 申诉。
test('F36 发榜后对赛段结果提交申诉必须被受理（FINALIZED 的生产者真的在工作）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const now = new Date().toISOString();
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
    const admin = createUser(db, { name: '组委会', phone: '13900000031', password: 'pw' });
    const captain = createUser(db, { name: '一队队长', phone: '13900000032', password: 'pw' });
    insertCapability(db, 'stage:compute', '触发计算发榜');
    grantAssignment(db, {
      userId: admin.id, capability: 'stage:compute', scopeType: 'global', scopeId: null, grantedBy: admin.id,
    });
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm1','ed1','一队','${captain.id}','${now}')`);
    // 赛段结果已算出来（否则 F12 的闸会拦下发榜）
    db.exec(`INSERT INTO stage_results (id,stage_id,team_id,total,seat_p,seat_e,created_at) VALUES ('sr1','st1','tm1',80,80,0,'${now}')`);
    // 档位 D（可申诉档位：rules/audit.json 的 appealAllowedTiers = ['D']）
    db.exec(`INSERT INTO tier_records (id,team_id,tier,milestone_count,business_signoff_count,reasons_json,computed_at) VALUES ('tr1','tm1','D',0,0,'[]','${now}')`);

    const { publishLeaderboard } = await import('../src/services/leaderboard.js');
    const published = publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: admin.id, now, rules });
    assert.equal(published.reviewState, 'FINALIZED', '发榜后赛段结果的复核状态必须是 FINALIZED');

    // 三步迁移都要留痕（可复盘）
    const moves = db.prepare("SELECT detail_json FROM audit_log WHERE action = 'review_state.transition' ORDER BY rowid").all();
    assert.equal(moves.length, 3, `发榜应写 3 条状态迁移（SUBMITTED→PENDING_REVIEW→CONFIRMED→FINALIZED），实际 ${moves.length} 条`);

    // 关键：队长对**本队**的结果提申诉 —— 必须被受理（修复前永远 409「未进入复核」）
    const { fileAppeal } = await import('../src/services/review-state.js');
    const appeal = fileAppeal({
      db, filedBy: captain.id, now, rules,
      subjectType: 'team_result',
      subjectId: 'st1:tm1',
      reason: '名次有异议',
    });
    assert.ok(appeal?.id, `发榜后申诉必须被受理，实际返回：${JSON.stringify(appeal)}`);
  } finally { close(); }
});

// ═══ F10（运行时）：生产路径必须按「提交动作」归并评分行 ═══
// ⚠️ 上面那条用例只测了**检测器**的输入契约；它抓不住「调用方仍然按行喂」。
//    ⇒ 这里走**完整生产路径**：真算一次赛段（computeStage → runDetection → flagged_reviews）。
//       ① 一次正常评审（1 评委 × 2 队 × 5 维度 = 10 行，同一个 request_id）⇒ **不得**有 burst 告警；
//       ② 6 次**真的**的提交（6 个 request_id）⇒ **必须**有 burst 告警（不能把检测改成永远不报）。
test('F10 生产路径必须按「提交动作」归并评分行（一次提交写 10 行 ≠ 10 次提交）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const now = '2026-10-23T10:00:00.000Z';
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
    const judge = createUser(db, { name: '评委甲', phone: '13900000071', password: 'pw' });
    const captain1 = createUser(db, { name: '一队队长', phone: '13900000072', password: 'pw' });
    const captain2 = createUser(db, { name: '二队队长', phone: '13900000073', password: 'pw' });
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm1','ed1','一队','${captain1.id}','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm2','ed1','二队','${captain2.id}','${now}')`);
    assignStageJudge(db, { stageId: 'st1', userId: judge.id, seat: 'judge', now });

    const dims = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];
    const insertReview = (id, team, dim, requestId, at) => db.exec(
      `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
       VALUES ('${id}','st1','${judge.id}','${team}','${dim}',80,'${at}','${requestId}',0)`,
    );

    // ① 一次正常评审：10 行，同一个 request_id
    for (const team of ['tm1', 'tm2']) {
      for (const dim of dims) insertReview(`r_${team}_${dim}`, team, dim, 'req_1', now);
    }
    const { computeStage } = await import('../src/services/compute.js');
    computeStage({ db, stageId: 'st1', actorId: judge.id, now, rules });

    const burst = db.prepare("SELECT id, detail_json FROM flagged_reviews WHERE kind = 'burst_submit'").all();
    assert.equal(
      burst.length, 0,
      `一次正常评审（10 行、同一个 request_id）被误判为刷分：${JSON.stringify(burst).slice(0, 300)}`,
    );

    // ② 6 次真的提交（6 个 request_id）⇒ 必须报得出（不能把检测改成永远不报）
    //    ⚠️ `stage_reviews` 对 (stage_id, judge_id, team_id, dimension) 有唯一约束
    //    ⇒ 同一个评委不能对同一队同一维度重复插 ⇒ 改用**第二位评委**的 6 个格子。
    const judge2 = createUser(db, { name: '评委乙', phone: '13900000074', password: 'pw' });
    assignStageJudge(db, { stageId: 'st1', userId: judge2.id, seat: 'judge', now });
    const combos = [['tm1', 'track_fit'], ['tm1', 'innovation'], ['tm1', 'feasibility'],
      ['tm2', 'track_fit'], ['tm2', 'innovation'], ['tm2', 'feasibility']];
    combos.forEach(([team, dim], i) => {
      const at = new Date(Date.parse(now) + i * 1000).toISOString();
      db.exec(
        `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
         VALUES ('r3_${i}','st1','${judge2.id}','${team}','${dim}',80,'${at}','req_${i}',0)`,
      );
    });
    computeStage({ db, stageId: 'st1', actorId: judge.id, now: '2026-10-23T10:00:10.000Z', rules });
    const burst2 = db.prepare("SELECT id, detail_json FROM flagged_reviews WHERE kind = 'burst_submit'").all();
    assert.equal(burst2.length, 1, '6 次提交必须仍然触发 burst_submit（检测器不能被改成永远不报）');
    const detail = JSON.parse(burst2[0].detail_json);
    assert.equal(detail.subjectId, judge2.id);
    assert.ok(detail.findingKey, '告警必须带稳定标识（不含时间戳）⇒ 重算不再刷屏');

    // ③ 没有 request_id 的行 ⇒ 无法归并成「提交动作」⇒ 不参与检测，且必须**显式告警**（不静默）
    const judge3 = createUser(db, { name: '评委丙', phone: '13900000075', password: 'pw' });
    assignStageJudge(db, { stageId: 'st1', userId: judge3.id, seat: 'judge', now });
    db.exec(
      `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
       VALUES ('r4_0','st1','${judge3.id}','tm1','completeness',80,'${now}',NULL,0)`,
    );
    const out3 = computeStage({ db, stageId: 'st1', actorId: judge.id, now: '2026-10-23T10:00:20.000Z', rules });
    const blind = (out3.warnings ?? []).find((w) => w.code === 'anticheat_burst_blind_spot');
    assert.ok(blind, '没有 request_id 的评分行必须显式告警（这条检测对它是盲区，不许静默）');
  } finally { close(); }
});

// ═══ F35：破同分链用 String(value) 分桶 ═══
test('F35 破同分分桶不得用 String(value) —— 1 ULP 之差会被判为不同名次', async () => {
  const { applyTiebreakChain } = await import('../src/domain/ranking.js');
  const chain = [
    { key: 'total', scope: 'always' },
    { key: 'teamId', scope: 'always', deterministic: true },
  ];
  const data = { byTeam: { A: { total: 70 }, B: { total: 70.00000000000001 } } };
  const candidates = [
    { teamId: 'A', values: { total: 70 } },
    { teamId: 'B', values: { total: 70.00000000000001 } },
  ];
  const out = applyTiebreakChain({ candidates, chain, data });
  const groups = out?.groups ?? out?.tieGroups ?? [];
  assert.ok(
    groups.length === 1,
    `total 差 1 ULP（1.42e-14）被判为不同组：${JSON.stringify(groups)} —— 分桶键用了 String(value)`,
  );
});

// ═══ F37：publishLeaderboard 无事务 ═══
test('F37 publishLeaderboard 必须在一个事务里（否则中途失败留下半成品）', async () => {
  const src = readFileSync(join(platformDir, 'src', 'services', 'leaderboard.js'), 'utf8');
  const fn = src.match(/export function publishLeaderboard[\s\S]{0,4000}/)?.[0] ?? '';
  assert.ok(
    /withTransaction|BEGIN IMMEDIATE|db\.exec\('BEGIN/.test(fn),
    'publishLeaderboard 里没有事务：写快照 → 写档位 → 记积分 → 写审计，任何一步失败都会留下半成品'
    + '（compute.js 已按同一纪律加了事务，publish 路径没有）',
  );
});

// ═══ F38：行为分可无限刷 ═══
test('F38 行为分必须有频次/去重约束（weekly_progress 无 once 且无节奏检查）', async () => {
  const { rules } = loadRules(rulesDir);
  const evs = rules.behavior.events ?? [];
  const repeatable = evs.filter((e) => !e.once);
  assert.ok(
    repeatable.length === 0,
    `这些行为事件没有 once 约束：${repeatable.map((e) => e.key).join(', ')}`
    + ' —— 同一事件可无限提交刷分（weekly_progress×40 = 80 分，完赛线 60）',
  );
  const svc = readFileSync(join(platformDir, 'src', 'services', 'behavior.js'), 'utf8');
  assert.ok(
    /idempot|dedup|duplicate|perWeek|cadence|window/i.test(svc),
    'behavior 写入路径没有任何去重/幂等/周期检查',
  );
});
```

---

## 5. 收尾闸（本阶段交付前必须全绿）

1. **全量测试**：`cd platform && node --test` ⇒ 1993 例全绿
   （审计基线是 `1991 / 1963 pass / 27 fail / 1 skipped`）。
2. **三档 Node**：`22.16.0`（`engines` 最低版本）/ `22.x` / `24.x` ⇒ 结果**逐字一致**。
3. **五道机器闸**：`audit-scan.js` / `temp-leak-scan.js` / `bash-var-scan.js` /
   `dead-service-scan.mjs` / `plan-block-audit.mjs` ⇒ 退出码全 0，
   且 `plan-block-audit` 报 **C-RW = 0**。
4. **变异检验**：每批的每条修法都要有**被杀死的变异**（存活 ⇒ 补判别性场景）。

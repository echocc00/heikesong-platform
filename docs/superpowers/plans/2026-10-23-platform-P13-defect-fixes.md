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
| 第 4 批 | F7 F12 F36 F37 | **发榜 / 状态机**（名次没落库、无结果也能发榜、没人推进 FINALIZED、发榜非原子） | ✅ `db84050` |
| 第 5 批 | F10 F19 F38 F35 + **F8** | **检测器单位错配 / 限频被回滚 / 行为分可无限刷 / 浮点分桶 / 事务快照冲突** | ✅ `1f053d7` |
| 第 6 批 | F1 F2 F11 F17 | **错误语义（500 而非 401）** + 前端 / 可见性 | ✅ `b795b56` |
| 第 7 批 | F30 F40 F42 F33 | **授权 / 归属**（里程碑签字 / 行为事件 / 签级重评 / 池读取的届期隔离） | ✅ `d70dad4` |
| 第 8 批 | F43 F44 F45 F46 | **领域算法**（破同分链序机器闸 / 缺分维度口径 / 去极值阶跃 / 归一化样本数口径） | ✅ `a6fd271` |
| 第 9 批 | F23 F25 F26 | **数据 / 事务**（签字唯一约束 / 幂等键绑定操作 / 复核状态写路径无事务） | ✅ `E175` |
| 第 10 批 | F9 F20 F21 F22 F24 F27 F28 F47 F48 | **HTTP / 前端 / 形状**（安全响应头 / HEAD·OPTIONS·CORS / 401 清会话 / 演示站形状 / 错误语义 / 超管形状 / 死检测） | ✅ `E176` |

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
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http, { createServer } from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser, setSuperadmin, getUserById, toPublicUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertUserRole, insertRole } from '../src/db/repo/roles.js';
import { insertRoleCapability, insertCapability } from '../src/db/repo/capabilities.js';
import { insertPeerReview } from '../src/db/repo/peer-reviews.js';
import { grantAssignment, can, scopeClause } from '../src/auth/permissions.js';
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

// ⚠️ headers 参数（F27/F28 用）：跨源预检要带 Origin / X-Forwarded-Proto 才能测到分支。
//    这是**加参**不是改断言：原有调用方一律不传 headers ⇒ 行为完全不变。
async function call(base, method, path, { body, cookie, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
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

/**
 * 裸 HTTP 请求（不走 fetch）。
 * ⚠️ 为什么需要它：undici 的 fetch **不支持 TRACE 方法**（直接抛
 *    "'TRACE' HTTP method is unsupported."）⇒ F27 的 TRACE 对照组必须走 node:http。
 */
function rawCall(base, method, path) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}` },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, text: body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
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

// ═══ F11（运行时）：匿名访客的榜单响应里不得出现评委 id ═══
// ⚠️ 上面那条用例只测**裁剪函数**本身；它抓不住「告警明细里真的带了评委 id」。
//    ⇒ 这里走完整路径：真算一次赛段（评委池只有 1 人 ⇒ 池不合规 ⇒ 告警明细带 judgeId）
//      → 公开榜单（匿名访客）⇒ 响应里不得出现那个 id。
test('F11 运行时：匿名访客的榜单响应里不得泄漏评委 id（走真实计算 + 榜单路径）', async () => {
  const { db, close } = freshDb();
  try {
    const { rules } = loadRules(rulesDir);
    const now = '2026-10-23T10:00:00.000Z';
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','北京','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
    const judge = createUser(db, { name: '评委甲', phone: '13900000081', password: 'pw' });
    const captain = createUser(db, { name: '一队队长', phone: '13900000082', password: 'pw' });
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm1','ed1','一队','${captain.id}','${now}')`);
    assignStageJudge(db, { stageId: 'st1', userId: judge.id, seat: 'judge', now });
    db.exec(
      `INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,submitted_at,request_id,calibrated)
       VALUES ('r1','st1','${judge.id}','tm1','track_fit',80,'${now}','req_1',0)`,
    );

    const { insertSnapshot } = await import('../src/db/repo/computations.js');
    // ⚠️ 泄漏的真实载体是**计算快照里的告警明细**（榜单把快照的 warnings 直接带给访客）。
    //    ⇒ 这里写一份**带评委 id 明细**的快照（等价于「历史上算出来的那一份」），
    //      再看公开榜单会不会把它原样端出去。
    const leakId = 'u_judge_leak_0001';
    insertSnapshot(db, {
      kind: 'stage_score', editionId: 'ed1', stageId: 'st1', teamId: null,
      ruleVersion: '2026-10-23',
      input: {}, trace: {},
      output: {
        // ⚠️ **形状照抄生产代码**（compute.js:212-217）：`message` 只列错误 **code**，
        //    带原始 judgeId 的是 `errors[].message` ⇒ 泄漏就发生在 `errors` 这个字段上。
        warnings: [{
          code: 'judge_pool_invalid',
          message: '评委池不合规（1 项）：duplicate_judge',
          errors: [{ code: 'duplicate_judge', message: `评委名单里有 1 个重复的 judgeId：${leakId}` }],
          stats: { total: 3, voting: 3, enterprise: 1, expert: 2, observer: 0, perDimension: { all: 3 } },
        }],
      },
      revision: 1, now,
    });

    // 公开榜单（匿名访客 = viewer 为 null）
    const { getLeaderboard } = await import('../src/services/leaderboard.js');
    const lb = getLeaderboard({ db, stageId: 'st1', scope: 'rank', viewer: null, rules });
    const dumped = JSON.stringify(lb);
    assert.ok(
      !dumped.includes(leakId),
      `匿名访客的榜单里泄漏了评委 id：${dumped.slice(0, 400)}`,
    );
    // 告警**一条都不许少**（裁的是字段，不是告警）
    // ⚠️ E184：公开视角**不再下发内部规则键** ⇒ 按人话正文认这条告警
    assert.ok(
      (lb.warnings ?? []).some((w) => w.message === '评委池不合规（1 项）：duplicate_judge'),
      '告警本身必须保留（降级必须显式展示，不静默）',
    );
    assert.ok(
      !JSON.stringify(lb).includes('judge_pool_invalid'),
      '匿名访客的告警里不得出现内部规则键（E184）',
    );
    // 正对照：有 audit:read 的人**必须**拿到完整明细（否则就成了「把告警藏起来」）
    const admin = createUser(db, { name: '组委会', phone: '13900000083', password: 'pw' });
    setSuperadmin(db, admin.id);
    insertCapability(db, 'audit:read', '读审计日志');
    grantAssignment(db, {
      userId: admin.id, capability: 'audit:read', scopeType: 'global', scopeId: null, grantedBy: admin.id,
    });
    const lbAudit = getLeaderboard({ db, stageId: 'st1', scope: 'rank', viewer: admin, rules });
    assert.ok(
      JSON.stringify(lbAudit).includes(leakId),
      '有 audit:read 的人必须拿到完整告警明细（裁剪只针对公开视角，不许把告警藏起来）',
    );
  } finally { close(); }
});

// ═══ F17（运行时）：演示站用前端真实的 body 建队必须成功 ═══
// ⚠️ 上面那条用例只测 `demoTeamFormation` 这个纯函数；它抓不住「演示站的前端
//    真的按这个 body 建队失败」。⇒ 这里走**演示站的 HTTP 适配器**：登录 → 按前端
//    真实发的 body 建队 ⇒ 必须成功。
test('F17 运行时：演示站按前端真实的 body 建队必须成功（不是 100% 失败）', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const seed = JSON.parse(rf(join(platformDir, 'web', 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(rulesDir);
  const { createDemoApi } = await import('../web/api.demo.js');
  const m = new Map();
  const storage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
  const api = createDemoApi({ storage, seed, rules });
  await api.post('/api/auth/login', { name: '演示管理员' });
  // ⚠️ 前端 web/views/team.js 真实发的 body：**不带 memberIds**
  const team = await api.post('/api/teams', { editionId: 'ed_demo', name: '演示新队', taskPackageId: 'tp_retail' });
  assert.ok(team?.id, `演示站建队必须成功，实际返回：${JSON.stringify(team)}`);
  assert.equal(team.name, '演示新队');
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
        reasonKind: 'scoring_error',
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
      reason: '企业确认分与事实不符',
      // ⚠️ M0-2：赛段结果类申诉必须声明**程序性错误**类型（白名单在 rules/audit.json）
      reasonKind: 'scoring_error',
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

// ══════════════════════════════════════════════════════════════════
// 第 7 批（E173）：授权 / 归属类 4 条 —— F30 / F40 / F42 / F33
//   F30 任意企业可伪造**他企**队伍的里程碑签字（被当作客观事实消费）
//   F40 竞品可往**任意队**写行为事件（改变对方的完赛认定）
//   F42 跨企业**签级重评**被授权（改的是进池的输入）
//   F33 人才池读取**不按届期隔离**（不带 editionId ⇒ 全表）
//
// ⚠️ **夹具按生产口径造**：企业席提交任务卡 ⇒ `task_packages.enterprise_id` = 提交人自己
//    （F31 修完后的服务层口径）。旧夹具把 enterprise_id 留空 ⇒ 那是「无主卡」，
//    根本触发不了「跨企业」这条路径 ⇒ **夹具不符合契约，用例就是假绿**。
// ⚠️ 每条用例都带**对照组**（本企业/本队必须仍然成功）——
//    只测「被拒」不测「该过的还过」，实现可以靠「一律拒」骗绿。
// ══════════════════════════════════════════════════════════════════

const SOLVABILITY_FULL = {
  problem_clarity: 3, data_access: 3, validation: 2,
  decision_chain: 1, accountability: 1, precedent: 1,
};
const BEHAVIOR_EVIDENCE = { repo: 'git@example.com:team/repo', version: 'v1.2.0', artifact: 'demo.zip' };

/** 两家企业 + 两支队的越权夹具（真实库 + 真 HTTP 服务）。 */
async function withTwoEnterprises(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-ent-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = new Date().toISOString();
  try {
    for (const [k, d] of [
      ['signoff:create', '企业里程碑签字'],
      ['task_package:write', '提交任务卡'],
      ['behavior:write', '提交行为分记录'],
    ]) insertCapability(db, k, d);

    // 两家企业，org 不同 ⇒「同企业」判定不能把甲误判成乙
    const entA = createUser(db, { name: '甲企业', phone: '13800001701', password: 'pw', org: '甲公司' });
    const entB = createUser(db, { name: '乙企业', phone: '13800001702', password: 'pw', org: '乙公司' });
    const capA = createUser(db, { name: 'A队长', phone: '13800001703', password: 'pw', mbaStatus: 'mba' });
    const capB = createUser(db, { name: 'B队长', phone: '13800001704', password: 'pw', mbaStatus: 'mba' });

    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    // ⚠️ 出题企业 = 乙公司（enterprise_id 与 submitted_by 都是乙企业本人）
    db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
             VALUES ('tp_b','ed1','${entB.id}','乙公司','乙队任务包','p','e','a',0,'${entB.id}','submitted','{}','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at) VALUES ('team_b','ed1','乙队','${capB.id}','tp_b','active','${now}')`);
    db.exec(`INSERT INTO team_members (id,team_id,user_id,role,joined_at) VALUES ('tm_b','team_b','${capB.id}','captain','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at) VALUES ('team_a','ed1','甲队','${capA.id}','tp_b','active','${now}')`);
    db.exec(`INSERT INTO team_members (id,team_id,user_id,role,joined_at) VALUES ('tm_a','team_a','${capA.id}','captain','${now}')`);
    db.exec(`INSERT INTO milestones (id,team_id,key,label,counts_toward_tier,requires_signoff,fixed_at,created_at)
             VALUES ('ms_b','team_b','problem_confirmed','企业问题确认',1,1,'${now}','${now}')`);

    const grant = (userId, capability) => grantAssignment(db, {
      userId, capability, scopeType: 'global', scopeId: null, grantedBy: null,
    });
    for (const u of [entA, entB]) { grant(u.id, 'signoff:create'); grant(u.id, 'task_package:write'); }
    for (const u of [capA, capB]) grant(u.id, 'behavior:write');

    await fn({
      base, db, now, entA, entB, capA, capB,
      tokenEntA: createSession(db, entA.id).token,
      tokenEntB: createSession(db, entB.id).token,
      tokenCapA: createSession(db, capA.id).token,
      tokenCapB: createSession(db, capB.id).token,
    });
  } finally {
    await new Promise((r) => server.close(r));
    close();
  }
}

// ═══ F30：任意企业可伪造他企队伍的里程碑签字 ═══
test('F30 任意企业不得给他企队伍的里程碑签字（伪造客观事实）', async () => {
  await withTwoEnterprises(async ({ base, db, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'POST', '/api/milestones/ms_b/signoff', {
      cookie: `hk_session=${tokenEntA}`,
      body: { department: '业务部', content: '确认已落地' },
    });
    assert.equal(r.status, 403, `甲企业给乙企业的队伍签字必须被拒，实际 ${r.status}：${r.text}`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM milestone_signoffs').get().n, 0,
      '伪造的签字不得落库（签字是「客观事实」，被系统消费后直接影响段位）',
    );
    // 对照组：出题企业本人签字必须成功（不能靠「一律拒」骗绿）
    const ok = await call(base, 'POST', '/api/milestones/ms_b/signoff', {
      cookie: `hk_session=${tokenEntB}`,
      body: { department: '业务部', content: '确认已落地' },
    });
    assert.equal(ok.status, 200, `出题企业本人签字必须成功：${ok.text}`);
  });
});

// ═══ F40：竞品可往任意队写行为事件 ═══
test('F40 竞品不得往他队写行为事件（行为分直接改变对方的完赛认定）', async () => {
  await withTwoEnterprises(async ({ base, db, tokenCapA, tokenCapB }) => {
    const r = await call(base, 'POST', '/api/teams/team_b/behavior-events', {
      cookie: `hk_session=${tokenCapA}`,
      body: { type: 'weekly_progress', evidence: BEHAVIOR_EVIDENCE },
    });
    assert.equal(r.status, 403, `A 队队长给 B 队写行为事件必须被拒，实际 ${r.status}：${r.text}`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n, 0,
      '他队的行为事件不得落库',
    );
    // 对照组：本队队长写自己的队必须成功
    const ok = await call(base, 'POST', '/api/teams/team_b/behavior-events', {
      cookie: `hk_session=${tokenCapB}`,
      body: { type: 'weekly_progress', evidence: BEHAVIOR_EVIDENCE },
    });
    assert.equal(ok.status, 200, `本队队长写本队必须成功：${ok.text}`);
  });
});

// ═══ F42：跨企业签级重评被授权 ═══
test('F42 跨企业签级重评必须被拒（他企任务卡的评级不得被改）', async () => {
  await withTwoEnterprises(async ({ base, db, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'POST', '/api/task-packages/tp_b/solvability', {
      cookie: `hk_session=${tokenEntA}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(r.status, 403, `甲企业重评乙企业的任务卡必须被拒，实际 ${r.status}：${r.text}`);
    const row = db.prepare('SELECT solvability_score FROM task_packages WHERE id = ?').get('tp_b');
    assert.equal(row.solvability_score, null, '他企任务卡的评级被改了');
    // 对照组：出题企业本人重评必须成功
    const ok = await call(base, 'POST', '/api/task-packages/tp_b/solvability', {
      cookie: `hk_session=${tokenEntB}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(ok.status, 200, `出题企业本人重评必须成功：${ok.text}`);
  });
});

// ═══ F42b：提交人本人仍可评自己提交的卡（代提交场景）═══
test('F42b 代提交场景：提交人本人可评自己提交的卡（提交人是唯一凭据时）', async () => {
  await withTwoEnterprises(async ({ base, db, entA, entB, tokenEntA, tokenEntB }) => {
    // 「企业管理员代企业 B 提交」：submitted_by = 管理员 A，enterprise_id = 出题企业 B
    // ⇒ A（提交人）可评；B（出题企业）可评；**别人**不可评。
    db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
             VALUES ('tp_c','ed1','${entB.id}','乙公司','代提交卡','p','e','a',0,'${entA.id}','submitted','{}','${new Date().toISOString()}')`);

    // 提交人 A：可评（他提交的卡）
    const bySubmitter = await call(base, 'POST', '/api/task-packages/tp_c/solvability', {
      cookie: `hk_session=${tokenEntA}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(bySubmitter.status, 200, `提交人本人必须能评自己提交的卡：${bySubmitter.text}`);

    // 出题企业 B：可评（这是他出的题）
    db.exec(`UPDATE task_packages SET status = 'submitted' WHERE id = 'tp_c'`);
    const byIssuer = await call(base, 'POST', '/api/task-packages/tp_c/solvability', {
      cookie: `hk_session=${tokenEntB}`,
      body: { answers: SOLVABILITY_FULL },
    });
    assert.equal(byIssuer.status, 200, `出题企业本人必须能能评自己出的题：${byIssuer.text}`);
  });
});

// ═══ F33：人才池读取不按届期隔离 ═══
test('F33 人才池读取必须按届期隔离（不带 editionId 不得返回其它届期的行）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const viewer = createUser(db, { name: '参赛者', phone: '13800001711', password: 'pw', mbaStatus: 'mba' });
    grantAssignment(db, {
      userId: viewer.id, capability: 'pool:read', scopeType: 'global', scopeId: null, grantedBy: null,
    });
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    // 参赛者报名了 ed_1 ⇒ 缺省届期应落到 ed_1
    db.exec(`INSERT INTO registrations (id,edition_id,user_id,answers_json,dimension_scores_json,raw_score,level,level_final,status,created_at)
             VALUES ('r_v','ed_1','${viewer.id}','{}','{}',80,'B','B','accepted','${now}')`);
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_1','${viewer.id}','ed_1','本人','某公司',10,'mba',1,'[]','${now}')`);
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${viewer.id}','ed_2','别届的人','别家公司',99,'other',3,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');
    const all = listPoolTalents({ db, filter: {}, viewer });
    assert.ok(
      all.every((r) => r.editionId === 'ed_1'),
      `不带 editionId 读人才池返回了其它届期的行：${JSON.stringify(all.map((r) => r.editionId))}`
      + ' —— 届期隔离是平台级约束（S2），池读取必须按届期隔离',
    );
    // 对照组：显式指定届期仍然只返回该届
    const scoped = listPoolTalents({ db, filter: { editionId: 'ed_1' }, viewer });
    assert.equal(scoped.length, 1, '指定届期时只返回该届的行');
    assert.equal(scoped[0].editionId, 'ed_1');
  } finally {
    close();
  }
});

// ═══ F33b：F33 的**残留面** —— 显式传 editionId 时也必须按届期隔离 ═══
// ⚠️ **为什么这是独立的一条**：F33 第一版只钉了「不带 editionId」的路径。
//    显式传 editionId 时 `canReadPool` 走 `can()` 的**角色分支**
//    （角色授权是全局的，INTERFACES.md:22）⇒ 任何持有 `pool:read` 的登录用户
//    带上**别届**的 editionId 就能读到别届参赛者的姓名 / 单位 / 积分 / MBA 状态。
//    ⇒ 届期隔离（S2）在显式路径上仍然是破的。
// ⚠️ **判别性要求**：本条必须同时钉住「别届读不到」**和**「本届读得到」
//    （只钉前者 ⇒ 实现退化成「一律拒」也能骗绿）。
test('F33b 显式传别届 editionId 也必须读不到（届期隔离在显式路径上不能是破的）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-b-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const viewer = createUser(db, { name: '参赛者', phone: '13800001721', password: 'pw', mbaStatus: 'mba' });
    // ⚠️ 授权走**角色**（captain/member/enterprise 都持有 pool:read）⇒ 角色分支全局命中
    insertRole(db, 'member', '组员');
    insertRoleCapability(db, 'member', 'pool:read');
    insertUserRole(db, viewer.id, 'member');
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    // 参赛者只报名了 ed_1
    db.exec(`INSERT INTO registrations (id,edition_id,user_id,answers_json,dimension_scores_json,raw_score,level,level_final,status,created_at)
             VALUES ('r_v','ed_1','${viewer.id}','{}','{}',80,'B','B','accepted','${now}')`);
    // 本届的池行（自己）
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_1','${viewer.id}','ed_1','本人','某公司',10,'mba',1,'[]','${now}')`);
    // **别届**的池行：别届的另一个人
    const other = createUser(db, { name: '别届的人', phone: '13800001722', password: 'pw', mbaStatus: 'other' });
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${other.id}','ed_2','别届的人','别家公司',99,'other',3,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');

    // ① 别届：必须读不到
    const otherEdition = listPoolTalents({ db, filter: { editionId: 'ed_2' }, viewer });
    assert.deepEqual(
      otherEdition, [],
      `显式传别届 editionId 却读到了 ${otherEdition.length} 行 —— 届期隔离（S2）在显式路径上是破的`
      + `（角色授权全局命中 ⇒ can() 表达不了「他属于哪一届」）`,
    );

    // ② 对照组：本届必须仍然读得到（防「一律拒」骗绿）
    const own = listPoolTalents({ db, filter: { editionId: 'ed_1' }, viewer });
    assert.equal(own.length, 1, '本人报名的那一届必须仍然读得到（不能把闸修成「一律拒」）');
    assert.equal(own[0].editionId, 'ed_1');
  } finally {
    close();
  }
});

// ═══ F33c：对照组 —— 组委会可以跨届读（防止把闸修成「谁都读不到」）═══
test('F33c 组委会（admin 角色）必须能跨届读池（闸不能修成「一律拒」）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-c-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const chair = createUser(db, { name: '组委会', phone: '13800001731', password: 'pw' });
    insertRole(db, 'admin', '组委会');
    insertRoleCapability(db, 'admin', 'pool:read');
    insertUserRole(db, chair.id, 'admin');
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    const someone = createUser(db, { name: '别届的人', phone: '13800001732', password: 'pw' });
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${someone.id}','ed_2','别届的人','别家公司',99,'other',3,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');
    const rows = listPoolTalents({ db, filter: { editionId: 'ed_2' }, viewer: chair });
    assert.equal(rows.length, 1, '组委会必须能跨届读池（跨届调度是组委会的职责）');
    assert.equal(rows[0].editionId, 'ed_2');
  } finally {
    close();
  }
});

// ═══ F33d：对照组 —— 企业侧（不报名，只出题）必须能读该届人才池 ═══
// ⚠️ 这一条钉的是**业务不回归**：企业通过提交任务卡参与，**不报名**
//    ⇒ 关联判据若只认报名，企业就永远看不到人才池（而人才池正是给企业挑人用的）。
test('F33d 出题企业（不报名）必须能读该届人才池（关联判据不能只认报名）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-pool-d-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'pool:read', '读三池');
    const ent = createUser(db, { name: '出题企业', phone: '13800001741', password: 'pw' });
    insertRole(db, 'enterprise', '企业席');
    insertRoleCapability(db, 'enterprise', 'pool:read');
    insertUserRole(db, ent.id, 'enterprise');
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed_2','第二届','上海','2027-01-01','2027-12-31','${now}')`);
    // 企业在 ed_2 出了一张任务卡（**没有报名记录**）
    db.exec(`INSERT INTO task_packages
              (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,status,submitted_by,submitted_at,deleted_at)
             VALUES ('tp_1','ed_2','${ent.id}','出题企业','题目','痛点','交付','验收','published','${ent.id}','${now}',NULL)`);
    const someone = createUser(db, { name: '人才', phone: '13800001742', password: 'pw' });
    db.exec(`INSERT INTO pool_talents (id,user_id,edition_id,name,org,total_points,mba_status,stages_joined,skills_json,created_at)
             VALUES ('pt_2','${someone.id}','ed_2','人才','某公司',50,'mba',2,'[]','${now}')`);

    const { listPoolTalents } = await import('../src/services/pools.js');
    const rows = listPoolTalents({ db, filter: { editionId: 'ed_2' }, viewer: ent });
    assert.equal(rows.length, 1, '出题企业必须能读该届人才池（企业侧不报名 ⇒ 关联判据不能只认报名）');
    assert.equal(rows[0].editionId, 'ed_2');
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// 第 8 批（E174）：领域算法 4 条 —— F43 / F44 / F45 / F46
//   F43 `scope:'tied_only'` 根本没实现（配置在说谎：改链序就能让互评变成主排序键）
//   F44 少维度的队伍被结构性抬高（**复核后判定为不成立**，见用例注释）
//   F45 去极值在评委数边界不连续（S7 §3.2 明写的整数阶跃 ⇒ 配置必须显式声明）
//   F46 归一化回退把整个赛段降级（S7 §3.1 的样本数口径 ⇒ 配置必须显式声明）
// ══════════════════════════════════════════════════════════════════

// ═══ F43：`tied_only` 作用域必须真的被实现 ═══
test('F43 破同分链的 tied_only 项必须排在 total 之后（互评不得进主排序）', async () => {
  const { applyTiebreakChain } = await import('../src/domain/ranking.js');

  // ① `tied_only` 的项排在 `total` **之前** ⇒ **必须拒绝对这条链算分**
  //    （R-RNK-05：互评只做破同分，从不进入主排序 —— 排在 total 之前就变成主排序键）
  //    ⚠️ 这条链**只**违反这一条（末项 deterministic、有 total、无 behavior 项）
  //    ⇒ 报错原因唯一，判别性不会被别的规则污染。
  //    ⚠️ **为什么需要这条闸（审计当时以为要「实现 tied_only」，那是错的）**：
  //    本引擎的排序是**字典序** ⇒ `always` 与 `tied_only` 在运行时**等价**
  //    （后面的键本来就只在前面的键打平时才比较）⇒ 「实现这个 scope」根本改不了输出
  //    （实测：真去实现它，6 条既有破同分用例当场变红 —— 字典序被破坏）。
  //    ⇒ 真正能破坏 R-RNK-05 的**只有链序**，而链序是**配置** ⇒ 必须机器闸。
  const badChain = [
    { key: 'peer', label: '互评分', direction: 'desc', scope: 'tied_only', source: 'S7 §3.3' },
    { key: 'total', label: '总分', direction: 'desc', scope: 'always', source: 'S7 §3.1' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always', deterministic: true, source: 'C-03' },
  ];
  assert.throws(
    () => applyTiebreakChain({
      candidates: [{ teamId: 'A', total: 90 }, { teamId: 'B', total: 50 }],
      chain: badChain,
      data: {},
    }),
    /tied_only/,
    '链首是 tied_only 的链必须被拒（否则改配置就能让互评变成主排序键）',
  );

  // ② 总分**相同**的两队 ⇒ 并列组里 `tied_only` 的键必须**真的生效**（否则破同分失效）
  const chain = [
    { key: 'total', label: '总分', direction: 'desc', scope: 'always', source: 'S7 §3.1' },
    { key: 'peer', label: '互评分', direction: 'desc', scope: 'tied_only', source: 'S7 §3.3' },
    { key: 'team_id', label: '队伍编号', direction: 'asc', scope: 'always', deterministic: true, source: 'C-03' },
  ];
  const out = applyTiebreakChain({
    candidates: [
      { teamId: 'A', total: 90, peer: 10 },
      { teamId: 'B', total: 90, peer: 99 },
    ],
    chain,
    data: {},
  });
  assert.deepEqual(
    out.ordered.map((c) => c.teamId), ['B', 'A'],
    '并列组里互评分必须能拆开（tied_only 不是「永不生效」）',
  );

  // ③ 总分**不同**的两队 ⇒ `tied_only` 的键**不得**把它们拆开（R-RNK-05 的实际效果）
  const out2 = applyTiebreakChain({
    candidates: [
      { teamId: 'A', total: 90, peer: 10 },
      { teamId: 'B', total: 50, peer: 99 },
    ],
    chain,
    data: {},
  });
  assert.deepEqual(
    out2.ordered.map((c) => c.teamId), ['A', 'B'],
    '互评只做破同分：总分不同的两队不得被互评分拆开',
  );
});

// ═══ F44：少维度的队伍被结构性抬高 —— **复核后判定为不成立**（本用例是「口径钉子」）═══
test('F44 缺分维度的权重按「记 0（不参与分子分母）」处理，且必须列入 warnings', async () => {
  // ⚠️ **这条审计结论经复核后判定为不成立**，理由（证据链）：
  //   ① 设计文档 §11「错误处理与失效防护」表原文：「某维度无人打分 | 该维度权重记 0
  //      并列入 warnings，**不静默当 0**」⇒ 规格要求的是「**权重**记 0」；
  //   ② 「权重记 0」的数学含义 = 该维度对分数**无影响**（既不加分也不减分）
  //      = 分子分母都不含它 = 现有实现（`seatScore` 的分母是**实际参与权重和**）；
  //   ③ 审计报告用「(0.2×80+0.2×80)/0.9 = 35.56」这个**「分数记 0」**的公式
  //      去检验「**权重**记 0」的规格 ⇒ 拿 A 去量 B ⇒ 「文案与行为不一致」的结论不成立；
  //   ④ 代码里的告警文案（`scoring.js`：「该维度权重记 0」）与实现**逐字一致**。
  //   ⇒ 结论：**不改计分行为**。本用例把口径**钉死**：将来若有人把它改成「缺分记 0」，
  //   这条用例会红 ⇒ 逼他先改规格。
  const { seatScore } = await import('../src/domain/trim.js');
  const out = seatScore({ dimensionScores: { a: 80 }, weights: { a: 0.5, b: 0.5 } });
  assert.equal(out.weightSum, 0.5, '缺分维度的权重不进分母（= 权重记 0）');
  assert.equal(out.score, 80, '结果是「已有维度上的相对加权平均」');
  assert.deepEqual(out.missing, ['b'], '缺分维度必须进 missing（⇒ 会被列成 warning，不静默）');

  // 文案与行为必须**对得上**：文案说「权重记 0」⇒ 权重确实不进分母
  const src = readFileSync(join(platformDir, 'src', 'domain', 'scoring.js'), 'utf8');
  assert.match(src, /该维度权重记 0/, '告警文案必须说明「权重记 0」');
  assert.match(src, /dimension_no_scores/, '缺分维度必须出 warning（不静默当 0）');
});

// ═══ F45 / F46：规则必须**显式声明**那些「刻意的阶跃与口径」 ═══
test('F45/F46 去极值阶跃与归一化样本数口径必须由规则显式声明，且有机器闸', async () => {
  const { loadRules, validateRules } = await import('../src/config.js');
  const { rules } = loadRules(rulesDir);

  // ① 规则里必须**写明**这两件事（配置自解释：否则下一个人会当 bug 去「修」）
  for (const key of ['initial', 'final']) {
    const cfg = rules.scoring[key];
    assert.equal(
      cfg.trimPolicy, 'threshold',
      `scoring.${key}.trimPolicy 必须显式声明「整数阶跃去极值」（S7 §3.2）—— 没有声明 ⇒ 没人知道这个阶跃是刻意的`,
    );
    assert.equal(
      cfg.minSamplesScope, 'judge_ratings_count',
      `scoring.${key}.minSamplesScope 必须显式声明「样本数 = 该评委在本赛段评过的队伍数」（S7 §3.1）`,
    );
  }

  // ② 机器闸：把声明**删掉** ⇒ 必须报错（不许悄悄生效）
  for (const key of ['initial', 'final']) {
    const broken = JSON.parse(JSON.stringify(rules));
    delete broken.scoring[key].trimPolicy;
    const errs = validateRules(broken, Object.keys(broken).length);
    assert.ok(
      errs.some((e) => e.includes(`scoring.${key}.trimPolicy`)),
      `删掉 scoring.${key}.trimPolicy 必须报错（配置在说谎 ⇒ 机器闸必须拦住）`,
    );

    const broken2 = JSON.parse(JSON.stringify(rules));
    delete broken2.scoring[key].minSamplesScope;
    const errs2 = validateRules(broken2, Object.keys(broken2).length);
    assert.ok(
      errs2.some((e) => e.includes(`scoring.${key}.minSamplesScope`)),
      `删掉 scoring.${key}.minSamplesScope 必须报错`,
    );
  }

  // ③ 机器闸：破同分链首改成 tied_only ⇒ 必须报错（R-RNK-05）
  const brokenChain = JSON.parse(JSON.stringify(rules));
  brokenChain.tiebreak.chain[0] = { ...brokenChain.tiebreak.chain[0], scope: 'tied_only' };
  const errs3 = validateRules(brokenChain, Object.keys(brokenChain).length);
  assert.ok(
    errs3.some((e) => e.includes('tied_only')),
    '把破同分链首改成 tied_only 必须报错（否则改配置就能让互评变成主排序键）',
  );
});

// ══════════════════════════════════════════════════════════════════
// F27：HEAD / OPTIONS 全部 404，且没有任何 CORS 头
//   缺陷溯源：内部审计报告 §3.5「F27 · Low · HEAD/OPTIONS 全部 404，无 CORS」
//   现象：HEAD /api/health → 404（朴素存活探针会误判服务已死）；
//        OPTIONS → 404 且不带任何 Access-Control-Allow-*。
//   根因：src/http/router.js 是**方法精确匹配**（`if (route.method !== m) continue;`）。
//   修法（本文件钉住的口径）：
//     ① HEAD 语义等价 GET（RFC 9110 §9.3.2）⇒ 命中同名 GET 路由，**只丢响应体、保留 Content-Length**；
//     ② OPTIONS 回 **204 + Allow**（明确列出该路径支持的方法）；
//     ③ CORS **默认关闭**（不破坏现有部署），**可配置开启**（白名单）。
// ══════════════════════════════════════════════════════════════════
test('F27 HEAD 必须命中同名 GET 路由：200 + 保留 Content-Length + 无响应体', async () => {
  await withServer(async ({ base }) => {
    const head = await call(base, 'HEAD', '/api/health');
    assert.equal(head.status, 200, `HEAD /api/health 必须 200（修复前是 404），实际 ${head.status}：${head.text}`);
    assert.ok(head.headers['content-length'], 'HEAD 必须保留 Content-Length（探针要靠它判断体量）');
    assert.equal(head.text, '', 'HEAD 不得返回响应体');

    // ⚠️ 对照组：同一个路由的 GET 必须**仍然**返回体
    //    （否则这条用例就变成了「一律清空响应体」的恒绿）。
    const get = await call(base, 'GET', '/api/health');
    assert.equal(get.status, 200);
    assert.ok(get.text.length > 0, 'GET 必须仍然返回响应体（HEAD 不得把 GET 也清空）');
  });
});

test('F27b HEAD 不得放宽方法边界：未注册路径仍 404、只有 POST 的端点仍 404', async () => {
  await withServer(async ({ base }) => {
    const unknown = await call(base, 'HEAD', '/api/this-route-does-not-exist');
    assert.equal(unknown.status, 404, '未注册的路径仍然必须 404（HEAD 不是万能通行证）');
    // ⚠️ 对照组：/api/auth/login 只注册了 POST ⇒ HEAD 不得命中它
    //    （HEAD 只等价 GET，不等价 POST —— 否则一个只该写的端点会被探针摸到）。
    const postOnly = await call(base, 'HEAD', '/api/auth/login');
    assert.equal(postOnly.status, 404, '只有 POST 的端点不得被 HEAD 命中（HEAD 只等价 GET）');
    // ⚠️ 对照组：TRACE 必须仍然 404（缺陷报告 §3.5 F27 原文：
    //    「TRACE → 404（**好的一面**：不会回显）」）—— HEAD 的回退不得顺带把 TRACE 也放开。
    //    ⚠️ fetch 不支持 TRACE ⇒ 这条走裸 HTTP。
    const trace = await rawCall(base, 'TRACE', '/api/health');
    assert.equal(trace.status, 404, 'TRACE 必须仍然 404（不得回显，也不得被 HEAD 回退带出来）');
  });
});

test('F27c HEAD 必须真的走 GET 的处理器（鉴权照旧生效，不是无条件 200）', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'HEAD', '/api/me');
    assert.equal(r.status, 401, 'HEAD /api/me 未登录必须仍是 401（HEAD 与 GET 同语义，不是无条件 200）');
  });
});

test('F27d HEAD 也必须能命中静态页（探针常探 / 而不是 /api/health）', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'HEAD', '/index.html');
    assert.equal(r.status, 200, `HEAD 静态页必须 200（修复前是 404），实际 ${r.status}：${r.text}`);
    assert.equal(r.text, '', 'HEAD 静态页不得返回响应体');
    assert.ok(r.headers['content-length'], 'HEAD 静态页必须保留 Content-Length');
  });
});

test('F27e OPTIONS 必须回 204 + Allow（未注册路径仍 404）', async () => {
  await withServer(async ({ base }) => {
    const r = await call(base, 'OPTIONS', '/api/health');
    assert.equal(r.status, 204, `OPTIONS 必须回 204（修复前是 404），实际 ${r.status}：${r.text}`);
    const allow = r.headers['allow'] || '';
    assert.match(allow, /GET/, `Allow 必须列出 GET，实际：${allow}`);
    assert.match(allow, /HEAD/, `Allow 必须列出 HEAD，实际：${allow}`);
    assert.match(allow, /OPTIONS/, `Allow 必须列出 OPTIONS，实际：${allow}`);

    // ⚠️ 对照组：POST 端点的 Allow 必须列 POST，且**不得**列 GET
    //    （Allow 写错 ⇒ 客户端以为这个端点能读，其实只能写）。
    const p = await call(base, 'OPTIONS', '/api/auth/login');
    assert.equal(p.status, 204);
    const pAllow = p.headers['allow'] || '';
    assert.match(pAllow, /POST/, `Allow 必须列出 POST，实际：${pAllow}`);
    assert.doesNotMatch(pAllow, /GET/, `只注册了 POST 的端点不得在 Allow 里出现 GET，实际：${pAllow}`);

    // ⚠️ 对照组：未注册的路径仍然 404（OPTIONS 不是万能 204）。
    const unknown = await call(base, 'OPTIONS', '/api/nope-not-here');
    assert.equal(unknown.status, 404, '未注册的路径 OPTIONS 仍然必须 404');
  });
});

test('F27f CORS 默认关闭：不得凭空出现 Access-Control-Allow-Origin（不破坏现有部署）', async () => {
  // ⚠️ 依据：缺陷报告 §3.5 F27 修法 ③「CORS 是否要开是产品决策（目前刻意不开）」
  //    ⇒ 默认一个 Access-Control-* 头都不给（8444 演示站是**另一个 origin**的静态站，
  //    平台 API 走同源；凭空开跨域等于给公网多开一个面）。
  await withServer(async ({ base }) => {
    const r = await call(base, 'GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined, '默认不得开跨域');
    const opt = await call(base, 'OPTIONS', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(opt.status, 204);
    assert.equal(opt.headers['access-control-allow-origin'], undefined, '默认预检也不得开跨域');
  });
});

test('F27g CORS 可配置开启：白名单内的来源必须拿到预检头，白名单外拿不到', async () => {
  const prev = process.env.CORS_ALLOW_ORIGIN;
  process.env.CORS_ALLOW_ORIGIN = 'https://demo.example.com';
  try {
    await withServer(async ({ base }) => {
      const ok = await call(base, 'OPTIONS', '/api/health', {
        headers: { Origin: 'https://demo.example.com', 'Access-Control-Request-Method': 'GET' },
      });
      assert.equal(ok.status, 204);
      assert.equal(ok.headers['access-control-allow-origin'], 'https://demo.example.com', '白名单内的来源必须被放行');
      assert.match(ok.headers['access-control-allow-methods'] || '', /GET/, '预检必须列出允许的方法');
      assert.ok(ok.headers['access-control-allow-headers'], '预检必须列出允许的请求头');
      assert.match(ok.headers['access-control-max-age'] || '', /^\d+$/, '预检必须带 Max-Age（否则每次都预检）');

      // ⚠️ 对照组：不在白名单的来源不得拿到放行头。
      const bad = await call(base, 'OPTIONS', '/api/health', {
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
      });
      assert.equal(bad.status, 204);
      assert.equal(bad.headers['access-control-allow-origin'], undefined, '白名单外的来源不得被放行');

      // ⚠️ 对照组：普通（简单）跨源请求也要带 ACAO，否则预检过了、实际请求又被拦。
      const simple = await call(base, 'GET', '/api/health', { headers: { Origin: 'https://demo.example.com' } });
      assert.equal(simple.status, 200);
      assert.equal(simple.headers['access-control-allow-origin'], 'https://demo.example.com');
    });
  } finally {
    if (prev === undefined) delete process.env.CORS_ALLOW_ORIGIN;
    else process.env.CORS_ALLOW_ORIGIN = prev;
  }
});

// ══════════════════════════════════════════════════════════════════
// F28：完全没有安全响应头
//   缺陷溯源：内部审计报告 §3.5「F28 · Low · 完全没有安全响应头」
//   验收口径（报告原文）：「所有响应都带 X-Content-Type-Options: nosniff 与 X-Frame-Options」。
//   本文件追加的口径：
//     · HSTS **仅在 https 下**（明文连接带 HSTS 是误导；浏览器也会忽略明文来的 HSTS）；
//     · **不得**加会拦掉页面资源的 Content-Security-Policy
//       （前端视图里有内联 style 属性 ⇒ 严格 CSP 会把整站搞坏）。
// ══════════════════════════════════════════════════════════════════
test('F28 所有响应都必须带安全响应头（API / 404 / 静态页一律带）', async () => {
  await withServer(async ({ base }) => {
    const api = await call(base, 'GET', '/api/health');
    assert.equal(api.status, 200);
    assert.equal(api.headers['x-content-type-options'], 'nosniff', 'API 响应必须带 X-Content-Type-Options: nosniff');
    assert.ok(api.headers['referrer-policy'], 'API 响应必须带 Referrer-Policy');
    assert.ok(api.headers['x-frame-options'], 'API 响应必须带 X-Frame-Options（防点击劫持）');

    // ⚠️ 对照组：404 响应也必须带（不是只有成功路径才有）。
    const nf = await call(base, 'GET', '/api/nope-not-here');
    assert.equal(nf.status, 404);
    assert.equal(nf.headers['x-content-type-options'], 'nosniff', '404 响应也必须带安全头');
    assert.ok(nf.headers['x-frame-options'], '404 响应也必须带 X-Frame-Options');

    // ⚠️ 对照组：静态页也必须带（管理后台 SPA 是点击劫持的主要目标）。
    const html = await call(base, 'GET', '/index.html');
    assert.equal(html.status, 200);
    assert.equal(html.headers['x-content-type-options'], 'nosniff', '静态页也必须带安全头');
    assert.ok(html.headers['x-frame-options'], '静态页也必须带 X-Frame-Options');
  });
});

test('F28b HSTS 只在 https 下出现（明文连接不得带 Strict-Transport-Security）', async () => {
  await withServer(async ({ base }) => {
    const plain = await call(base, 'GET', '/api/health');
    assert.equal(plain.headers['strict-transport-security'], undefined, '明文连接不得带 HSTS');

    // ⚠️ 对照组：https（nginx 透传 X-Forwarded-Proto $scheme）必须带。
    const tls = await call(base, 'GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(
      tls.headers['strict-transport-security'] || '',
      /max-age=\d+/,
      'https 下必须带 Strict-Transport-Security',
    );

    // ⚠️ 对照组：明文协议头不得触发 HSTS。
    const http = await call(base, 'GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(http.headers['strict-transport-security'], undefined, 'X-Forwarded-Proto: http 不得带 HSTS');
  });
});

test('F28c 不得默认加 Content-Security-Policy（前端视图有内联 style ⇒ CSP 会拦掉页面资源）', async () => {
  // ⚠️ 前提核对：前端视图里确实有内联 style 属性（web/views/landing.js 等）。
  //    这个前提变了（内联样式被清掉）⇒ 必须重新决策 CSP，而不是让这条用例悄悄绿。
  const viewSrc = readFileSync(join(platformDir, 'web', 'views', 'landing.js'), 'utf8');
  assert.match(viewSrc, /style="/, '前提：web/views 里有内联 style 属性（前提变了要重新决策 CSP）');

  await withServer(async ({ base }) => {
    const r = await call(base, 'GET', '/index.html');
    assert.equal(r.status, 200);
    assert.equal(
      r.headers['content-security-policy'],
      undefined,
      '默认不得加 CSP（前端有内联 style，严格 CSP 会把整站搞坏）',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// F20：`GET /api/audit/computations/:id/diff` **会写库** ⇒ 状态变更型 GET
//   缺陷溯源：内部审计报告 §3.5「F20 · Medium · GET .../diff 会写库」
//   现象：复算会写一条 `computation.recompute` 审计日志（services/audit.js 的
//        writeAuditLog）⇒ 它是**有副作用的动作**；而路由注册的是 GET ⇒
//        `SameSite=Lax` 在**顶层 GET 导航**上会带 Cookie（跨站 POST/XHR 才会被挡）
//        ⇒ 该 GET **跨站可达** ⇒ `<img src=".../diff">` 就能以受害者身份
//        写一条审计记录 ⇒ 污染审计日志 ⇒ 破坏「审计日志可信」这个前提。
//   修法（审计建议）：复算改成 **POST**（幂等语义下复算本就不该是 GET）。
//   本用例钉住的口径：
//     ① GET 复算端点**不得写库**（audit_log 行数不变）—— 跨站可达的那条路径；
//     ② 对照组：POST 才是复算入口 ⇒ 真的复算（返回体带 diff）+ 真的留痕。
// ══════════════════════════════════════════════════════════════════
test('F20 复算 diff 只能由 POST 触发（GET 不得写库：audit_log 行数不变）', async () => {
  await withServer(async ({ base, db }) => {
    const { rules } = loadRules(rulesDir);
    const { recordComputation } = await import('../src/services/audit.js');
    const { scoreStage } = await import('../src/domain/scoring.js');

    // ── 夹具：超管 + 会话 + 一份「总分被改过」的计算快照 ──────────────
    const admin = createUser(db, { name: '组委会', phone: '13900001721', password: 'pw' });
    setSuperadmin(db, admin.id);
    const { token } = createSession(db, admin.id);
    const cookie = `hk_session=${token}`;

    const input = {
      configKey: 'scoring.final',
      ruleVersion: `scoring.final@${rules.scoring.final.version}`,
      config: rules.scoring.final,
      judges: [{ judgeId: 'j1', seat: 'judge' }],
      submissions: [{ judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 }],
      enterpriseConfirmations: [],
      peerReviews: [],
    };
    // ⚠️ 快照必须存「真实引擎算出来的结果，只把总分改了」——
    //    拿手写的假输出当快照 ⇒ 复算恒判一致 ⇒ 对照组失去判别性。
    const output = scoreStage({
      config: input.config,
      judges: input.judges,
      submissions: input.submissions,
      enterpriseConfirmations: [],
      peerReviews: [],
    });
    output.teams[0].total = 999;
    const { id } = recordComputation({
      db, kind: 'stage_score', ruleVersion: input.ruleVersion, input, output, trace: {},
    });

    const countAudit = () => db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const before = countAudit();

    // ① GET（跨站可达的那条路径）⇒ 不得触发复算、不得写库
    const get = await call(base, 'GET', `/api/audit/computations/${id}/diff`, { cookie });
    assert.ok(
      get.status === 404 || get.status === 405,
      `GET 必须被明确拒绝（404 无此接口 / 405 方法不允许），实际 ${get.status}：${get.text}`,
    );
    assert.ok(
      !get.text.includes('"identical"') && !get.text.includes('"diff":'),
      `GET 不得返回复算结果（它不是复算入口）：${get.text.slice(0, 200)}`,
    );
    assert.equal(
      countAudit(), before,
      'GET 复算端点之后 audit_log 行数必须不变（GET 不得写库，否则审计日志可被跨站污染）',
    );

    // ② 对照组：POST 才是复算入口 ⇒ 真的复算 + 真的留痕
    const post = await call(base, 'POST', `/api/audit/computations/${id}/diff`, { cookie });
    assert.equal(post.status, 200, `POST 复算端点必须可用（实际 ${post.status}：${post.text}）`);
    const body = JSON.parse(post.text);
    assert.equal(body.identical, false, '快照被改过 ⇒ 复算必须报不一致');
    assert.ok(Array.isArray(body.diff) && body.diff.length > 0, '复算结果必须带 diff');
    assert.ok(Array.isArray(body.warnings), '复算结果必须带 warnings');
    assert.equal(
      countAudit(), before + 1,
      'POST 复算必须留一条审计日志（对照组：复算真的发生了，不是空转）',
    );
    const last = db.prepare('SELECT action FROM audit_log ORDER BY rowid DESC LIMIT 1').get();
    assert.equal(last.action, 'computation.recompute', '新增的那条必须是复算留痕');
  });
});

test('F20b 复算端点不得再以 GET 注册（路由清单里只有 POST）', async () => {
  // ⚠️ 行为闸之外再加一道**结构闸**：路由清单里如果还有 GET 版复算端点，
  //    将来谁再把 handler 挂回 GET ⇒ F20 立刻复发（结构闸先于行为闸报警）。
  const { createApp } = await import('../src/server.js');
  const { openDatabase } = await import('../src/db/sqlite.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f20-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  try {
    const app = createApp({ db, rules, webDir });
    const routes = app.router.list().map((r) => `${r.method} ${r.pattern}`);
    assert.ok(
      routes.includes('POST /api/audit/computations/:id/diff'),
      `复算端点必须注册为 POST，实际路由清单：${routes.filter((r) => r.includes('audit/computations')).join('、')}`,
    );
    assert.ok(
      !routes.includes('GET /api/audit/computations/:id/diff'),
      '复算端点不得再注册 GET（GET 跨站可达 ⇒ 可被 <img> 触发写库）',
    );
    // ⚠️ 对照组：纯读口（取快照本身）**必须仍然是 GET** ——
    //    否则就改错了（读口没有副作用，本来就该是 GET）。
    assert.ok(
      routes.includes('GET /api/audit/computations/:id'),
      '取计算快照仍是只读口 ⇒ 必须保留 GET',
    );
  } finally {
    close();
  }
});

// ══════════════════════════════════════════════════════════════════
// F24：会话**中途** 401 不清 UI（web/api.js 记了 err.status，全站零消费方）
//   缺陷溯源：内部审计报告 §3.5「F24 · Medium · 会话中途 401 不清 UI」
//   现象：会话过期后界面**仍显示为已登录**（顶栏 / 组委会导航区块都在），
//        后续每个读写都变成错误卡片；用户**永远不会**被送回 #/login（只能手工敲 #/logout）。
//   根因：web/api.js:14-18 记下了 err.status，但**全站没有任何消费方**
//        （app.js 没有 401 分支、store.js 没有失效路径、restoreSession 只在启动时跑一次）。
//   修法（本文件钉住的口径）：
//     ① 401 ⇒ 清本地会话态（store.user = null）+ 跳 #/login + 显式标记「会话已失效」；
//     ② **403 = 权限不足 ⇒ 绝不清会话**（清了会把「权限不够」误导成「请重新登录」）；
//     ③ 200 正常路径 ⇒ 绝不清会话、绝不跳登录页；
//     ④ 401 但**口令不对**（INVALID_CREDENTIALS：登录 / 改密）⇒ 不是会话失效 ⇒ 不清、不改文案；
//     ⑤ 访客（本来就没会话）拿到 401 ⇒ 不弹登录页（落地页必须保持公开可用，P9 M6）；
//     ⑥ 登录页必须**明说「会话已过期，请重新登录」**（不能是一张没有解释的空表单）。
// ══════════════════════════════════════════════════════════════════

/**
 * 装一个够 web/api.js 用的最小浏览器环境（fetch + window.location）。
 * @param {{status:number, code?:string, message?:string, body?:any}} resp
 */
function installBrowser({ status, code = '', message = '', body = null }) {
  globalThis.window = { location: { search: '', hash: '' }, addEventListener: () => {} };
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body ?? { error: { code, message } }),
  });
}

/**
 * ⚠️ **全局污染必须还原（2026-10-23 审计 F24 的连带教训）**
 *
 * `installBrowser()` 替换的是**全局** `globalThis.fetch` 与 `globalThis.window`。
 * 如果替换后不还原 ⇒ **本文件后续所有用例**拿到的都是这个浏览器桩：
 *   · 任何走 `fetch` 的用例会拿到桩的固定响应（而不是真实 HTTP）；
 *   · 更危险的是：桩常被设成 **401**，而 **401 也是 4xx**
 *     ⇒ 任何「断言状态码 ∈ 4xx」的扫描类闸门会**假绿**（测的是桩，不是真后端）。
 *
 * ⚠️ 这个坑是**真的踩过**的：F9 的「全写端点扫描」用例一度全部打到这个桩上，
 *   每个探针都回 401 ⇒ 闸门看着是绿的，**实际上一个端点都没真测到**。
 *   ⇒ F9 段改用「模块加载时捕获的真实 fetch」绕开（那一层保险保留），
 *     但**根治**在这里：每个用例跑完立刻把全局还原。
 *
 * ⇒ 还原点在 `afterEach`（不是 `beforeEach`）：
 *   `beforeEach` 只保证「进用例前是干净的」，但**用例体内**装的桩会漏给
 *   **下一个用例的 module 顶层副作用**与本用例之后的断言 ⇒ `afterEach` 才关得严。
 */
const ORIG_FETCH = globalThis.fetch;
const ORIG_WINDOW = globalThis.window;

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  globalThis.window = ORIG_WINDOW;
});

/** 已登录的本地会话态（每个用例自己重置，避免用例之间互相污染）。 */
const F24_USER = { id: 'u_1', name: '甲', phone: '13800000000' };

test('F24 会话中途 401：必须清掉本地会话态 + 跳 #/login + 明说「会话已过期」（修复前 UI 仍显示已登录）', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 401, code: 'UNAUTHENTICATED', message: '未登录' });
  setState({ user: F24_USER, sessionExpired: false });

  await assert.rejects(
    () => api.get('/api/teams'),
    (err) => {
      assert.equal(err.status, 401, '状态码必须原样透出（上层靠它分流）');
      // ⚠️ 不能静默吞掉：服务端的「未登录」用户看不懂，也不知道下一步做什么
      assert.match(err.message, /会话已过期/, `401 的文案必须说清「会话过期了」，实际：${err.message}`);
      assert.match(err.message, /重新登录/, '文案必须带下一步（重新登录）');
      return true;
    },
  );

  assert.equal(getState().user, null, '⛔ 401 必须清掉本地会话态（否则顶栏还显示「已登录」）');
  assert.equal(getState().sessionExpired, true, '「会话已失效」必须变成显式可见的状态');
  assert.equal(globalThis.window.location.hash, '#/login', '⛔ 401 必须回到登录视图（#/login）');
});

test('F24b 403（权限不足）不得清会话态、不得跳登录页（否则把「权限不够」说成「请重新登录」）', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 403, code: 'FORBIDDEN', message: '没有权限' });
  setState({ user: F24_USER, sessionExpired: false });

  await assert.rejects(
    () => api.get('/api/admin/registration'),
    (err) => {
      assert.equal(err.status, 403, '状态码必须原样透出');
      assert.match(err.message, /没有权限/, '403 的文案必须保留服务端原文（业务语义不能被洗掉）');
      assert.doesNotMatch(err.message, /会话已过期/, '⛔ 403 不得被说成「会话已过期」');
      return true;
    },
  );

  assert.equal(getState().user?.id, 'u_1', '⛔ 403 不得清会话态');
  assert.equal(getState().sessionExpired, false, '403 不得把「会话已失效」置起来');
  assert.equal(globalThis.window.location.hash, '', '⛔ 403 不得跳登录页');
});

test('F24c 200 正常路径不得清会话态、不得跳登录页', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 200, body: { items: [] } });
  setState({ user: F24_USER, sessionExpired: false });

  const data = await api.get('/api/teams');
  assert.deepEqual(data, { items: [] }, '正常路径必须原样返回数据');
  assert.equal(getState().user?.id, 'u_1', '⛔ 200 不得清会话态');
  assert.equal(globalThis.window.location.hash, '', '⛔ 200 不得跳登录页');
});

test('F24d 401 但**口令不对**（INVALID_CREDENTIALS）不是会话失效：不得清会话、不得说「会话已过期」', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 401, code: 'INVALID_CREDENTIALS', message: '手机号或密码不正确' });
  setState({ user: null, sessionExpired: false });

  await assert.rejects(
    () => api.post('/api/auth/login', { phone: '13800000000', password: 'wrong' }),
    (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /手机号或密码不正确/, '口令不对必须说口令不对（不能被洗成「会话过期」）');
      assert.doesNotMatch(err.message, /会话已过期/, '⛔ 口令不对不得说成「会话已过期」');
      return true;
    },
  );

  assert.equal(getState().sessionExpired, false, '⛔ 口令不对不得置「会话已失效」');
  assert.equal(globalThis.window.location.hash, '', '⛔ 口令不对不得跳登录页');
});

test('F24e 访客（本来就没会话）拿到 401 不得被弹到登录页（落地页必须保持公开可用）', async () => {
  const { api } = await import('../web/api.js');
  const { getState, setState } = await import('../web/store.js');
  installBrowser({ status: 401, code: 'UNAUTHENTICATED', message: '未登录' });
  setState({ user: null, sessionExpired: false });

  await assert.rejects(() => api.get('/api/teams'), (err) => {
    assert.equal(err.status, 401);
    return true;
  });

  assert.equal(getState().sessionExpired, false, '访客的 401 不是「会话已过期」');
  assert.equal(globalThis.window.location.hash, '', '⛔ 访客不得被弹到登录页（否则落地页废了）');
});

test('F24f 登录页必须显示「会话已过期，请重新登录」（会话没过期时不得显示）', async () => {
  const { renderLogin } = await import('../web/views/login.js');
  // 最小 DOM 桩：够登录视图渲染即可（本用例不点按钮）
  const el = {
    className: '', innerHTML: '', textContent: '', value: '',
    querySelector: () => ({ addEventListener: () => {}, textContent: '', value: '' }),
    addEventListener: () => {},
  };
  globalThis.document = { createElement: () => el };

  const expired = renderLogin({
    api: {}, navigate: () => {}, setState: () => {},
    getState: () => ({ user: null, sessionExpired: true }),
  });
  assert.match(expired.innerHTML, /会话已过期/, '⛔ 登录页必须明说会话已过期');
  assert.match(expired.innerHTML, /重新登录/, '必须给出下一步（重新登录）');

  // ⚠️ 对照组：会话没过期 ⇒ 不得显示这条提示（否则会变成一句永远挂着的话）
  const normal = renderLogin({
    api: {}, navigate: () => {}, setState: () => {},
    getState: () => ({ user: null, sessionExpired: false }),
  });
  assert.doesNotMatch(normal.innerHTML, /会话已过期/, '会话没过期时不得显示「会话已过期」');
});

// ══════════════════════════════════════════════════════════════════
// F21 / F22：演示站与真实后端的**形状漂移**
//   缺陷溯源：内部审计报告 §3.4
//     F21（Medium）演示站名册登记显示「NaN 支队伍」
//     F22（Medium）演示站缺 meta ⇒ 恰好掩盖 F16（Critical）
//
// ⚠️ 为什么这两条只能改**演示站**（web/api.demo.js）：
//    演示站是真实后端的**形状镜像**（每个响应形状都必须与真实后端一致）。
//    形状一旦漂移，演示站就会**掩盖**真实缺陷 —— F16 就是这么被藏住的：
//    真实后端评估后把**档位定义**投影进 meta.solvability，演示站没有 meta ⇒
//    签级表单在演示站上走的是**另一条路径**（规则投影）⇒ F16 压根不复现 ⇒
//    唯一被公开演示、被评审反复检验的环境，恰恰看不到这个 bug。
//    ⇒ 口径基准永远是**真实后端**；演示站照抄。
// ══════════════════════════════════════════════════════════════════

/**
 * 起一个演示站适配器（内存版 localStorage + 演示种子 + 真规则）。
 * ⚠️ 与 demo-api-parity.test.js 的 bootDemo 同一路径（同一个 createDemoApi）。
 */
async function bootDemoApi() {
  const seed = JSON.parse(readFileSync(join(webDir, 'seed', 'demo-data.json'), 'utf8'));
  const { rules } = loadRules(rulesDir);
  const { createDemoApi } = await import('../web/api.demo.js');
  const m = new Map();
  const api = createDemoApi({
    storage: {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    },
    seed,
    rules,
  });
  await api.post('/api/auth/login', { name: '演示管理员' });
  return api;
}

// ── F21 ───────────────────────────────────────────────────────────
test('F21 演示站登记名册：registered/skipped 必须与真实后端同型（数字，不是数组）', async () => {
  // ── 口径基准：真实后端（真库 + 真服务层）──────────────────────────
  // src/services/stage.js:411-415 registerStageTeamRoster ⇒
  //   { registered: 数字, skipped: 数字, teamIds: string[] }
  // 路由 src/http/routes/stages.js:238-243 逐字透传这三个字段。
  const { db, close } = freshDb();
  let real;
  let realAgain;
  try {
    const now = new Date().toISOString();
    const edition = createEdition(db, {
      name: '首届', city: '上海', startsAt: '2026-01-01', endsAt: '2026-12-31', now,
    });
    const captain = createUser(db, { name: '一队队长', phone: '13800001801', password: 'pw', mbaStatus: 'mba' });
    const stage = insertStage(db, {
      editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
      startsAt: '2026-01-01', endsAt: '2026-02-01', scoringConfigKey: 'initial', now,
    });
    const team = insertTeam(db, { editionId: edition.id, name: '一队', captainId: captain.id, now });
    const { registerStageTeamRoster } = await import('../src/services/stage.js');
    real = registerStageTeamRoster({ db, stageId: stage.id, teamIds: [team.id], actorId: null, now });
    // 对照组：重复登记是**幂等**的（第二次 registered=0 / skipped=1）
    realAgain = registerStageTeamRoster({ db, stageId: stage.id, teamIds: [team.id], actorId: null, now });
  } finally { close(); }

  // ── 演示站（同一条请求）──────────────────────────────────────────
  const demo = await bootDemoApi();
  const { stage: demoStage } = await demo.post('/api/editions/ed_demo/stages', {
    key: 's_demo', name: '演示赛段', kind: 'initial', scoringConfigKey: 'initial',
  });
  const demoRes = await demo.post(`/api/stages/${demoStage.id}/teams`, { teamIds: ['t_alpha'] });

  // ① 类型：必须是**数字**（修复前演示站给的是数组 ⇒ Number(["t_alpha"]) = NaN）
  assert.equal(
    typeof demoRes.registered, 'number',
    `演示站 registered 必须是数字，实际 ${JSON.stringify(demoRes.registered)}（数组 ⇒ 前端渲染成裸 NaN）`,
  );
  assert.equal(
    typeof demoRes.skipped, 'number',
    `演示站 skipped 必须是数字，实际 ${JSON.stringify(demoRes.skipped)}`,
  );
  // ② 与真实后端**同值**（不只是同类型）
  assert.equal(demoRes.registered, real.registered, '演示站与真实后端的 registered 必须同值');
  assert.equal(demoRes.skipped, real.skipped, '演示站与真实后端的 skipped 必须同值');
  // ⚠️ teamIds 只比**形状与条数**（两边是各自的数据集，id 值本就不同：真后端是随机 UUID）
  assert.ok(Array.isArray(demoRes.teamIds) && Array.isArray(real.teamIds), 'teamIds 必须是数组');
  assert.equal(demoRes.teamIds.length, real.teamIds.length, '名册条数必须与真实后端一致');
  assert.deepEqual(
    demoRes.teamIds.map((x) => typeof x), real.teamIds.map((x) => typeof x),
    'teamIds 的元素类型必须与真实后端一致（string[]）',
  );
  assert.ok(demoRes.teamIds.includes('t_alpha'), '演示站必须真的把登记的队伍写进名册');
  // ③ 前端读法复现（web/views/stages.js:1227-1228：Number(res?.registered ?? 0)）
  const shown = Number(demoRes?.registered ?? 0);
  assert.ok(Number.isFinite(shown), `前端会把 registered 渲染成「新登记 ${shown} 支队伍」（裸 NaN）`);
  assert.equal(shown, real.registered);
  // ④ 幂等口径也要一致（重复登记 ⇒ registered=0 / skipped=1）
  const demoAgain = await demo.post(`/api/stages/${demoStage.id}/teams`, { teamIds: ['t_alpha'] });
  assert.equal(demoAgain.registered, realAgain.registered, '重复登记的 registered 必须与真实后端同值');
  assert.equal(demoAgain.skipped, realAgain.skipped, '重复登记的 skipped 必须与真实后端同值');
  // ⑤ 对照组：基准本身（真实后端）确实给的是数字
  assert.equal(typeof real.registered, 'number');
  assert.equal(typeof real.skipped, 'number');
});

// ── F22 ───────────────────────────────────────────────────────────
test('F22 演示站任务卡必须带 meta：字段集合与真实后端逐字一致，且能独立撑起签级', async () => {
  // ── 口径基准：真实后端（真库 + 真服务层）──────────────────────────
  // ⚠️ 这里直接调**服务层**（assessSolvability）：它返回的就是 presentTaskPackage(...)，
  //    而路由 src/http/routes/taskPackage.js:41-43 **原样**返回这个结果 ⇒ 形状完全同源。
  //    ⛔ 不用 HTTP：同一个文件里 F24 的用例把 globalThis.fetch 换成了桩且**不还原**
  //    ⇒ 本文件靠后的用例再走 fetch 会打到桩上（这不是本缺陷，是同文件用例的污染）。
  let real;
  {
    const { db, close } = freshDb();
    try {
      const { rules } = loadRules(rulesDir);
      const now = new Date().toISOString();
      db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','首届','上海','2026-01-01','2026-12-31','${now}')`);
      const ent = createUser(db, { name: '甲企业', phone: '13800001811', password: 'pw', org: '甲公司' });
      db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
               VALUES ('tp_f22','ed1','${ent.id}','甲公司','F22 任务卡','p','e','a',0,'${ent.id}','submitted','{}','${now}')`);
      const { assessSolvability } = await import('../src/services/taskPackage.js');
      real = assessSolvability({
        db, taskPackageId: 'tp_f22', answers: SOLVABILITY_FULL, actorId: ent.id, now, rules,
      });
    } finally { close(); }
  }

  // ── 演示站（同一条请求）──────────────────────────────────────────
  const demo = await bootDemoApi();
  const demoRes = await demo.post('/api/task-packages/tp_demo_assess/solvability', {
    answers: SOLVABILITY_FULL,
  });

  // ① 任务卡**顶层字段集合**必须与真实后端逐字一致（修复前演示站少一个 meta）
  assert.deepEqual(
    Object.keys(demoRes).sort(),
    Object.keys(real).sort(),
    '演示站与真实后端的任务卡字段集合必须逐字一致（含 meta）',
  );
  assert.ok(demoRes.meta && typeof demoRes.meta === 'object', '演示站的任务卡必须带 meta（对象）');
  // ② meta.solvability 的字段集合必须与真实后端逐字一致
  assert.ok(demoRes.meta.solvability, '演示站的 meta 必须带 solvability');
  assert.deepEqual(
    Object.keys(demoRes.meta.solvability).sort(),
    Object.keys(real.meta.solvability).sort(),
    '演示站与真实后端的 meta.solvability 字段集合必须逐字一致',
  );
  // ③ **档位定义**与**否决项定义**必须一并投影出来（F16 的病根就在这两处）
  assert.deepEqual(
    Object.keys(demoRes.meta.solvability.grades?.[0] ?? {}).sort(),
    Object.keys(real.meta.solvability.grades?.[0] ?? {}).sort(),
    '档位定义的字段集合必须与真实后端逐字一致（key/minScore/maxScore/commitment/agreement）',
  );
  assert.deepEqual(
    Object.keys(demoRes.meta.solvability.vetoesSpec?.[0] ?? {}).sort(),
    Object.keys(real.meta.solvability.vetoesSpec?.[0] ?? {}).sort(),
    '否决项定义的字段集合必须与真实后端逐字一致（key/label/auto）',
  );
  assert.equal(
    demoRes.meta.solvability.grades?.length, real.meta.solvability.grades?.length,
    '档位数量必须与真实后端一致',
  );
  assert.equal(
    demoRes.meta.solvability.vetoesSpec?.length, real.meta.solvability.vetoesSpec?.length,
    '否决项数量必须与真实后端一致',
  );
  // ④ F16 在演示站上**同样可复现、同样被覆盖**：
  //    只喂演示站自己的响应（**不给规则**）⇒ 也必须能撑起完整的签级档位。
  const { solvabilitySpecFromPackages, gradeTiers } = await import(join(webDir, 'views', 'admin-task-packages.js'));
  const demoSpec = solvabilitySpecFromPackages([demoRes]);
  assert.ok(demoSpec, '演示站的任务卡必须能投影出评估规格');
  assert.equal(
    gradeTiers(demoSpec).complete, true,
    '演示站评估过一次任务卡后签级档位必须就绪（F16 在演示站同样可复现）',
  );
  // 对照组：真实后端同样成立（证明基准不是「随手编的」）
  assert.equal(
    gradeTiers(solvabilitySpecFromPackages([real])).complete, true,
    '对照组：真实后端评估后签级档位必须就绪',
  );
});

// ══════════════════════════════════════════════════════════════════
// 第 9 批（E175）：数据 / 事务类 3 条 —— F23 / F25 / F26
//   F23 提交签字可写两条（双击 ⇒ 两条不可见但有效的签字）
//   F25 幂等键不绑定操作 ⇒ 静默重放（同 requestId 换内容）
//   F26 review-state.js 全程无事务（状态迁移与申诉行不同生共死）
// ══════════════════════════════════════════════════════════════════

// ═══ F23：同一里程碑的同一企业只允许一条有效签字 ═══
test('F23 同一里程碑重复提交签字必须被拒（不得写出第二条不可见但有效的签字）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-sg-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'signoff:create', '企业里程碑签字');
    const seat = createUser(db, { name: '企业席', phone: '13800001801', password: 'pw', org: '某公司' });
    grantAssignment(db, {
      userId: seat.id, capability: 'signoff:create', scopeType: 'global', scopeId: null, grantedBy: null,
    });
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed9','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,status,created_at) VALUES ('t9','ed9','九队','${seat.id}','active','${now}')`);
    db.exec(`INSERT INTO team_members (id,team_id,user_id,role,joined_at) VALUES ('tm9','t9','${seat.id}','captain','${now}')`);
    db.exec(`INSERT INTO milestones (id,team_id,key,label,counts_toward_tier,requires_signoff,fixed_at,created_at)
             VALUES ('ms9','t9','problem_confirmed','企业问题确认',1,1,'${now}','${now}')`);

    const { createSignoff } = await import('../src/services/milestone.js');
    const body = { department: '业务部门', content: '确认已落地' };
    const first = createSignoff({ db, milestoneId: 'ms9', actorId: seat.id, body, now, rules });
    assert.ok(first?.id, '第一次签字必须成功');

    // 第二次（模拟双击 / 失败后重试）⇒ 必须被拒
    let err = null;
    try {
      createSignoff({ db, milestoneId: 'ms9', actorId: seat.id, body, now, rules });
    } catch (e) { err = e; }
    assert.ok(err, '重复提交签字必须被拒（修复前会写出第二条不可见但有效的签字）');
    assert.equal(err.status, 409, `期望 409，实际 ${err.status}：${err.message}`);

    const rows = db.prepare('SELECT * FROM milestone_signoffs WHERE milestone_id = ?').all('ms9');
    assert.equal(rows.length, 1, `签字表里必须有且只有一行，实际 ${rows.length}`);

    // 判别性②：**数据库层**也要挡住（绕过服务层直接插 ⇒ 唯一索引必须拒绝）
    assert.throws(
      () => db.prepare(`INSERT INTO milestone_signoffs (id, milestone_id, enterprise_id, signatory_user_id, department, content, signed_at, revoked_at)
                        VALUES ('sg_dup','ms9',?,?,'业务部门','内容',?,NULL)`).run(seat.id, seat.id, now),
      /UNIQUE constraint failed/,
      '数据库必须挡住重复的有效签字（服务层的「先查再插」在并发下挡不住）',
    );

    // 判别性③：撤回之后**允许**重新签（签字是只增不改 + 软删除的语义）
    db.prepare('UPDATE milestone_signoffs SET revoked_at = ? WHERE id = ?').run(now, first.id);
    const again = createSignoff({ db, milestoneId: 'ms9', actorId: seat.id, body, now, rules });
    assert.ok(again?.id, '撤回之后必须允许重新签（否则「撤回」这个功能就废了）');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══ F25：幂等键必须绑定操作内容 ═══
test('F25 同一个 requestId 换了内容必须 409（不许静默重放首次的响应）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-idem-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const now = new Date().toISOString();
  try {
    const { withIdempotency } = await import('../src/services/idempotency.js');
    let called = 0;
    const run = (payload) => withIdempotency({
      db, key: 'req-1', scope: 'appeal:u_1', requestId: 'req-1', payload, now,
    }, () => {
      called += 1;
      return { ok: true, echo: payload };
    });

    const first = run({ reason: '第一次的理由' });
    assert.equal(first.replayed, false);
    assert.equal(called, 1);

    // 判别性①：**同样内容**重放 ⇒ 返回首次响应（幂等的本职，必须仍然成立）
    const same = run({ reason: '第一次的理由' });
    assert.equal(same.replayed, true, '同样内容重放必须仍然返回首次响应（幂等的本职）');
    assert.equal(called, 1, '重放不得再执行业务函数');

    // 判别性②：**换了内容** ⇒ 必须 409（修复前会静默返回首次的响应）
    let err = null;
    try {
      run({ reason: '换了个理由' });
    } catch (e) { err = e; }
    assert.ok(err, '同一个 requestId 换内容必须被拒（修复前静默重放，第二次从未提交）');
    assert.equal(err.status, 409, `期望 409，实际 ${err.status}：${err.message}`);
    assert.equal(err.code, 'REQUEST_ID_REUSED', `错误码必须是 REQUEST_ID_REUSED，实际 ${err.code}`);
    assert.equal(called, 1, '被拒的重放不得执行业务函数');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ═══ F26：复核状态的写路径必须在事务里 ═══
test('F26 裁决申诉失败时状态迁移必须一起回滚（审计日志就是状态源）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-rs-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    insertCapability(db, 'appeal:write', '提交申诉');
    insertCapability(db, 'audit:write', '裁决申诉');
    const decider = createUser(db, { name: '裁决人', phone: '13800001811', password: 'pw' });
    setSuperadmin(db, decider.id);

    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed9','首届','上海','2026-01-01','2026-12-31','${now}')`);
    db.exec(`INSERT INTO appeals (id,subject_type,subject_id,filed_by,reason,status,created_at)
             VALUES ('ap9','team_result','st9:t9',?, '我不服','submitted','${now}')`.replace('?', `'${decider.id}'`));

    // ⚠️ 让最后一步（更新申诉行）失败 ⇒ 前面写的**状态迁移**必须一起回滚。
    //    理由：**审计日志就是状态源**（`findLatestTransition` 从 audit_log 读当前状态）
    //    ⇒ 若状态迁移已提交而申诉行没更新 ⇒ 主体实际已是「已复核」（分数被隐藏），
    //    却**没有任何裁决记录** ⇒ 数据自相矛盾。
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON appeals BEGIN SELECT RAISE(ABORT, 'boom'); END;`);

    const { decideAppeal } = await import('../src/services/review-state.js');
    const before = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    let err = null;
    try {
      decideAppeal({ db, appealId: 'ap9', decision: 'rejected', decidedBy: decider.id, note: '不成立', now, rules });
    } catch (e) { err = e; }
    assert.ok(err, '裁决必须失败（触发器让更新申诉行抛错）');
    const after = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    assert.equal(after, before, '裁决失败时状态迁移必须一起回滚（审计日志行数不得增加）');
    const appeal = db.prepare('SELECT status FROM appeals WHERE id = ?').get('ap9');
    assert.equal(appeal.status, 'submitted', '申诉行必须仍是提交态');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// F9：写端点的错误语义必须统一
//   缺陷溯源：内部审计报告 §3.4「F9 · Medium · 写端点错误语义不一致」
//   验收原文：「补一条断言：所有写端点在『资源不存在』时统一回 404/400，
//             **没有一个**把 SQLite 原文漏到响应体。」
//
// ⚠️ 本节把「全写路由 FK 扫描」从一次性的人工动作升级成**常驻机器闸**：
//    ① 扫描表覆盖**每一个已注册的写路由**（漏一个 ⇒ 用例失败，见 F9b）；
//    ② 每个写路由都**真的发一次请求**，引用一个**不存在的 id**（见 F9）；
//    ③ 断言状态码是 4xx，且响应体不含 SQLite 原文。
//
// ⚠️ 为什么必须「合法父资源 + 不存在的子 id」也扫一遍：
//    只测「路径里的 id 不存在」会**漏掉真正的外键漏网点** ——
//    外键目标常常是**请求体里的子 id**（enterpriseId / taskPackageId / teamId …），
//    只有父资源合法时，写库才会真的走到 INSERT ⇒ 才会撞外键 ⇒ 才会 500。
//    （实测命中：`POST /api/stages/:stageId/enterprise-confirmations` 传一个
//      不存在的 enterpriseId ⇒ 直接 INSERT ⇒ `FOREIGN KEY constraint failed` ⇒ 500。）
// ══════════════════════════════════════════════════════════════════

/** 扫描用的「不存在的 id」。 */
const F9_NE = 'no-such-id-zzz';

/**
 * ⚠️ **F9 的探针必须用「模块加载时」捕获的真实 fetch**。
 *
 * 原因：**同一个文件里 F24 的用例把 `globalThis.fetch` 换成了浏览器桩，而且不还原**
 *    （文件里 F22 的用例注释已写明这个污染：「F24 的用例把 globalThis.fetch 换成了桩且不还原
 *    ⇒ 本文件靠后的用例再走 fetch 会打到桩上」）。
 * ⇒ F9 的用例排在 F24 之后 ⇒ 直接用 `globalThis.fetch` 会打到桩上：
 *    桩没有 `headers`、也没有真会话 ⇒ 每个探针都回 401（401 也是 4xx ⇒ 闸门会**假绿**）。
 * ⇒ 在**模块加载时**捕获一次真实 fetch（那时桩还没装）⇒ 与污染隔离，且不改动 F24 的用例。
 */
const F9_REAL_FETCH = globalThis.fetch.bind(globalThis);

/**
 * F9 专用服务器：比通用 withServer 多给一个 router（要用它枚举已注册的写路由）。
 */
async function withF9Server(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f9-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, db, router: app.router });
  } finally {
    await new Promise((r) => server.close(r));
    close();
  }
}

/**
 * F9 夹具：一整套**合法**的资源 + 一个超管会话。
 *
 * ⚠️ 为什么要超管：闸门要的是「请求能走到**写库那一步**」，
 *    权限闸门挡在前面的话，探针只会测到 403，测不到外键。
 */
async function seedF9Fixture(db) {
  // ⚠️ 动态 import：不去动文件顶部的 import 块（同一个文件上还有别的 worker 在改）。
  const { insertTeamMember } = await import('../src/db/repo/teamMembers.js');
  const { registerStageTeams } = await import('../src/db/repo/stage-teams.js');
  const { insertMilestones } = await import('../src/db/repo/tiers.js');
  const { insertWorkflow, insertWorkflowTask } = await import('../src/db/repo/workflows.js');
  const { insertTiebreakRound } = await import('../src/db/repo/tiebreak.js');

  const now = new Date().toISOString();
  const admin = createUser(db, { name: '甲', phone: '13900009901', password: 'pw' });
  setSuperadmin(db, admin.id);
  insertCapability(db, 'task_package:read', '读任务卡');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'admin', 'task_package:read');
  insertUserRole(db, admin.id, 'admin');
  const { token } = createSession(db, admin.id);

  // ⚠️ 登出类端点会**吊销会话** ⇒ 单独给「一次性账号」，
  //    免得它把扫描用的主会话打死（后面的探针就全变成 401，闸门会假绿）。
  //    ⚠️ 每个登出端点要**各自**的一次性账号：logout 先吊销了会话，
  //    同一个账号再打 logout-all 就只剩 401 了（那是夹具的锅，不是生产代码的）。
  const throwawayTokens = [];
  for (const [i, phone] of ['13900009902', '13900009903'].entries()) {
    const throwaway = createUser(db, { name: `乙${i}`, phone, password: 'pw' });
    const { token } = createSession(db, throwaway.id);
    throwawayTokens.push(token);
  }

  const edition = createEdition(db, {
    name: '2026 届', city: '上海', startsAt: '2026-01-01', endsAt: '2026-12-31', now,
  });
  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: admin.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now,
  });
  const team = insertTeam(db, {
    editionId: edition.id, name: '甲队', captainId: admin.id, taskPackageId: pkg.id, now,
  });
  insertTeamMember(db, { teamId: team.id, userId: admin.id, role: 'captain', now });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '赛段一', kind: 'judge',
    startsAt: '2026-02-01', endsAt: '2026-03-01', scoringConfigKey: 'initial', now,
  });
  assignStageJudge(db, { stageId: stage.id, userId: admin.id, seat: 'judge', now });
  registerStageTeams(db, { stageId: stage.id, teamIds: [team.id], now });
  insertMilestones(db, {
    teamId: team.id, items: [{ key: 'm1', label: '里程碑', countsTowardTier: true }], now,
  });
  const milestoneId = db.prepare('SELECT id FROM milestones WHERE team_id = ?').get(team.id).id;
  const wf = insertWorkflow(db, {
    editionId: edition.id, taskPackageId: pkg.id, name: '工作流', now,
  });
  const wfTask = insertWorkflowTask(db, {
    workflowId: wf.id, title: '任务', detail: null, ownerTeamId: team.id,
    status: 'todo', dueAt: null, now,
  });
  const round = insertTiebreakRound(db, {
    stageId: stage.id, kind: 'statement', tiedTeamIds: [team.id],
    statementDeadline: '2026-03-02T00:00:00.000Z', createdBy: admin.id, now,
  });
  return {
    admin, token, throwawayTokens, edition, pkg, team, stage, milestoneId, wf, wfTask, round,
  };
}

/**
 * F9 扫描表：**每一个**已注册的写路由都要有一条探针。
 *
 * ⚠️ `pattern` 必须与路由注册时的 pattern **逐字相同**（F9b 会拿它对账）。
 * ⚠️ `expect: 200` 只给「**不引用任何资源 id**」的端点（登出类）——
 *    它们没有「资源不存在」这回事，只能断言「不 5xx、不漏原文」。
 */
function f9ProbeTable(fx) {
  const { edition, team, stage, milestoneId, wf, wfTask, round } = fx;
  return [
    // ── ① 路径里的 id 不存在（外键目标在路径上）────────────────────────
    { pattern: '/api/workflows', method: 'POST', path: '/api/workflows', body: { editionId: F9_NE, taskPackageId: F9_NE, name: 'W' } },
    { pattern: '/api/workflows/:id/tasks', method: 'POST', path: `/api/workflows/${F9_NE}/tasks`, body: { title: 'T' } },
    { pattern: '/api/tasks/:id/claim', method: 'POST', path: `/api/tasks/${F9_NE}/claim`, body: {} },
    { pattern: '/api/tasks/:id/release', method: 'POST', path: `/api/tasks/${F9_NE}/release` },
    { pattern: '/api/tasks/:id/complete', method: 'POST', path: `/api/tasks/${F9_NE}/complete`, body: { evidence: { kind: 'runnable', note: 'x' } } },
    { pattern: '/api/editions/:editionId/stages', method: 'POST', path: `/api/editions/${F9_NE}/stages`, body: { key: 'k', name: 'n', kind: 'judge', startsAt: '2026-01-01', endsAt: '2026-02-01', scoringConfigKey: 'initial' } },
    { pattern: '/api/stages/:stageId', method: 'PATCH', path: `/api/stages/${F9_NE}`, body: { name: 'n' } },
    { pattern: '/api/stages/:stageId/judges', method: 'POST', path: `/api/stages/${F9_NE}/judges`, body: { userId: F9_NE, seat: 'judge' } },
    { pattern: '/api/stages/:stageId/judges/:userId', method: 'DELETE', path: `/api/stages/${F9_NE}/judges/${F9_NE}` },
    { pattern: '/api/stages/:stageId/teams', method: 'POST', path: `/api/stages/${F9_NE}/teams`, body: { teamIds: [F9_NE] } },
    { pattern: '/api/stages/:stageId/teams/:teamId', method: 'DELETE', path: `/api/stages/${F9_NE}/teams/${F9_NE}` },
    { pattern: '/api/stages/:stageId/publish', method: 'POST', path: `/api/stages/${F9_NE}/publish` },
    { pattern: '/api/milestones/:id/signoff', method: 'POST', path: `/api/milestones/${F9_NE}/signoff`, body: { department: '业务部门', content: 'x' } },
    { pattern: '/api/milestones/:id/signoff/withdraw', method: 'POST', path: `/api/milestones/${F9_NE}/signoff/withdraw`, body: { signoffId: F9_NE } },
    { pattern: '/api/audit/computations/:id/diff', method: 'POST', path: `/api/audit/computations/${F9_NE}/diff` },
    { pattern: '/api/audit/flags/:id/resolve', method: 'POST', path: `/api/audit/flags/${F9_NE}/resolve`, body: { status: 'confirmed', reason: '已核实' } },
    { pattern: '/api/appeals', method: 'POST', path: '/api/appeals', body: { subjectId: `${stage.id}:${F9_NE}`, reason: '我不服' } },
    { pattern: '/api/appeals/:id/decide', method: 'POST', path: `/api/appeals/${F9_NE}/decide`, body: { decision: 'accepted', note: '成立' } },
    { pattern: '/api/teams/:id/behavior-events', method: 'POST', path: `/api/teams/${F9_NE}/behavior-events`, body: { type: 'weekly_progress', evidence: { note: 'x' } } },
    { pattern: '/api/pools/sync', method: 'POST', path: '/api/pools/sync', body: { editionId: F9_NE } },
    // 管理端点（2026-10-24 评审轮新增）：登录限频的人工解锁
    // ⚠️ 探测用**普通用户**的会话 ⇒ 期望 403（无 audit:write）
    { pattern: '/api/admin/login-unlock', method: 'POST', path: '/api/admin/login-unlock', body: { phone: F9_NE }, tag: '管理端点：解锁不存在的手机号' },
    { pattern: '/api/registrations', method: 'POST', path: '/api/registrations', body: { editionId: F9_NE, answers: {} } },
    { pattern: '/api/registrations/:id/level', method: 'POST', path: `/api/registrations/${F9_NE}/level`, body: { level: 'A' } },
    { pattern: '/api/stages/:stageId/tiebreak/rounds', method: 'POST', path: `/api/stages/${F9_NE}/tiebreak/rounds`, body: { tiedTeamIds: [F9_NE, 'other'] } },
    { pattern: '/api/tiebreak/rounds/:roundId/votes', method: 'POST', path: `/api/tiebreak/rounds/${F9_NE}/votes`, body: { teamId: F9_NE, score: 80 } },
    { pattern: '/api/tiebreak/rounds/:roundId/close', method: 'POST', path: `/api/tiebreak/rounds/${F9_NE}/close` },
    { pattern: '/api/public/tokens', method: 'POST', path: '/api/public/tokens', body: { editionId: F9_NE, scope: 'all' } },
    { pattern: '/api/public/tokens/:id', method: 'DELETE', path: `/api/public/tokens/${F9_NE}` },
    { pattern: '/api/teams', method: 'POST', path: '/api/teams', body: { editionId: F9_NE, taskPackageId: F9_NE, name: '乙队' } },
    { pattern: '/api/teams/:id/members', method: 'POST', path: `/api/teams/${F9_NE}/members`, body: { action: 'add' } },
    { pattern: '/api/teams/:id', method: 'PATCH', path: `/api/teams/${F9_NE}`, body: { name: '乙队' } },
    { pattern: '/api/stages/:stageId/reviews', method: 'POST', path: `/api/stages/${F9_NE}/reviews`, body: { items: [] } },
    { pattern: '/api/stages/:stageId/calibration', method: 'POST', path: `/api/stages/${F9_NE}/calibration`, body: { items: [] } },
    { pattern: '/api/stages/:stageId/peer-reviews', method: 'POST', path: `/api/stages/${F9_NE}/peer-reviews`, body: { items: [] } },
    { pattern: '/api/stages/:stageId/self-review', method: 'POST', path: `/api/stages/${F9_NE}/self-review`, body: { teamId: F9_NE, items: [] } },
    { pattern: '/api/stages/:stageId/enterprise-confirmations', method: 'POST', path: `/api/stages/${F9_NE}/enterprise-confirmations`, body: { teamId: F9_NE, dimension: 'enterprise', rawScore: 80, content: 'x' } },
    { pattern: '/api/stages/:stageId/enterprise-confirmations/:id/withdraw', method: 'POST', path: `/api/stages/${F9_NE}/enterprise-confirmations/${F9_NE}/withdraw` },
    { pattern: '/api/stages/:stageId/enterprise-confirmations/:id/resign', method: 'POST', path: `/api/stages/${F9_NE}/enterprise-confirmations/${F9_NE}/resign`, body: { rawScore: 90 } },
    { pattern: '/api/stages/:stageId/recusals', method: 'POST', path: `/api/stages/${F9_NE}/recusals`, body: { judgeId: F9_NE, teamId: F9_NE, reason: 'x' } },
    { pattern: '/api/stages/:stageId/compute', method: 'POST', path: `/api/stages/${F9_NE}/compute` },
    { pattern: '/api/task-packages', method: 'POST', path: '/api/task-packages', body: { editionId: F9_NE, title: 'x', mix: {} } },
    { pattern: '/api/task-packages/:id/solvability', method: 'POST', path: `/api/task-packages/${F9_NE}/solvability`, body: { answers: {} } },
    { pattern: '/api/task-packages/:id/approve', method: 'POST', path: `/api/task-packages/${F9_NE}/approve`, body: { grade: 'A' } },

    // ── ② 父资源合法、**请求体里的子 id** 不存在（真正的外键漏网点）──
    { pattern: '/api/stages/:stageId/judges', method: 'POST', path: `/api/stages/${stage.id}/judges`, body: { userId: F9_NE, seat: 'judge' }, tag: '子 id：评委' },
    { pattern: '/api/stages/:stageId/teams', method: 'POST', path: `/api/stages/${stage.id}/teams`, body: { teamIds: [F9_NE] }, tag: '子 id：名册队伍' },
    { pattern: '/api/stages/:stageId/reviews', method: 'POST', path: `/api/stages/${stage.id}/reviews`, body: { items: [{ teamId: F9_NE, dimension: 'track_fit', rawScore: 80 }] }, tag: '子 id：被打分队伍' },
    { pattern: '/api/stages/:stageId/peer-reviews', method: 'POST', path: `/api/stages/${stage.id}/peer-reviews`, body: { items: [{ fromTeamId: team.id, toTeamId: F9_NE, score: 80 }] }, tag: '子 id：被评队' },
    { pattern: '/api/stages/:stageId/enterprise-confirmations', method: 'POST', path: `/api/stages/${stage.id}/enterprise-confirmations`, body: { teamId: team.id, enterpriseId: F9_NE, dimension: 'enterprise', rawScore: 80, content: 'x' }, tag: '子 id：出题企业' },
    { pattern: '/api/stages/:stageId/recusals', method: 'POST', path: `/api/stages/${stage.id}/recusals`, body: { judgeId: fx.admin.id, teamId: F9_NE, reason: 'x' }, tag: '子 id：回避队伍' },
    { pattern: '/api/tiebreak/rounds/:roundId/votes', method: 'POST', path: `/api/tiebreak/rounds/${round.id}/votes`, body: { teamId: F9_NE, score: 80 }, tag: '子 id：被投票队伍' },
    { pattern: '/api/workflows/:id/tasks', method: 'POST', path: `/api/workflows/${wf.id}/tasks`, body: { title: 'T', ownerTeamId: F9_NE }, tag: '子 id：承接队' },
    { pattern: '/api/tasks/:id/claim', method: 'POST', path: `/api/tasks/${wfTask.id}/claim`, body: { teamId: F9_NE }, tag: '子 id：领取队' },
    { pattern: '/api/teams', method: 'POST', path: '/api/teams', body: { editionId: edition.id, taskPackageId: F9_NE, name: '乙队' }, tag: '子 id：任务包' },
    { pattern: '/api/teams/:id', method: 'PATCH', path: `/api/teams/${team.id}`, body: { taskPackageId: F9_NE }, tag: '子 id：任务包' },
    { pattern: '/api/stages/:stageId/tiebreak/rounds', method: 'POST', path: `/api/stages/${stage.id}/tiebreak/rounds`, body: { tiedTeamIds: [team.id, F9_NE] }, tag: '子 id：同分组队伍' },
    { pattern: '/api/milestones/:id/signoff/withdraw', method: 'POST', path: `/api/milestones/${milestoneId}/signoff/withdraw`, body: { signoffId: F9_NE }, tag: '子 id：签字' },

    // ── ③ 不引用资源 id 的写端点（登出 / 改口令）─────────────────────
    //    ⚠️ 这几个没有「资源不存在」这回事 ⇒ 断言口径是「不 5xx、不漏原文」。
    { pattern: '/api/auth/login', method: 'POST', path: '/api/auth/login', body: { phone: F9_NE, password: 'x' }, noCookie: true, allow401: true },
    { pattern: '/api/auth/password', method: 'POST', path: '/api/auth/password', body: { oldPassword: 'wrong', newPassword: 'x' }, allow401: true },
    { pattern: '/api/auth/logout', method: 'POST', path: '/api/auth/logout', expect: 200, throwaway: 0 },
    { pattern: '/api/auth/logout-all', method: 'POST', path: '/api/auth/logout-all', expect: 200, throwaway: 1 },
  ];
}

/** 一次探针 ⇒ 一次真实请求。 */
async function f9Probe(base, cookie, probe) {
  const headers = {};
  if (!probe.noCookie) headers.Cookie = cookie;
  if (probe.body !== undefined) headers['Content-Type'] = 'application/json';
  // ⚠️ 用 F9_REAL_FETCH 而不是 globalThis.fetch（见它的注释：F24 的桩不还原）。
  const res = await F9_REAL_FETCH(base + probe.path, {
    method: probe.method, headers,
    body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
  });
  return { status: res.status, text: await res.text() };
}

/** 探针的断言：状态码 + 「不得漏 SQLite 原文」。 */
function assertF9Probe(probe, r) {
  const label = `${probe.method} ${probe.pattern}${probe.tag ? `（${probe.tag}）` : ''}`;
  if (probe.expect === 200) {
    assert.equal(r.status, 200, `${label} 期望 200，实际 ${r.status}：${r.text}`);
  } else {
    assert.ok(
      r.status >= 400 && r.status < 500,
      `${label} 引用不存在的 id 必须回 4xx（404/400/403/409），实际 ${r.status}：${r.text}`,
    );
  }
  // ⚠️ **防假绿**：401 也是 4xx ⇒ 「会话失效」会让每个探针都回 401，扫描就**假绿**了。
  //    ⇒ 带会话的探针一律**不许**回 401（真会话下，写端点没有理由说「你没登录」）。
  if (!probe.allow401) {
    assert.notEqual(r.status, 401, `${label} 回了 401（会话失效 ⇒ 扫描假绿）：${r.text}`);
  }
  assert.doesNotMatch(
    r.text,
    /SQLITE|constraint failed|FOREIGN KEY|NOT NULL|UNIQUE/i,
    `${label} 把数据库原文漏到了响应体：${r.text}`,
  );
}

test('F9 全写端点扫描：引用不存在的 id 一律 4xx，且没有一个漏 SQLite 原文', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    // ⚠️ **先验会话是活的**（防假绿的第一道闸）：
    //    401 也是 4xx ⇒ 若会话失效（例如本文件 F24 的用例换了 globalThis.fetch 且不还原），
    //    每个探针都会回 401，扫描会**假绿**。⇒ 先断言「我确实是登录态」。
    const me = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'GET', path: '/api/me',
    });
    assert.equal(me.status, 200, `扫描用的会话必须是登录态（否则扫描假绿）：${me.text}`);
    const probes = f9ProbeTable(fx);
    for (const probe of probes) {
      const cookie = probe.throwaway !== undefined
        ? `hk_session=${fx.throwawayTokens[probe.throwaway]}`
        : `hk_session=${fx.token}`;
      const r = await f9Probe(base, cookie, probe);
      assertF9Probe(probe, r);
    }
  });
});

test('F9b 写端点扫描表必须覆盖全部已注册的写路由（新增写端点必须补进扫描表）', async () => {
  await withF9Server(async ({ db, router }) => {
    const fx = await seedF9Fixture(db);
    const covered = new Set(f9ProbeTable(fx).map((p) => `${p.method} ${p.pattern}`));
    const registered = router.list()
      .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))
      .map((r) => `${r.method} ${r.pattern}`);
    const missing = registered.filter((k) => !covered.has(k));
    assert.deepEqual(
      missing, [],
      `新增的写端点必须补进 F9 扫描表（否则它就没人管）：${missing.join('、')}`,
    );
    const stale = [...covered].filter((k) => !registered.includes(k));
    assert.deepEqual(stale, [], `F9 扫描表里有已不存在的路由：${stale.join('、')}`);
  });
});

test('F9c 企业确认引用不存在的出题企业必须 404（修复前是 500：FOREIGN KEY constraint failed）', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    const body = {
      teamId: fx.team.id, enterpriseId: F9_NE,
      dimension: 'enterprise', rawScore: 80, content: '我方已投入产品负责人',
    };
    const r = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST', path: `/api/stages/${fx.stage.id}/enterprise-confirmations`, body,
    });
    // 修复前：enterprise_id 外键 ⇒ `FOREIGN KEY constraint failed` ⇒ 500
    assert.notEqual(r.status, 500, `外键错误漏成 500：${r.text}`);
    assert.equal(r.status, 404, `不存在的出题企业必须是 404，实际 ${r.status}：${r.text}`);
    assert.match(r.text, /USER_NOT_FOUND/, `错误码必须是 USER_NOT_FOUND：${r.text}`);
    assert.doesNotMatch(r.text, /constraint failed|SQLITE/i, `不得漏数据库原文：${r.text}`);
  });
});

test('F9d 三池同步引用不存在的届期必须 404（修复前是 200：假装同步了一个不存在的届期）', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    const r = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST', path: '/api/pools/sync', body: { editionId: F9_NE },
    });
    // 修复前：同步 0 行、回 200 —— 与其它写端点（404 EDITION_NOT_FOUND）口径不一致
    assert.equal(r.status, 404, `不存在的届期必须是 404，实际 ${r.status}：${r.text}`);
    assert.match(r.text, /EDITION_NOT_FOUND/, `错误码必须是 EDITION_NOT_FOUND：${r.text}`);
  });
});

test('F9e 对照组：合法的写请求仍然成功（不得把 F9 修成「一律 404」）', async () => {
  await withF9Server(async ({ base, db }) => {
    const fx = await seedF9Fixture(db);
    // ① 企业确认：合法的出题企业（= 自己）⇒ 必须落库成功
    const ok = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST',
      path: `/api/stages/${fx.stage.id}/enterprise-confirmations`,
      body: {
        teamId: fx.team.id, enterpriseId: fx.admin.id,
        dimension: 'enterprise', rawScore: 80, content: '我方已投入产品负责人',
      },
    });
    assert.equal(ok.status, 200, `合法的企业确认必须成功：${ok.text}`);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM enterprise_confirmations').get().n;
    assert.equal(rows, 1, '合法的企业确认必须真的落库（不得被「存在性校验」误杀）');

    // ② 三池同步：合法的届期 ⇒ 必须同步成功
    const sync = await f9Probe(base, `hk_session=${fx.token}`, {
      method: 'POST', path: '/api/pools/sync', body: { editionId: fx.edition.id },
    });
    assert.equal(sync.status, 200, `合法的三池同步必须成功：${sync.text}`);
  });
});

// ══════════════════════════════════════════════════════════════════
// F48：can() 与 scopeClause() 的「超管形状」不一致（2026-10-23 审计 §3.5）
//
//   现象：can() 信任**传入对象**的超管标志（is_superadmin === 1 || isSuperadmin === true），
//         scopeClause() 只查**库**（EXISTS (SELECT 1 FROM users su WHERE su.id = ? AND su.is_superadmin = 1)）
//         ⇒ 两者可能给出**相反**结论。
//   本批修法（不碰既有契约）：
//     ① 对外形状（toPublicUser）**同时**带 is_superadmin 与 isSuperadmin
//        ⇒ 只认一种形状的服务层（tier / performance-card / workflow / milestone）
//          拿到对外形状时也能认到超管 ⇒ 全仓「形状不一致」的点一次消掉；
//     ② 把「已知取舍」写清楚并钉住（can() 信任传入对象 / scopeClause() 只信库；
//        生产链路上 ctx.user 永远是库里的行 ⇒ 两者必然一致）；
//     ③ 机器闸：**同一个真实用户**（库里分别是超管 / 非超管），
//        can() 与 scopeClause() 的结论必须**永远一致**（三种传入形状都测）。
//
//   ⚠️ 契约溯源：INTERFACES.md:22「判定只有 can(user, capability, ctx, db) 一个入口。
//      SQL 层过滤用 scopeClause(...) —— 两者**必须给出相同结论**」。
// ══════════════════════════════════════════════════════════════════

/** F48 专用能力点：**谁都没有**（无角色、无授权）
 *  ⇒ can() / scopeClause() 的结论只可能由「超管标志」决定 ⇒ 这条断言是判别性的：
 *    恒真实现（永远放行）与恒假实现（永远拒绝）都会红。 */
const F48_CAP = 'audit:read';

test('F48 can() 与 scopeClause() 对同一个真实用户的超管判定必须永远一致（库行 / 对外形状 / 纯驼峰）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f48-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  try {
    insertCapability(db, F48_CAP, 'F48 用：谁都没有的能力点');
    // 假资源表：用来**真跑** scopeClause 生成的 SQL（断言不是恒真）
    db.exec('CREATE TABLE fake_resources (id TEXT PRIMARY KEY, title TEXT)');
    db.exec("INSERT INTO fake_resources (id, title) VALUES ('r1', '资源一')");

    const superadmin = createUser(db, { name: '超管', phone: '13800008001', password: 'pw' });
    setSuperadmin(db, superadmin.id);
    const normal = createUser(db, { name: '普通用户', phone: '13800008002', password: 'pw' });

    /** scopeClause 生成的片段真跑 SQL ⇒ 这个用户能不能看见这一行 */
    const scopeVisible = (userId) => {
      const { sql, params } = scopeClause(userId, F48_CAP, { scopeType: 'team', alias: 't' });
      return db.prepare('SELECT t.id FROM fake_resources t WHERE ' + sql).all(...params).length > 0;
    };

    for (const [label, user] of [['超管', superadmin], ['非超管', normal]]) {
      const row = getUserById(db, user.id);      // 库行形状（snake_case，生产链路 ctx.user 就是它）
      const pub = toPublicUser(row);             // 对外形状（camelCase + 蛇形，产出点已统一）
      // 纯驼峰形状（手搓、**不带** is_superadmin）：can() 必须照样认得出来
      const camel = { id: user.id, isSuperadmin: row.is_superadmin === 1, active: row.active === 1 };
      for (const [shapeName, shape] of [['库行', row], ['对外形状', pub], ['纯驼峰', camel]]) {
        const viaCan = can(shape, F48_CAP, null, db);
        const viaScope = scopeVisible(user.id);
        assert.equal(
          viaCan,
          viaScope,
          `${label}（${shapeName}）：can()=${viaCan} 与 scopeClause()=${viaScope} 必须一致`
          + '｜契约：INTERFACES.md:22「判定只有 can() 一个入口，SQL 层过滤用 scopeClause(...) —— 两者必须给出相同结论」',
        );
      }
    }

    // 判别性对照：这个能力点谁都没有 ⇒ 非超管必须**两边都判否**
    //（恒真实现会因为这一条变红；恒假实现会因为上面「超管」那几条变红）
    assert.equal(
      can(getUserById(db, normal.id), F48_CAP, null, db), false,
      '没有角色也没有授权 ⇒ can() 必须判否',
    );
    assert.equal(
      scopeVisible(normal.id), false,
      '没有角色也没有授权 ⇒ scopeClause 必须过滤掉这一行',
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F48b 对外形状必须同时带 is_superadmin 与 isSuperadmin（只认一种形状的服务层会让超管静默降级）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f48b-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    const admin = createUser(db, { name: '超管', phone: '13800008011', password: 'pw' });
    setSuperadmin(db, admin.id);
    const normal = createUser(db, { name: '普通用户', phone: '13800008012', password: 'pw' });
    const edition = createEdition(db, {
      name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now,
    });
    // 一支**没有段位记录**的队伍 ⇒ 默认 D 段 ⇒ D 段不公示（rules/visibility.json: rank.publicFromTier='C'）
    // ⇒ 非成员、非超管看不到它（404）⇒ 能看到它的只有「成员」与「超管」。
    const team = insertTeam(db, {
      editionId: edition.id, name: '一队', captainId: admin.id, status: 'active', now,
    });

    const adminPub = toPublicUser(getUserById(db, admin.id));
    const normalPub = toPublicUser(getUserById(db, normal.id));

    // ① 对外形状必须**同时**带两种键（服务层 tier/workflow/performance-card/milestone 只认 is_superadmin === 1）
    assert.equal(adminPub.is_superadmin, 1, '对外形状必须带 is_superadmin（服务层只认这一种）');
    assert.equal(adminPub.isSuperadmin, true, '对外形状必须带 isSuperadmin（can() 认这一种）');
    // 对照组：非超管两个键都必须是「假」——不得一律给 1（否则等于人人超管）
    assert.equal(normalPub.is_superadmin, 0, '非超管的 is_superadmin 必须是 0');
    assert.equal(normalPub.isSuperadmin, false, '非超管的 isSuperadmin 必须是 false');

    // ② 服务层真的能认出「对外形状」的超管（修复前：对外形状没有 is_superadmin ⇒ 404 ⇒ 超管静默降级）
    const { getTeamTier } = await import('../src/services/tier.js');
    const tier = getTeamTier({ db, teamId: team.id, viewer: adminPub, rules });
    assert.equal(tier.teamId, team.id, '超管的对外形状必须能读到 D 段队伍（修复前是 404）');
    // 对照组：非超管的对外形状仍然看不到 D 段队伍（不得把闸门拆了）
    assert.throws(
      () => getTeamTier({ db, teamId: team.id, viewer: normalPub, rules }),
      (err) => err?.status === 404,
      '非超管看不到 D 段队伍（必须仍回 404）',
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// F47：同分互投率检测（R-RNK-08）**永远拿不到数据** ⇒ 规则写在纸上，链路是死的
//
//   现象：R-RNK-08「同分队伍互投率过高 ⇒ 组委会复核」这条规则**永远不可能触发**。
//   根因：detectTiedMutualPeerRate 需要两样东西 —— **最终名次**（同分组）与**互投的队伍对**；
//         而全站唯一的生产调用点（src/services/compute.js）在**计算期**传的是 results: []
//         （名次是发榜时破同分链跑完才有的）⇒ 这条检测永远拿不到数据。
//   修法：发榜时（名次已落库）**再跑一次**检测：
//         ① 名次来自 stage_results.rank（发榜回写，F7）；
//         ② 互评数据来自 peer_reviews（队 → 队）。
//
//   ⚠️ **互评数据在本仓的真实存储位置**（取证结论，不要凭印象）：
//     · 互评**只**存在 `peer_reviews` 表（db/migrations/003_review.sql:132）：
//       stage_id / from_team_id / to_team_id / score / request_id / created_at；
//     · `stage_reviews`（评委打分表）**没有 seat 列** ⇒「stage_reviews 里 seat='peer' 那一路」
//       在本仓**不存在**；本仓的「互评」是**队 → 队**的行为（from_team_id → to_team_id）。
// ══════════════════════════════════════════════════════════════════

/**
 * 造一个 F47 用的赛段：两支队 + 一名评委 + 若干互评。
 * @param {number} scoreA A 队评委分
 * @param {number} scoreB B 队评委分（与 A 相同 ⇒ 两队同分）
 * @param {boolean} withPeerReviews 是否写入互评（A↔B 互投，且**两个方向同分**
 *   ——破同分链的「互评分」这一级也分不开 ⇒ 两队仍然并列）
 */
function seedF47Stage(db, { now, scoreA, scoreB, withPeerReviews = true }) {
  db.exec(`INSERT INTO users (id,name,phone,password_hash,mba_status,org,is_superadmin,active,created_at) VALUES ('u1','U','13800009001','x','mba',NULL,1,1,'${now}')`);
  db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at) VALUES ('ed1','E','上海','2026-01-01','2026-12-31','${now}')`);
  db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,status,starts_at,ends_at,scoring_config_key) VALUES ('st1','ed1','s1','S1','initial','open','2026-01-01','2026-02-01','initial')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_a','ed1','A队','u1','${now}')`);
  db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,created_at) VALUES ('tm_b','ed1','B队','u1','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s1','st1','tm_a','${now}')`);
  db.exec(`INSERT INTO stage_team (id,stage_id,team_id,registered_at) VALUES ('s2','st1','tm_b','${now}')`);
  db.exec(`INSERT INTO stage_judges (stage_id,user_id,seat,scope_type,scope_id,assigned_at) VALUES ('st1','u1','judge','global',NULL,'${now}')`);
  for (const [team, score] of [['tm_a', scoreA], ['tm_b', scoreB]]) {
    for (const dim of ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']) {
      db.prepare(`INSERT INTO stage_reviews (id,stage_id,judge_id,team_id,dimension,raw_score,request_id,calibrated,submitted_at) VALUES (?,?,?,?,?,?,?,0,?)`)
        .run(`r_${team}_${dim}`, 'st1', 'u1', team, dim, score, `req_${team}_${dim}`, now);
    }
  }
  if (withPeerReviews) {
    insertPeerReview(db, { stageId: 'st1', fromTeamId: 'tm_a', toTeamId: 'tm_b', score: 90, requestId: 'pr_ab', now });
    insertPeerReview(db, { stageId: 'st1', fromTeamId: 'tm_b', toTeamId: 'tm_a', score: 90, requestId: 'pr_ba', now });
  }
}

/** F47 专用：算完 + 发榜（走**真实服务层**，不是 mock） */
async function computeAndPublishF47(db, rules, now) {
  const { computeStage } = await import('../src/services/compute.js');
  const { publishLeaderboard } = await import('../src/services/leaderboard.js');
  computeStage({ db, stageId: 'st1', actorId: 'u1', now, rules });
  return publishLeaderboard({ db, editionId: 'ed1', stageId: 'st1', actorId: 'u1', now, rules });
}

test('F47 发榜后「同分互投率过高」必须真的检出并进复核队列（R-RNK-08 不得是死规则）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f47-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    seedF47Stage(db, { now, scoreA: 80, scoreB: 80 });   // 两队同分
    await computeAndPublishF47(db, rules, now);

    // 前提（判别性）：两队确实并列，且名次已落库（发榜回写，F7）
    const results = db.prepare('SELECT team_id, rank FROM stage_results WHERE stage_id = ? ORDER BY team_id').all('st1');
    assert.equal(results.length, 2, '应有 2 行赛段结果');
    assert.equal(results[0].rank, results[1].rank, '两队必须同分（名次相同）——否则这条检测本来就不该触发');

    // 修复前：发榜后仍然**一条 flag 都没有**（检测永远拿不到名次 ⇒ 规则是死的）
    const flags = db.prepare("SELECT kind, team_id, detail_json FROM flagged_reviews WHERE kind = 'tied_mutual_peer_rate'").all();
    assert.equal(flags.length, 1, '同分队伍互投率 100% ≥ 阈值 0.8 ⇒ 必须检出并进人工复核队列');
    const detail = JSON.parse(flags[0].detail_json);
    assert.equal(detail.rank, results[0].rank, '告警明细必须带上名次（说明检测真的拿到了名次）');
    assert.equal(detail.rate, 1, '互投率必须是 1（1 组候选对、1 组互投）');
    assert.deepEqual(detail.tiedPairs, [['tm_a', 'tm_b']], '告警明细必须指出是哪两支队互投');
    assert.equal(detail.action, 'alert_only', '检测 ≠ 处罚：只告警，不改分、不封号');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F47b 对照组：两队**不同分**时，即使互投也不得报「同分互投率」（否则这条检测毫无判别力）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f47b-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    seedF47Stage(db, { now, scoreA: 90, scoreB: 70 });   // 两队不同分 ⇒ 名次不同 ⇒ 不构成「同分队伍」
    await computeAndPublishF47(db, rules, now);
    const n = db.prepare("SELECT COUNT(*) AS n FROM flagged_reviews WHERE kind = 'tied_mutual_peer_rate'").get().n;
    assert.equal(n, 0, '不同分的两队不构成「同分队伍互投」⇒ 不得告警（否则这条检测对谁都报）');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F47c 对照组：两队同分但**没有互投**时不得报「同分互投率」（告警必须来自真实互评数据）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-f47c-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const now = new Date().toISOString();
  try {
    seedF47Stage(db, { now, scoreA: 80, scoreB: 80, withPeerReviews: false });
    await computeAndPublishF47(db, rules, now);
    const n = db.prepare("SELECT COUNT(*) AS n FROM flagged_reviews WHERE kind = 'tied_mutual_peer_rate'").get().n;
    assert.equal(n, 0, '没有互投记录 ⇒ 不得凭空报「互投率过高」');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 第 11 批（2026-10-24 独立评审轮）：评审提出的「登录限频定向 DoS」
//
// ⚠️⚠️ **复核结论与评审说的不一样（这是本批最重要的产出）**：
//   评审原话：「登录限频按手机号 60s/10 次锁定，知道评委手机号的人
//              可以在打分窗口把他锁在门外。」
//   ⇒ **复核后判定：该后果不成立**。原因：限频判定**只在口令校验失败的分支里**
//     执行（src/server.js 的登录路由：`if (!ok) { assertRateLimit(...); throw 401; }`）
//     ⇒ **受害者只要输对口令，登录永远不会被挡**。
//     ⇒ 「正确口令永远能登录」是一条**必须保住的不变量** —— 它正是对
//        「账号被锁死」的根本防护（限频只罚失败，不罚成功）。
//
//   ⇒ **但真正的问题在隔壁**：限频判定发生在 **scrypt 之后**
//     ⇒ **被限流的请求照样跑一遍 scrypt** ⇒ 限频只把 401 换成 429，
//     **挡不住 CPU 打爆**（⇒ 这才是真实的 DoS 面：打的是**服务器**，不是账号）。
//     ⇒ 修法：① **只读预检前置**（来源维度，判定在 scrypt 之前
//              ⇒ 被挡请求**不跑 scrypt**）；② 补「来源」维度的独立配额；
//             ③ 应急出口：管理员可**整体解除**登录限频（限频误伤整个出口时）。
//
//   ⇒ 本批用例必须钉住：**①** 正确口令永远能登录（不变量）
//     **②** 来源被判定为攻击源后连正确口令也挡（预检前置 + fail-closed）
//     **③** 枚举安全（存在与不存在的号在同一处触顶）
//     **④** 管理员应急出口可用且留痕。
// ══════════════════════════════════════════════════════════════════

/** 用指定「来源 IP」打一次登录（X-Real-IP 由同机 nginx **覆盖**写入 ⇒ 可信）。 */
async function loginFrom(base, { phone, password, ip }) {
  return call(base, 'POST', '/api/auth/login', {
    body: { phone, password },
    headers: ip ? { 'X-Real-IP': ip } : {},
  });
}

// ═══ R1：不变量 —— 账号配额被耗光后，正确口令仍必须能登录 ═══
// ⚠️ 这是本批的**核心钉子**：它同时**证伪**评审的「把受害者锁在门外」，
//    并**锁住**「正确口令永远能登录」这条防护。
//    判别性：实现若改成「配额也管成功登录」，本条立刻红。
test('R1 账号配额被耗光后，正确口令仍必须能登录（限频只罚失败、不罚成功）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '评委', phone: '13800009901', password: 'right-pw' });
    // 用**多个来源**打满该手机号的账号配额（10 次/60s）
    for (const ip of ['10.0.3.1', '10.0.3.2', '10.0.3.3']) {
      for (let i = 0; i < 4; i += 1) {
        await loginFrom(base, { phone: '13800009901', password: 'wrong-pw', ip });
      }
    }
    const ok = await loginFrom(base, { phone: '13800009901', password: 'right-pw', ip: '10.0.3.9' });
    assert.equal(
      ok.status, 200,
      `正确口令被挡了（返回 ${ok.status}）—— 这条不变量是防「账号被锁死」的根本防护；`
      + ' 限频必须只罚失败、不罚成功',
    );
  });
});

// ═══ R2：对照组 —— 正常误输不得误伤 ═══
test('R2 正常误输几次后必须仍能登录（来源配额不能误伤正常用户）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '组员', phone: '13800009902', password: 'right-pw' });
    for (let i = 0; i < 3; i += 1) {
      const r = await loginFrom(base, { phone: '13800009902', password: 'wrong-pw', ip: '10.0.1.1' });
      assert.equal(r.status, 401, '口令错就是 401（⛔ 不是 429 —— 3 次误输不该触发任何配额）');
    }
    const ok = await loginFrom(base, { phone: '13800009902', password: 'right-pw', ip: '10.0.1.1' });
    assert.equal(ok.status, 200, '误输 3 次后必须仍能正常登录');
  });
});

// ═══ R3：枚举安全 —— 「账号存在」与「账号不存在」必须在同一处触顶 ═══
// ⚠️ 这是**否决评审第二条建议**（「存在与否分开计数」）的理由的机器钉子：
//    若分开计数，攻击者拿不存在的号试到 429、拿真实号还拿到 401 ⇒ 可枚举已注册手机号。
test('R3 登录限频不得泄露手机号是否已注册（存在与不存在的号必须在同一处触顶）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '真实用户', phone: '13800009903', password: 'right-pw' });

    const first429 = async (phone, ip) => {
      for (let i = 0; i < 40; i += 1) {
        const r = await loginFrom(base, { phone, password: 'wrong-pw', ip });
        if (r.status === 429) return i + 1;
      }
      return -1;
    };
    const missing = await first429('13800000000', '10.0.2.1');   // 不存在的号
    const exists = await first429('13800009903', '10.0.2.2');   // 存在的号
    assert.ok(missing > 0 && exists > 0, '两边都必须在某处触顶 429');
    assert.equal(
      missing, exists,
      `「账号不存在」第 ${missing} 次触顶、「账号存在」第 ${exists} 次触顶 ⇒ 两者时机不同 ⇒ 可被用来枚举已注册手机号`,
    );
  });
});

// ═══ R4：来源维度的预检必须**前置**（判定在 scrypt 之前）═══
// ⚠️ 这条钉的是**真问题**：原实现里限频判定在 scrypt **之后**
//    ⇒ 被限流的请求照样跑一遍 scrypt ⇒ 挡不住 CPU 打爆。
//    ⇒ 修后：来源被判定为攻击源 ⇒ **连正确口令也 429**（预检在前 ⇒ 不跑 scrypt）。
//    ⚠️ 判别性：若把预检挪回 scrypt 之后，本条会红（正确口令会 200）。
test('R4 来源被判定为攻击源后必须直接 429（预检必须前置到 scrypt 之前）', async () => {
  await withServer(async ({ base, db }) => {
    createUser(db, { name: '评委', phone: '13800009904', password: 'right-pw' });
    // 把来源 10.0.4.1 打成攻击源（sliding 20/60s）
    let got429 = false;
    for (let i = 0; i < 30; i += 1) {
      const r = await loginFrom(base, { phone: '13800009904', password: 'wrong-pw', ip: '10.0.4.1' });
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, '来源配额必须能触发（否则来源维度没生效）');
    // ⚠️ 连**正确口令**也必须 429 —— 这证明预检在 scrypt 之前（否则会 200）
    const ok = await loginFrom(base, { phone: '13800009904', password: 'right-pw', ip: '10.0.4.1' });
    assert.equal(
      ok.status, 429,
      `正确口令居然能登录（返回 ${ok.status}）⇒ 预检不在 scrypt 之前 ⇒ `
      + '被限流的请求照样跑 scrypt ⇒ 挡不住 CPU 打爆',
    );
    assert.ok(ok.headers['retry-after'], '429 必须带 Retry-After（⛔ 不静默丢包）');
  });
});

// ═══ R5：管理员应急出口 —— 整体解除登录限频 + 权限 + 留痕 ═══
// ⚠️ 为什么必须有它：来源预检是 fail-closed 的 ⇒ 共享出口 IP（办公室/校园网）
//    一旦被误判 ⇒ **整个出口的人都被挡**（含正确口令）⇒ 必须有人能立刻解除。
test('R5 管理员可整体解除登录限频；非管理员 403、未登录 401、且必须留痕', async () => {
  await withServer(async ({ base, db }) => {
    const admin = createUser(db, { name: '组委会', phone: '13800009905', password: 'admin-pw' });
    insertRole(db, 'admin', '组委会');
    insertCapability(db, 'audit:write', '裁决复核项与申诉');
    insertRoleCapability(db, 'admin', 'audit:write');
    insertUserRole(db, admin.id, 'admin');
    const member = createUser(db, { name: '组员', phone: '13800009906', password: 'member-pw' });
    insertRole(db, 'member', '组员');
    insertUserRole(db, member.id, 'member');
    createUser(db, { name: '评委', phone: '13800009907', password: 'right-pw' });

    // ① 把来源打成攻击源
    for (let i = 0; i < 30; i += 1) {
      const r = await loginFrom(base, { phone: '13800009907', password: 'wrong-pw', ip: '10.0.5.1' });
      if (r.status === 429) break;
    }
    const blocked = await loginFrom(base, { phone: '13800009907', password: 'right-pw', ip: '10.0.5.1' });
    assert.equal(blocked.status, 429, '此刻该来源应当被挡');

    // ② 未登录 ⇒ 401；③ 非组委会 ⇒ 403
    const anon = await call(base, 'POST', '/api/admin/login-unlock', { body: { all: true } });
    assert.equal(anon.status, 401, '未登录解除限频必须 401');
    const memberSession = createSession(db, member.id);
    const asMember = await call(base, 'POST', '/api/admin/login-unlock', {
      body: { all: true }, cookie: `hk_session=${memberSession.token}`,
    });
    assert.equal(asMember.status, 403, '非组委会不得解除限频（⛔ 否则限频等于没有）');

    // ④ 组委会整体解除 ⇒ 该来源立刻恢复
    const adminSession = createSession(db, admin.id);
    const cleared = await call(base, 'POST', '/api/admin/login-unlock', {
      body: { all: true }, cookie: `hk_session=${adminSession.token}`,
    });
    assert.equal(cleared.status, 200, '组委会必须能整体解除登录限频');
    const after = await loginFrom(base, { phone: '13800009907', password: 'right-pw', ip: '10.0.5.1' });
    assert.equal(after.status, 200, '解除后必须立刻能登录（应急出口的意义就在这里）');

    // ⑤ 必须留痕（人工干预安全闸 ⇒ 谁、何时、解除范围）
    const rows = db.prepare('SELECT * FROM audit_log WHERE action = ?').all('auth.login_limit_clear_all');
    assert.equal(rows.length, 1, '解除限频必须写审计日志');
    assert.equal(rows[0].actor_id, admin.id, '审计日志必须记下操作人');
  });
});
```


### 4.6 Task 5 —— 第 9 批新建的两个文件（F23 / F25）

**Step 4/5 的文件清单**：

| 文件 | 为什么必须是**新文件** |
|---|---|
| `platform/db/migrations/007_p13_defect_fixes.sql` | F23（签字唯一约束）与 F25（幂等键加摘要列）都是**数据库层**的约束补强 ⇒ 必须走迁移（不能靠应用层「先查再插」——并发下挡不住） |
| `platform/src/domain/canonical-json.js` | F25 的请求体摘要要用**键名排序**的稳定序列化，而这份口径原本是 `src/services/anticheat.js` 的**内部函数** ⇒ 复制一份就是「同一口径写两份 ⇒ 必然漂移」⇒ 抽成领域层的**纯函数**（⛔ 不 import 任何 Node 内置模块） |

**Step 5: 创建 db/migrations/007_p13_defect_fixes.sql**

`platform/db/migrations/007_p13_defect_fixes.sql`：

```sql
-- 007_p13_defect_fixes.sql —— P13 缺陷修复的**约束补强**（2026-10-24）
--
-- 依据：2026-10-23 全量审计
--   · F25（Medium）幂等键**不绑定操作** ⇒ 同一个 requestId 换内容再提交，
--     返回**第一次**的响应，第二次申诉**从未提交**，而客户端被告知「成功」。
--   · F23（Medium）提交签字**可写两条** ⇒ 双击「提交签字」或失败后重试，
--     同一 (milestone, enterprise) 产生两条记录：工作台只看得见一条，
--     另一条**不可见但有效**，而 `revokeSignoff` 按单条 id 撤销 ⇒ 撤了可见的那条，另一条还在。
--
-- ⚠️ 这两条都属于「**数据库层是唯一保证**」的范畴：
--    服务层的「先查再插」在并发下挡不住两个同时通过的请求（两边都读到「不存在」）。
--    ⇒ 唯一约束必须落在数据库上。

-- ── ① F25：幂等键表加「请求体摘要」列 ──────────────────────────────
-- ⚠️ 为什么需要摘要：幂等键的 scope 是**调用方**（`appeal:${user.id}`）而不是**操作**，
--    且原来**没有任何请求体指纹** ⇒ 同一个 requestId 换了内容，命中的是同一条记录
--    ⇒ 直接返回首次响应（= 静默丢弃第二次的真实意图）。
--    ⇒ 加一列摘要 ⇒ 重放时比对，不一致就 409（口径与 P2 的 `assertSameRequestContent` 一致）。
--    ⚠️ 旧数据没有摘要（NULL）⇒ **不做比对**（不把历史记录误判成冲突）。
ALTER TABLE idempotency_keys ADD COLUMN request_digest TEXT;

-- ── ② F23：同一 (milestone_id, enterprise_id) 只允许一条**未撤回**的签字 ──
-- ⚠️ 为什么是**部分唯一索引**（`WHERE revoked_at IS NULL`）：签字是**只增不改**的
--    （撤回走 revoked_at 软删除）⇒ 被撤回之后**允许重新签**（这是产品语义，不是漏洞）
--    ⇒ 全表唯一索引会把合法的「撤回后重签」也挡掉。
--
-- ⚠️ 迁移前先处理**既有的重复行**：同一 (milestone, enterprise) 有多条未撤回签字时，
--    保留**最早**的那条（按 signed_at，再按 id 确定性打破），其余**标记为已撤回**
--    （= 作废，但**保留痕迹**，不物理删除 —— 签字表是审计留痕）。
--    ⇒ 不这么做，下面的唯一索引建不出来（迁移会直接失败 ⇒ 部署起不来）。
UPDATE milestone_signoffs
   SET revoked_at = signed_at
 WHERE revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM milestone_signoffs x
      WHERE x.milestone_id = milestone_signoffs.milestone_id
        AND x.enterprise_id = milestone_signoffs.enterprise_id
        AND x.revoked_at IS NULL
        AND (x.signed_at < milestone_signoffs.signed_at
             OR (x.signed_at = milestone_signoffs.signed_at AND x.id < milestone_signoffs.id))
   );

CREATE UNIQUE INDEX ux_milestone_signoffs_active
  ON milestone_signoffs(milestone_id, enterprise_id)
 WHERE revoked_at IS NULL;
```

**Step 6: 创建 src/domain/canonical-json.js**

`platform/src/domain/canonical-json.js`：

```javascript
// src/domain/canonical-json.js — 稳定序列化（键名排序）
//
// 依据：2026-10-23 审计 F25（幂等键不绑定操作）—— 重放时要比对「请求体是不是同一份」，
//   而 JSON.stringify 的键顺序取决于**构造顺序** ⇒ 等价内容、不同键序会被判成不同
//   ⇒ 必须用**键名排序**的稳定序列化。
//
// ⛔ **纯函数**：无 IO、无 Date.now()、无 Math.random()、**不 import 任何 Node 内置模块**
//    （领域层的硬约束）。
//
// ⚠️ **为什么抽成独立文件**：这段口径原先在 `src/services/anticheat.js` 里是**内部函数**
//    （用来判断两份 flag 明细是不是「同一个问题」）。幂等摘要要的是**同一口径**
//    ⇒ 复制一份就是「同一口径写两份 ⇒ 必然漂移」（本仓反复踩的坑）。
//    ⇒ 抽到这里，两边共用同一个实现。
//
// 语义与 `src/services/anticheat.js` 原实现**逐字一致**（迁移时未改行为）：
//   数组保序；对象的键**排序**后递归；其余走 JSON.stringify（undefined → 'null'）。

/**
 * 稳定序列化（键名排序）。
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
```

**Step 7: 创建 src/http/security-headers.js**

（第 10 批 F27 / F28：安全响应头与 CORS 策略的**单一来源** —— 头在**每个响应出口**（respond / static / sse / server）显式合并，不靠隐式 setHeader。）

`platform/src/http/security-headers.js`：

```javascript
// src/http/security-headers.js — 安全响应头 + CORS 策略（响应的**统一出口**）
//
// 规则溯源：
//   ① 缺陷报告 2026-10-23 §3.5「F28 · Low · 完全没有安全响应头」
//      （内部审计报告:1676-1704）——
//      验收口径原文：「所有响应都带 X-Content-Type-Options: nosniff 与 X-Frame-Options」。
//      修法原文：「在 respond.js / static.js 的统一出口加一组默认安全头」。
//   ② 缺陷报告 §3.5「F27 · Low · HEAD/OPTIONS 全部 404，无 CORS」（:1637-1671）——
//      修法 ③ 原文：「CORS 是否要**开**是产品决策（目前刻意不开）」⇒ 默认关闭 + 可配置开启。
//   ③ 「https 判定读 X-Forwarded-Proto」—— nginx 模板已透传该头
//      （deploy/nginx-tls-port.conf:113、deploy/nginx.conf:110、deploy/nginx-plain-http.conf:80），
//      且 test/deploy-tls-port.test.js:171 明写「必须透传 X-Forwarded-Proto（https 下应用要读它）」。
//
// ⚠️ **刻意不加 Content-Security-Policy**：
//    前端视图（web/views/*.js）里有**内联 style 属性**（例：web/views/landing.js:398
//    `style="--share:${…}"`）⇒ 严格 CSP（style-src 不带 'unsafe-inline'）会把整站样式拦掉。
//    ⇒ 点击劫持改用 X-Frame-Options 挡（不依赖 CSP）。
//    这条前提由 test/audit-findings.test.js 的「F28c」用例钉住：
//    将来谁想加 CSP，必须先处理内联样式（并改那条用例），不许悄悄加。
//
// ⚠️ 为什么**按请求**读环境变量、而不是模块加载时读一次：
//    一个进程里可能起多个 app 实例（测试里每个用例都起一个），
//    模块级缓存会让「上一个用例改过的配置」漏到下一个用例 ⇒ 假绿/假红。
//    每次请求读一次 env 的成本可以忽略，换来的是「配置与请求一一对应、结果确定」。

/** 基础安全头：与请求无关 ⇒ 任何响应都带（API / 静态页 / 404 / SSE 一视同仁）。 */
const BASE_SECURITY_HEADERS = {
  // 禁止浏览器猜内容类型（防 MIME 嗅探型 XSS）。
  'X-Content-Type-Options': 'nosniff',
  // 跨站跳转时不泄露完整 URL（只保留 origin）。
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // 防点击劫持：管理后台 SPA 不允许被任何页面内嵌（本仓全仓无 iframe 用法）。
  'X-Frame-Options': 'DENY',
};

/** HSTS 默认 max-age：180 天（1 年太激进 —— 将来要退回明文服务时会被浏览器锁死）。 */
const DEFAULT_HSTS_MAX_AGE = 15552000;

/** CORS 预检允许的请求头（默认只有 Content-Type —— 本仓前端只用 JSON + Cookie）。 */
const DEFAULT_CORS_ALLOW_HEADERS = 'Content-Type';

/** CORS 预检结果缓存秒数（默认 10 分钟）。 */
const DEFAULT_CORS_MAX_AGE = 600;

/** 读一个环境变量并去空白（未设 ⇒ 空串）。 */
function envValue(name) {
  const raw = process.env[name];
  return raw === undefined ? '' : String(raw).trim();
}

/**
 * 这条请求是不是 https。
 *
 * ① 直连 TLS（Node 自己终止 TLS）：socket.encrypted === true；
 * ② 反代终止 TLS：nginx 透传 `X-Forwarded-Proto $scheme` ⇒ 值为 https。
 *
 * ⚠️ X-Forwarded-Proto 是**客户端可伪造**的头（见 services/rate-limit.js:18 的同款提醒）。
 *    但这里被伪造的后果仅限于「明文响应上多一个 HSTS 头」——
 *    浏览器按 RFC 6797 §7.2 会**忽略**明文传输收到的 HSTS ⇒ 不构成风险。
 *    生产部署里 Node 只绑 127.0.0.1（src/server.js:636），外部根本够不到这个端口。
 */
function isSecureRequest(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted === true) return true;
  const raw = req.headers && req.headers['x-forwarded-proto'];
  // 代理链上可能是 "https,http" ⇒ 只看第一段（最靠近客户端的那一跳）。
  const first = String(raw || '').split(',')[0].trim().toLowerCase();
  return first === 'https';
}

/**
 * HSTS 的 max-age。
 * `HSTS_MAX_AGE=0` ⇒ 关闭；非法值 ⇒ 按默认（失败即安全：宁可开着）。
 */
function hstsMaxAge() {
  const raw = envValue('HSTS_MAX_AGE');
  if (raw === '') return DEFAULT_HSTS_MAX_AGE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HSTS_MAX_AGE;
  return Math.floor(n);
}

/**
 * CORS 允许的来源白名单。
 * 未设 / 空 ⇒ **关闭跨域**（一个 Access-Control-* 头都不给 ⇒ 与修复前完全一致）；
 * `*` ⇒ 允许任意来源；
 * 否则逗号分隔的**精确匹配**列表。
 *
 * ⚠️ `*` 与「带凭据的跨源请求」**互斥**（浏览器规定：带凭据时不允许 `*`，
 *    必须回具体来源 + `Access-Control-Allow-Credentials: true`）。
 *    本仓前端用 `credentials: 'same-origin'`（web/api.js）⇒ 同源请求不受影响；
 *    真要开带凭据的跨源，请填**具体来源**而不是 `*`。
 */
function allowedOrigins() {
  const raw = envValue('CORS_ALLOW_ORIGIN');
  if (!raw) return [];
  if (raw === '*') return ['*'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 简单请求（以及预检）的 CORS 头。
 * ⚠️ 白名单外的来源**一个头都不给**（由浏览器自己拦）—— 不做「先放行再说」。
 */
function corsHeaders(req) {
  const origins = allowedOrigins();
  if (!origins.length) return {}; // CORS 关闭
  const origin = String((req && req.headers && req.headers.origin) || '');
  if (!origin) return {}; // 同源请求不需要 CORS 头
  if (origins.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (!origins.includes(origin)) return {}; // 不在白名单
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/**
 * 常规响应头（安全头 + CORS 头）。
 * 调用方：src/http/respond.js（json/text）、src/http/static.js（200/304）、
 *        src/http/sse.js（SSE 流）、src/server.js（204 / OPTIONS）。
 */
export function responseHeaders(req) {
  const headers = { ...BASE_SECURITY_HEADERS };
  const maxAge = hstsMaxAge();
  // ⚠️ HSTS **只在 https 下**给：明文连接上发 HSTS 是误导（浏览器也会忽略它）。
  if (maxAge > 0 && isSecureRequest(req)) {
    headers['Strict-Transport-Security'] = `max-age=${maxAge}`;
  }
  return { ...headers, ...corsHeaders(req) };
}

/**
 * 预检（OPTIONS）专用的 CORS 头。
 * ⚠️ CORS 关闭时返回空对象 ⇒ 预检响应里一个 Access-Control-* 头都没有
 *    （与「刻意不开跨域」的产品决策一致）。
 */
export function corsPreflightHeaders(req, allowMethods) {
  const base = corsHeaders(req);
  if (!Object.keys(base).length) return {};
  const allowHeaders = envValue('CORS_ALLOW_HEADERS') || DEFAULT_CORS_ALLOW_HEADERS;
  const rawMaxAge = envValue('CORS_MAX_AGE');
  const parsed = rawMaxAge === '' ? DEFAULT_CORS_MAX_AGE : Number(rawMaxAge);
  const maxAge = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_CORS_MAX_AGE;
  return {
    ...base,
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': String(maxAge),
  };
}
```


---

### 4.7 2026-10-24 独立评审轮 —— 新建文件登记

本轮（2026-10-24 独立评审，20 条清单核实后 17 条属实）新建了以下文件。
按本仓纪律「**新建文件必须登记进计划块，否则它的漂移查不出来**」，逐个登记如下
（`plan-block-audit.mjs` 的归因靠「Step 标题里的路径」+「块首行的文件头注释」两个信号，
两者都不命中 ⇒ 这个文件对它完全不可见）。

| 文件 | 为什么必须是**新文件** |
|---|---|
| `platform/src/http/routes/admin.js` | 管理员「解除登录限频」需要一条**带审计留痕**的 HTTP 写口。既有路由文件里没有管理端点目录（`src/http/routes/` 下全是业务域路由），而把管理员端点混进业务路由会让「谁能调」的判定散在两处 ⇒ 单独成文件，权限点与审计口径集中在一处。 |
| `platform/src/runtime/service-state.js` | 「服务还在不在跑」的判定原先住在 `scripts/restore.js` 里。现在写库脚本（seed / migrate）也需要同一份判定，而 `src/` **不能反向依赖** `scripts/`（依赖方向反了）⇒ 判定下沉到 `src/runtime/`，`scripts/restore.js` 改为**转出**（对外契约不变）。 |
| `platform/scripts/prune.js` | `purgeExpiredSessions` 早就在仓储层实现了，但**零调用方**；限频计数事件表更是只增不减。清理必须是**独立于服务进程**的一次性任务（随 systemd timer 跑）⇒ 单独成脚本。 |
| `platform/db/migrations/008_session_touch.sql` | 「上次续期时刻」必须**落在库里**才能跨进程、跨重启判脏。若放在内存里，进程一重启所有会话都会被当成「该续期」⇒ 读路径写量回弹。⇒ 必须走迁移加列（沿用 007 的 `ALTER TABLE ADD COLUMN` 先例）。 |
| `platform/deploy/heikesong-backup.service` | 备份是**运维动作**，不是平台进程 ⇒ 必须是独立的 oneshot 单元（`Type=oneshot`），绝不能起第二个常驻写进程（单写者约束）。 |
| `platform/deploy/heikesong-backup.timer` | 设计文档 §14.2 承诺备份是**定时**的，但 `deploy/` 下此前只有 `.service`、**没有任何 `.timer`** ⇒ 「定时」一直只是文档里的一句话，机器上并不会真的跑。 |
| `platform/deploy/heikesong-prune.service` | 清理与备份同理：运维动作 ⇒ 独立 oneshot 单元。 |
| `platform/deploy/heikesong-prune.timer` | 同上；排在备份**之后**（备份里保留清理前的完整状态 ⇒ 万一删错了还有退路）。 |
| `platform/test/signoff-board-api.test.js` | 签字台两个读口此前**零真实路由测试**（只有演示适配器与前端 mock 在测）⇒ 企业「读得到自己的工作台、读不到别家的」这条契约没有任何机器保证。 |
| `platform/test/static-traversal.test.js` | `src/http/static.js` 自述「只有 realpath 层被测」。三层防线必须**逐层**钉住 —— 而第二层（Windows 反斜杠变体）在行为上被第一、三层掩盖 ⇒ 只能靠**接线断言**证明它还在 ⇒ 需要独立的测试文件承载这组断言。 |
| `platform/test/ops-lifecycle.test.js` | 单写者闸（写库脚本被拒 / 并发只活一个）与 prune 清理行为是**运维契约**，与业务用例无关 ⇒ 独立成文件，避免把「起两个服务进程」这类慢用例混进业务测试。 |

### 4.8 2026-10-26 M0 轮（规则与口径收口）—— 新建文件登记

本轮（M0-1 完赛线可达性 / M0-2 申诉范围）新建了以下文件。
按本仓纪律「**新建文件必须登记进计划块，否则它的漂移查不出来**」，逐个登记如下：

| 文件 | 为什么必须是**新文件** |
|---|---|
| `platform/db/migrations/009_behavior_event_subject.sql` | 「交付里程碑按**里程碑**计次」需要把里程碑 id 落在行为事件行上（`behavior_events.subject_id`）。`behavior_events` 是**只增不改**的审计型表（INTERFACES.md §0「追加式」）⇒ 只能**加列**，不能改表、不能加表 ⇒ 走迁移（沿用 008 的 `ALTER TABLE ADD COLUMN` 先例）。不加这一列 ⇒ 计次只能落在内存 ⇒ 重启即忘 ⇒ 刷分窗口又回来了。 |
| `platform/db/migrations/010_appeal_reason_kind.sql` | 申诉的**程序性错误类型**必须落在 `appeals` 行上 ⇒ 裁决队列（`GET /api/appeals`，组委会的唯一工作清单）里才看得到「这条是哪类错」。只放审计日志 ⇒ 队列里看不到 ⇒ 「只受理程序性错误」在实践中无法执行。同样是只增不改的表 ⇒ 加列，不改表。 |

⚠️ 本轮**没有**新建测试文件：M0-1/M0-2/M0-3/M0-4/M0-5 的用例分别落在既有测试文件里
（`test/behavior.test.js`、`test/behavior-service.test.js`、`test/config.test.js`、
`test/appeals-registration.test.js`、`test/leaderboard-web.test.js`）⇒ 归属阶段不变。
⚠️ 两个迁移把迁移链的版本号从 9 抬到 **10**（`test/pools-migration.test.js` 的版本断言随之更新 ——
这是**契约变更导致的必然更新**，不是「改测试迁就实现」）。

**Step 1: 创建 db/migrations/009_behavior_event_subject.sql**

`platform/db/migrations/009_behavior_event_subject.sql`：

```sql
-- 009_behavior_event_subject.sql —— 行为分事件加「主体」列（按里程碑计次）（2026-10-26）
--
-- 依据：M0-1「完赛线可达性」（2026-10-24 评审轮发现的业务规则缺陷）
--   · 修复前：behavior_events 的次数约束只按 (type) 记 ⇒ `milestone_on_time`
--     一支队伍**终身只能计一次**（5 分）⇒ 而一支队伍最多有 7 个里程碑
--     ⇒ 行为分上限 = 2×5（每周进度，赛程 31 天）+ 3 + 5 + 5 + 10 = **33 分**
--     ⇒ 完赛线 60 分**在真实赛程内不可达** ⇒ 没有任何队伍能被认定为完赛。
--   · 修复后：按**里程碑**计次（每个里程碑各计一次）⇒ 上限 = 10 + 3 + 5×7 + 5 + 10
--     = **63 分** ≥ 完赛线 60 ⇒ 满打满算的队伍恰能完赛。
--
-- ⚠ 为什么用**加列**而不是改表/加表：behavior_events 是**只增不改**的审计型表
--    （INTERFACES.md §0「追加式」）⇒ 只能加列，不能改既有行、不能删列。
--
-- ⚠ 主体列**可空**：迁移前的事件没有主体 ⇒ 落进「无主体桶」⇒ 仍受「终身一次」约束
--    （fail-closed）⇒ 不会被新口径放大成无限计分。
ALTER TABLE behavior_events ADD COLUMN subject_id TEXT;

-- ⚠ 排序/索引兜底一律用隐式 rowid（不用 id 列）——id 是 randomUUID()，顺序随机。
CREATE INDEX idx_behavior_events_subject ON behavior_events(team_id, type, subject_id);
```

**Step 2: 创建 db/migrations/010_appeal_reason_kind.sql**

`platform/db/migrations/010_appeal_reason_kind.sql`：

```sql
-- 010_appeal_reason_kind.sql —— 申诉加「理由类型」列（限程序性错误）（2026-10-26）
--
-- 依据：M0-2「申诉范围」（2026-10-24 评审轮发现的业务规则缺陷）
--   · 修复前：rules/audit.json 的 appealAllowedTiers = ["D"] ⇒ **只有 D 段（低可见档）
--     能申诉** ⇒ A 段队伍对算分错误**连门都进不了**（403）。
--   · 修复后：全员可申诉（A/B/C/D）+ **只受理程序性错误**（理由类型白名单）。
--
-- ⚠ 为什么理由类型要**落库**而不是只放在审计日志里：
--    组委会的裁决队列（GET /api/appeals）是**唯一的工作清单**
--    ⇒ 理由类型不在这一行里 ⇒ 队列里看不到 ⇒ 「只受理程序性错误」在实践中无法执行。
--
-- ⚠ 为什么用**加列**而不是改表：appeals 是**只增不改**的审计型表
--    （INTERFACES.md §0「追加式」）⇒ 只能加列，不能改既有行、不能删列。
--
-- ⚠ 列**可空**：迁移前提交的申诉没有理由类型 ⇒ 读出来是 NULL
--    ⇒ 老数据仍然可读、可裁决（不许因为加列把历史申诉变成不可用）。
ALTER TABLE appeals ADD COLUMN reason_kind TEXT;
```

**Step 1: 创建 src/http/routes/admin.js**

`platform/src/http/routes/admin.js`：

```javascript
// src/http/routes/admin.js — 管理端点（2026-10-24 独立评审补记）
//
// 规则溯源：2026-10-24 独立评审 P0「登录限频的定向 DoS 面」
//   评审原话：「登录限频按手机号 60s/10 次锁定，知道评委手机号的人
//              可以在打分窗口把他锁在门外」。
//   评审给的三个修法里，本仓**采纳两条**、**明确否决一条**：
//   ① 按来源 IP 的独立配额 → **采纳**（src/server.js 的登录路由 +
//      rules/audit.json 的 `loginAttemptByIp` profile）；
//   ② 「账号存在且密码错」与「账号不存在」分别计数 → **否决**：
//      那会让「账号存在」与「账号不存在」的**配额耗尽时机不同**
//      ⇒ 攻击者拿不存在的号试到 N 次拿 429、拿真实号试却还拿 401
//      ⇒ **重新打开了用户枚举**。而本仓在登录路由与
//      src/services/rate-limit.js 里都在**刻意**让这两种情况的
//      **错误码与耗时完全一致**（连 scrypt 都照样跑一遍）。
//      ⇒ 否决理由写在 src/services/rate-limit.js 的 loginSubjectKey 注释里，
//         别只看这里。
//   ③ 管理员手动解锁 → **采纳但改了形态**（本文件）：复核发现「受害者被锁在门外」
//     在本仓语义下**不成立**（正确口令永远能登录）⇒ 「按人解锁」没有用武之地；
//     真正会被挡的是**来源维度**（前置预检，fail-closed）⇒ 端点改为支持
//     `{ all: true }` ⇒ **整体解除登录限频**（限频误伤整个出口时的应急出口）。
//
// ⛔ 权限口径：`audit:write`（裁决复核项与申诉）—— **只有组委会持有**
//    （见 scripts/seed.js 的 ROLE_CAPABILITIES）。
// ⛔ 必须写审计日志：解锁是「**人工干预安全闸**」⇒ 必须留痕（谁、何时、解了谁）。
//    ⛔ 留痕里**只存限频主体的哈希**（`login:<sha256前16位>`）——
//    那张表会进备份 ⇒ 不把明文手机号复制到第二张表（与限频表同一纪律）。
// ⛔ 三态语义：未登录 → 401；无能力点 → 403；手机号不存在 → 404。
import { unlockLoginAttempts, clearAllLoginLimiters } from '../../services/rate-limit.js';
import { getUserByPhone } from '../../db/repo/users.js';
import { insertAuditLogRow } from '../../db/repo/audit-log.js';
import { can } from '../../auth/permissions.js';
import { unauthenticated, forbidden, appError } from '../../errors.js';

function requireLogin(user) {
  if (!user) throw unauthenticated();
}

/**
 * 注册管理端点。
 * @param {object} router 路由表
 * @param {object} deps   { db }
 */
export function registerAdminRoutes(router, { db }) {
  /**
   * POST /api/admin/login-unlock —— 清掉某个手机号的登录限频计数。
   *
   * ⚠️ **为什么这是管理员能力点、而不是「谁都能解锁自己的」**：
   *    如果允许本人自助解锁 ⇒ 攻击者先耗尽受害者配额、再让受害者自助解锁
   *    ⇒ 限频等于没有。⇒ 只能由**组委会**执行（且必须留痕）。
   */
  router.add('POST', '/api/admin/login-unlock', async ({ user, body }) => {
    requireLogin(user);
    if (!can(user, 'audit:write', null, db)) throw forbidden('无权解锁登录限频');

    const all = body?.all === true;

    // ① **整体解除**（应急）：来源维度的预检是**前置**的 ⇒ 某个出口 IP 被误判成
    //    攻击源时，**整个出口的人都会被挡**（含正确口令）⇒ 必须有一条人能立刻
    //    执行的通道。只清**登录**限频；申诉/评分/评委小时配额**不动**。
    if (all) {
      const removed = clearAllLoginLimiters(db);
      insertAuditLogRow(db, {
        actorId: user.id,
        action: 'auth.login_limit_clear_all',
        entity: 'rate_limit',
        entityId: null,
        detailJson: JSON.stringify({ scope: 'login', removed }),
        createdAt: new Date().toISOString(),
      });
      return { status: 200, body: { cleared: removed, scope: 'login' } };
    }

    // ② **按人解锁**
    const phone = String(body?.phone ?? '').trim();
    if (!phone) throw appError(400, 'INVALID_REQUEST', 'phone 必填（或传 all: true 整体解除）');

    const target = getUserByPhone(db, phone);
    if (!target) throw appError(404, 'USER_NOT_FOUND', '该手机号没有对应的用户');

    const result = unlockLoginAttempts(db, phone);

    // ⚠️ 解锁是**人工干预安全闸** ⇒ 必须留痕（谁、何时、解了谁）
    insertAuditLogRow(db, {
      actorId: user.id,
      action: 'auth.login_unlock',
      entity: 'user',
      entityId: target.id,
      // ⚠️ 只存限频主体的哈希，不存明文手机号
      detailJson: JSON.stringify({ subjectKey: result.subjectKey, removed: result.removed }),
      createdAt: new Date().toISOString(),
    });

    return { status: 200, body: { unlocked: result.removed, userId: target.id } };
  });
}
```

**Step 2: 创建 src/runtime/service-state.js**

`platform/src/runtime/service-state.js`：

```javascript
// src/runtime/service-state.js — 「服务还在不在跑」的判定（写库闸的底座）
//
// 为什么把它从 scripts/restore.js 里搬出来（2026-10-25 评审 P1-4a）：
//   恢复脚本需要「服务是否已停」的判定，**写库脚本**（seed / migrate）也需要同一份判定
//   —— 但后者在 `src/` 一侧，而 `src/` 不该反向依赖 `scripts/`（依赖方向反了）。
//   ⇒ 把判定下沉到 `src/runtime/`，`scripts/restore.js` 改为**转出**（对外契约不变）。
//
// ⚠️ 这份判定的铁律是 **fail-closed**（拿不到「服务已停」的证据 ⇒ 一律按「还在跑」处理）：
//   理由：判错的代价不对称 ——
//     · 误判「还在跑」⇒ 运维多停一次服务，代价是几分钟；
//     · 误判「已停」⇒ 在服务正在写库时改 schema / 恢复备份 ⇒ **丢数据 / 库损坏**。
//
// 依据：设计文档 §14.2 单写者约束 —— 同一个 SQLite 文件只允许一个写进程
//   （并发写会撞 SQLITE_BUSY / 517，见 README 的头号架构承诺）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readPidFile, pidFilePath, isProcessAlive } from './pidfile.js';
import { probeService } from './service-probe.js';

/**
 * 服务是否还在跑。优先看 pid 文件（跨平台），Linux 上再兜底 systemd。
 *
 * @param {{ dataDir?: string, serviceName?: string }} [opts]
 * @returns {{ running: boolean, reason: string, pid?: number, stale?: boolean }}
 */
export function checkServiceState({ dataDir = './data', serviceName = 'heikesong' } = {}) {
  const pid = readPidFile(dataDir);
  if (pid && isProcessAlive(pid)) {
    return { running: true, reason: `pid 文件显示进程 ${pid} 仍在运行`, pid };
  }
  // ⚠️ pid 文件在，但内容**不是合法 pid**（写坏了）→ 证明不了服务已停 → 保守判为「还在跑」。
  //    依据：设计文档 §14.2【决策】恢复前必须先停服务 —— 这条是**安全闸**，
  //    拿不到证据时必须拒绝，而不是当成「服务没在跑」。
  //    运维确认服务确实停了，删掉这个 pid 文件即可继续。
  // ⚠️ 判据是「**读不出合法 pid**」（`!pid`），**不是**「文件存在」——
  //    文件存在但内容合法、只是进程已退出 ⇒ 那是**陈旧残留**，走下面的探测分支，
  //    不能被这条「内容无法解析」误伤（这条曾经把陈旧残留判成「还在跑」，
  //    被 test/restore.test.js 的既有用例当场抓住）。
  if (!pid && existsSync(pidFilePath(dataDir))) {
    return { running: true, reason: 'pid 文件存在但内容无法解析，无法确认服务已停止' };
  }
  // ⚠️⚠️ pid 文件**不存在**，或它指向的进程**已退出** ⇒「进程已停」这个证据**不成立**
  //   ⇒ 必须**主动探测服务本身**（E169 / F5b）。
  //   为什么不能只看 pid 文件：「服务确实停了」（正常退出时 server.js 会删掉 pid 文件）
  //   与「服务还在跑、只是 pid 文件没了」（被误删 / 被第二个实例覆盖）**看起来一模一样**，
  //   而恢复的后果天差地别：
  //     · 前者 ⇒ 恢复正是该做的事；
  //     · 后者 ⇒ 恢复会把正在被写入的库文件换掉 ⇒ 丢数据 / 库损坏。
  //   ⇒ 唯一能分辨的证据是「服务还在不在应答」（见 src/runtime/service-probe.js）。
  const probe = probeService(dataDir);
  if (probe.alive) {
    return {
      running: true,
      reason: pid
        ? `pid 文件显示进程 ${pid} 已退出，但 ${probe.reason} ⇒ 服务仍在运行`
        : `pid 文件缺失，但 ${probe.reason} ⇒ 服务仍在运行（拿不到「服务已停」的证据，保守拒绝恢复）`,
      ...(pid ? { pid, stale: true } : {}),
    };
  }
  if (pid) {
    return { running: false, reason: `pid 文件存在但进程 ${pid} 已退出（可能是异常终止的残留）`, pid, stale: true };
  }
  // ⚠️ 用「**能力探测**」而不是「平台判断」：/run/systemd/system 这个目录
  //    **只在 systemd 体系上存在**（macOS / Windows 上不存在；Linux 容器里也可能没有）
  //    ⇒ 它的存在性本身就是「这台机器有 systemd」的判据。
  //    ⛔ 不能写 `process.platform === 'linux'`：那会把平台分支带进 src/
  //    （违反 R-OPS-02：运行时代码不得有平台分支 —— 见 test/portability.test.js）。
  if (existsSync('/run/systemd/system')) {
    try {
      const res = spawnSync('systemctl', ['is-active', serviceName], { encoding: 'utf8' });
      if (res.status === 0 && String(res.stdout).trim() === 'active') {
        return { running: true, reason: `systemd 服务 ${serviceName} 处于 active` };
      }
    } catch {
      // systemctl 不可用 → 忽略这一路探测
    }
  }
  return { running: false, reason: '未发现运行中的服务进程' };
}

/**
 * 写库前的**单写者闸**：服务还在跑 ⇒ 直接拒绝执行。
 *
 * 依据：设计文档 §14.2 单写者约束 + README「SQLite 只允许单写进程」。
 *   适用对象：**批量写 / 改 schema** 的运维脚本（seed / migrate）。
 *   ⚠️ **不适用**于 backup（读，走 SQLite 官方 backup API，与服务并发安全）
 *      与 prune（只删已过期行，短事务，见 scripts/prune.js 的论证）。
 *
 * @param {{ dataDir?: string, serviceName?: string, action?: string }} [opts]
 * @returns {object} checkServiceState 的结果（服务已停时）
 * @throws {Error} 带 `code = 'SERVICE_STILL_RUNNING'` —— 调用方须转成人话错误并退出码 1
 */
export function assertServiceStopped({
  dataDir = './data',
  serviceName = 'heikesong',
  action = '写库操作',
} = {}) {
  const state = checkServiceState({ dataDir, serviceName });
  if (state.running) {
    const err = new Error(
      `拒绝执行${action}：${state.reason}。`
      + '单写者约束：同一个 SQLite 文件只允许一个写进程（并发写会撞 SQLITE_BUSY / 517）。'
      + '请先停掉服务再执行本操作。',
    );
    err.code = 'SERVICE_STILL_RUNNING';
    throw err;
  }
  return state;
}
```

**Step 3: 创建 scripts/prune.js**

`platform/scripts/prune.js`：

```javascript
// scripts/prune.js — 清理过期数据（会话 + 限频计数）
//
// 依据：设计文档 §14.2「运维生命周期」+ 2026-10-25 评审轮 P2-7a
//   · `purgeExpiredSessions`（src/db/repo/sessions.js）早就在仓储层实现了，
//     但**零调用方** ⇒ 过期会话永远堆在表里（服务端的 resolveSession 只在
//     「有人正好拿着那个过期 token 来访问」时才顺手删一行）。
//   · 限频计数同理：每次登录失败 / 评分提交 / 申诉提交都写一行，
//     窗口过了也不删 ⇒ 这张表只增不减。
//
// ⚠️ **为什么 prune 不走单写者闸**（与 seed / migrate 的区别，刻意为之）：
//   · 单写者闸（src/runtime/service-state.js 的 assertServiceStopped）拦的是
//     **批量写 / 改 schema** 的脚本 —— 那类操作与服务并发会写坏数据
//     （seed 会让规则与账号对不上；migrate 会让运行中的服务撞「no such column」）。
//   · 本脚本只做两件事：**删掉已经过期、没人再引用的行**：
//       ① sessions 里 expires_at 已过的会话 —— 服务端早已不再认它们
//          （resolveSession 命中过期行本来就会删行）；
//       ② rate_limit_events 里窗口早已结束的事件 —— 判据见仓储层注释
//          （24 小时 ≫ 本仓最宽的窗口 perHour = 1 小时 ⇒ 删掉的行对任何判定都不可见）。
//   · 两者的写入都是**短事务**，WAL + busy_timeout(5000) 会与服务端的写**串行化**
//     （README 的原话就是「单写者约束：SQLite 只允许单写进程，**写入串行化**」）
//     ⇒ 不可能与服务并发写坏数据。
//   · ⚠️ 反过来看：若把 prune 也用闸拦住，systemd timer 就必须**先停服务**才能清理
//     ⇒ 为了删几行过期数据而中断比赛服务 ⇒ 运维上更糟。
//   ⇒ 结论：**prune 与服务并发安全，故不受单写者闸约束**（这是刻意的区分，不是漏了）。
//
// ⚠️ 为什么删旧行**不会**削弱限频：见
//    src/db/repo/rate-limit.js 的 deleteRateLimitEventsOlderThan 注释。
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { purgeExpiredSessions } from '../src/db/repo/sessions.js';
import { deleteRateLimitEventsOlderThan } from '../src/db/repo/rate-limit.js';

/** 限频计数的保留时长（秒）。默认 24 小时 ≫ 本仓最宽的窗口（perHour = 1 小时）。 */
export const RATE_LIMIT_RETENTION_SECONDS = 86400;

/**
 * 清理过期数据。
 *
 * @param {object} db
 * @param {{ now?: Date, rateLimitRetentionSeconds?: number }} [opts]
 * @returns {{ sessions: number, rateLimit: number }} 各删了多少行
 */
export function pruneExpiredData(db, {
  now = new Date(),
  rateLimitRetentionSeconds = RATE_LIMIT_RETENTION_SECONDS,
} = {}) {
  const sessions = purgeExpiredSessions(db, { now });
  const rateLimit = deleteRateLimitEventsOlderThan(db, {
    now,
    retentionSeconds: rateLimitRetentionSeconds,
  });
  return { sessions, rateLimit };
}

// ── 命令行入口 ────────────────────────────────────────────────
// ⚠️ 符号链接入口：与 src/server.js / scripts/restore.js 同一处判定（两边都 realpath 再比）
//    —— Node 会把主入口 realpath 化，而 process.argv[1] 保留链接路径
//    ⇒ 字符串全等为假 ⇒ 脚本静默不执行、退出码 0。
const here = dirname(fileURLToPath(import.meta.url));
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const dataDir = process.env.DATA_DIR || join(here, '..', 'data');
  const { db, close } = openDatabase({ dataDir });
  try {
    const result = pruneExpiredData(db);
    console.log(`[prune] 过期会话已清理：${result.sessions} 行`);
    console.log(`[prune] 过期限频计数已清理：${result.rateLimit} 行`);
  } finally {
    close();
  }
}
```

**Step 4: 创建 db/migrations/008_session_touch.sql**

`platform/db/migrations/008_session_touch.sql`：

```sql
-- 008_session_touch.sql —— 会话滑动续期改「脏才写」（2026-10-25）
--
-- 依据：2026-10-24 独立评审轮 P1-3a「拆掉读路径的隐性写库」
--   · 修复前：每次命中有效会话都执行 `UPDATE sessions SET expires_at = ?`
--     ⇒ **每个 GET 请求都产生一次写事务** ⇒ 纯读压测下写事务数随请求数线性增长。
--     ⇒ 读路径的写放大在评委打分窗口（几百并发只读页面）会把 SQLite 的写锁排起队。
--   · 修法：显式记一列「上次续期时刻」，只有距上次续期超过阈值才真的 UPDATE。
--
-- ⚠️ 为什么必须**显式存一列**，不能用 expires_at 反推「上次续期时刻」：
--    expires_at 会被「绝对过期上限」夹住（earlierIso）⇒ 反推出的续期时刻越来越旧
--    ⇒ 越接近绝对上限写得越频繁 ⇒ 等于白改。所以直接记 last_touch_at。
--
-- ⚠️ 老会话（迁移前签发的）没有这一列 ⇒ 用 created_at 回填
--    （created_at ≈ 当初那次续期时刻）⇒ 它们的第一次访问会续期一次，
--    之后转入「脏才写」。回填放在同一迁移里 ⇒ 不会留下 NULL 洞。
ALTER TABLE sessions ADD COLUMN last_touch_at TEXT;

UPDATE sessions SET last_touch_at = created_at WHERE last_touch_at IS NULL;
```

**Step 5: 创建 deploy/heikesong-backup.service**

`platform/deploy/heikesong-backup.service`：

```systemd
# deploy/heikesong-backup.service — 定时备份单元（oneshot）
#
# 依据：设计文档 §14.2【决策】备份用 sqlite.backup() API（不用 cp），并且是**定时**执行的。
#   触发方：deploy/heikesong-backup.timer（每日一次）。
#
# ⚠️ 为什么备份**不与** heikesong.service 冲突（单写者约束的边界）：
#   备份走 SQLite 官方 backup API —— 它**只读**源库、不改源库，
#   且 scripts/backup.js 走 openDatabase（带 busy_timeout=5000）⇒
#   **可以在服务运行中执行**（scripts/backup.js 的文件头就写着这条）。
#   ⇒ 这正是「备份要在服务还活着的时候也能做」的意义：出事时不必先停服。
# ⛔ 单写者约束：这里【绝不】加常驻 / 多 worker / 集群启动参数 ——
#    备份是**一次性**任务（Type=oneshot），不是第二个常驻写进程。
#
# ⚠️ 占位符说明（由 deploy/install.sh 自动替换）：
#   __APP_DIR__   程序目录（默认 /opt/heikesong/platform）
#   __DATA_DIR__  数据目录（默认 /var/lib/heikesong/data）
#   __RUN_USER__  运行用户（默认 heikesong）

[Unit]
Description=Heikesong Platform 定时备份（sqlite.backup API · 一致性快照）
Documentation=file:__APP_DIR__/README.md
After=heikesong.service

[Service]
Type=oneshot
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__APP_DIR__

# 环境文件：PORT / DATA_DIR / NODE_ENV 等（同名变量以环境文件为准）
EnvironmentFile=-/etc/heikesong/platform.env

# 环境默认值（EnvironmentFile 里的同名变量优先）
Environment=DATA_DIR=__DATA_DIR__
Environment=NODE_ENV=production

ExecStart=/usr/bin/env node __APP_DIR__/scripts/backup.js

# 备份失败必须**让人看见** ⇒ 走 journald（journalctl -u heikesong-backup -f）
StandardOutput=journal
StandardError=journal
SyslogIdentifier=heikesong-backup
```

**Step 6: 创建 deploy/heikesong-backup.timer**

`platform/deploy/heikesong-backup.timer`：

```
# deploy/heikesong-backup.timer — 每日定时备份
#
# 依据：设计文档 §14.2【决策】备份是**定时**的（此前 deploy/ 下只有 .service、没有 .timer
#   ⇒ 「定时」这件事一直是**口头承诺**，机器上并没有真的会跑）。
#
# ⚠️ 为什么是 03:17 而不是 03:00：
#   整点是全网备份任务的峰值（各家 cron / 云盘快照都挤在 00:00）。
#   错开几分钟 ⇒ 本机不会和别的任务抢磁盘 IO。
# ⚠️ RandomizedDelaySec=300：再叠加最多 5 分钟的随机延迟 ——
#   多台机器（城市联络员 / 评审机）不会在同一秒同时打 IO。
# ⚠️ Persistent=true：关机期间错过的触发，**开机后补跑一次**
#   （否则「周末关机 ⇒ 整个周末没有备份」这种坑会真实发生）。

[Unit]
Description=每日定时备份（Heikesong Platform）
Documentation=file:__APP_DIR__/README.md

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
RandomizedDelaySec=300
Unit=heikesong-backup.service

[Install]
WantedBy=timers.target
```

**Step 7: 创建 deploy/heikesong-prune.service**

`platform/deploy/heikesong-prune.service`：

```systemd
# deploy/heikesong-prune.service — 过期数据清理单元（oneshot）
#
# 依据：设计文档 §14.2「运维生命周期」+ 2026-10-25 评审轮 P2-7a
#   清理两类只增不减的表：过期会话（sessions）、过期限频计数（rate_limit_events）。
#   触发方：deploy/heikesong-prune.timer（每日一次）。
#
# ⚠️ **为什么清理可以与 heikesong.service 并发跑**（单写者约束的边界，刻意为之）：
#   · 单写者闸拦的是**批量写 / 改 schema**（seed 会让规则与账号对不上；
#     migrate 会让运行中的服务撞「no such column」）—— 那两类**必须**停服。
#   · prune 只删**已经过期、没人再引用的行**，且是**短事务**：
#     WAL + busy_timeout(5000) 让它与服务端的写**串行化** ⇒ 不可能写坏数据。
#   · 反过来：若 prune 也要停服，那为了删几行过期数据而中断比赛服务 ⇒ 运维上更糟。
#   ⇒ 详细论证见 platform/scripts/prune.js 的文件头。
#
# ⚠️ 占位符说明（由 deploy/install.sh 自动替换）：
#   __APP_DIR__   程序目录（默认 /opt/heikesong/platform）
#   __DATA_DIR__  数据目录（默认 /var/lib/heikesong/data）
#   __RUN_USER__  运行用户（默认 heikesong）

[Unit]
Description=Heikesong Platform 过期数据清理（会话 + 限频计数）
Documentation=file:__APP_DIR__/README.md
After=heikesong.service

[Service]
Type=oneshot
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__APP_DIR__

# 环境文件：PORT / DATA_DIR / NODE_ENV 等（同名变量以环境文件为准）
EnvironmentFile=-/etc/heikesong/platform.env

# 环境默认值（EnvironmentFile 里的同名变量优先）
Environment=DATA_DIR=__DATA_DIR__
Environment=NODE_ENV=production

ExecStart=/usr/bin/env node __APP_DIR__/scripts/prune.js

StandardOutput=journal
StandardError=journal
SyslogIdentifier=heikesong-prune
```

**Step 8: 创建 deploy/heikesong-prune.timer**

`platform/deploy/heikesong-prune.timer`：

```
# deploy/heikesong-prune.timer — 每日清理过期数据
#
# 依据：设计文档 §14.2「运维生命周期」+ 2026-10-25 评审轮 P2-7a
#
# ⚠️ 为什么排在备份**之后**（03:47 vs 03:17）：
#   备份是一次一致性快照；清理是删旧行。
#   先备份、后清理 ⇒ 备份里**包含**清理前的那份完整状态
#   ⇒ 万一「清理删错了行」，还有一份清理前的备份可以回退。
#   （反过来的话，备份里就已经是删完的状态 ⇒ 没有退路。）
# ⚠️ RandomizedDelaySec=300：与备份同理，避免多台机器同时打 IO。

[Unit]
Description=每日清理过期数据（Heikesong Platform）
Documentation=file:__APP_DIR__/README.md

[Timer]
OnCalendar=*-*-* 03:47:00
Persistent=true
RandomizedDelaySec=300
Unit=heikesong-prune.service

[Install]
WantedBy=timers.target
```

**Step 9: 创建 test/signoff-board-api.test.js**

`platform/test/signoff-board-api.test.js`：

```javascript
// platform/test/signoff-board-api.test.js —— 企业签字台**两个真实读口**的 HTTP 闸
//
// ⚠️ **这个文件为什么必须存在（独立评审指出的测试盲区）**：
//   `src/services/signoff-board.js` 导出两个读口业务函数：
//     · `getSignoffWorklist`            → GET /api/signoffs/mine
//     · `getEnterpriseConfirmationBoard` → GET /api/stages/:stageId/enterprise-confirmations
//   全仓引用它们的**只有**两处：
//     ① `src/http/routes/signoff.js`（**真实路由**）
//     ② `web/api.demo.js`（**演示适配器 —— 另一份独立实现**）
//   而 `web/api.demo.js` 的那份实现（demoSignoffWorklist / demoEnterpriseConfirmationBoard）
//   **压根不做企业过滤**：它遍历 `state.teams` 全部队伍、返回 `scope:'committee'`，
//   确认记录也是 `state.enterpriseConfirmations` 全量 ⇒
//   **演示站测绿了也证明不了真实后端没坏**（两条实现的过滤口径根本不是一回事）。
//   ⇒ 真实 HTTP 路径（`createApp` + 真请求）此前**零覆盖** ⇒ 本文件补上。
//
// ⚠️ **断言的判别性纪律**（本文件的硬要求）：
//   · 只断言「非空」= 假绿 ⇒ 每条都断言**精确集合 / 精确条数 / 逐个 id**；
//   · 「实现退化成返回全部」与「实现退化成返回空」**都必须变红**；
//   · 每条用例都带**对照组**（该过的必须过）⇒ 不能靠「一律拒/一律空」骗绿；
//   · ⛔ **不许为了让用例通过而放宽断言** —— 用例红就是发现，改实现是别人的事。
//
// 规则溯源：
//   - 「企业席只看**自己出题**的队」（里程碑签字 = 客观事实确认，别的企业没资格替它确认）
//     → R-ENT-02 / R-PTS-02（见 src/services/signoff-board.js 的口径注释）
//   - 「签字不公开」（R-ENT-04）+ 「非本赛道签字把该队企业项权重归零」（R-JDG-06 R1）
//     ⇒ 企业席不得看到别家企业的确认记录
//   - 「三态状态码」：列表 200 + 空集 ｜ 单条 404（赛段不存在）｜ 禁用 403（没有能力点）
//     → 设计文档 §7.3
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createUser } from '../src/db/repo/users.js';
import { createSession } from '../src/auth/session.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
//    ⚠️ 必须在临时目录第一次被求值之前调用（temp-leak-scan 的 R1 / R2 闸）。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

/** 本文件用到的三个能力点（注册后才有资格被 grant）。 */
const CAPS = [
  ['signoff:create', '企业里程碑签字'],
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
];

/**
 * 真实 HTTP 调用（真服务器 + 真 fetch）。
 * ⚠️ 为什么不用 test-helpers/http-call.js 的进程内 call()：
 *    本文件要证明的是「**HTTP 路径**真的能读口」，进程内调用跳过 socket 与报文编解码；
 *    这里起真服务器，Cookie 走真实请求头 ⇒ 与真机链路一致。
 */
async function call(base, method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

/**
 * 夹具：两家公司、两个任务包、两支队、一个赛段、两条企业确认。
 *
 * ⚠️ **夹具按生产口径造**（F30/F31 修完后的口径）：
 *    `task_packages.enterprise_id` = 出题企业本人 ⇒ 「谁出的题」这件事在库里是**真的**，
 *    否则「只看到自己出题的队」这条根本触发不了（那是个无主卡 ⇒ 假绿）。
 *
 * ⚠️ 每个用例都拿到**全新的库**（每次调用新建 dataDir + 迁移）⇒ 用例之间零共享状态。
 */
async function withTwoEnterprises(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-signboard-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = new Date().toISOString();
  try {
    for (const [k, d] of CAPS) insertCapability(db, k, d);

    const entA = createUser(db, { name: '甲企业席', phone: '13900009001', password: 'pw', org: '甲公司', mbaStatus: 'other' });
    const entB = createUser(db, { name: '乙企业席', phone: '13900009002', password: 'pw', org: '乙公司', mbaStatus: 'other' });
    const capA = createUser(db, { name: '甲队长', phone: '13900009003', password: 'pw', mbaStatus: 'mba' });
    const capB = createUser(db, { name: '乙队长', phone: '13900009004', password: 'pw', mbaStatus: 'mba' });
    const judge = createUser(db, { name: '评委丙', phone: '13900009005', password: 'pw', mbaStatus: 'mba' });
    // 无任何能力点 ⇒ 两个读口都必须回 403
    const outsider = createUser(db, { name: '无关路人', phone: '13900009006', password: 'pw', mbaStatus: 'mba' });
    // 只有 score:write、没有 signoff:create ⇒ 企业双签清单必须回 403（不是放行）
    const scoreOnly = createUser(db, { name: '只有评分权', phone: '13900009007', password: 'pw', mbaStatus: 'mba' });
    // 只有 signoff:create、没有 score:write ⇒ 企业双签清单必须回 403（写端点是无条件校验的）
    const seatOnly = createUser(db, { name: '只有签字权', phone: '13900009008', password: 'pw', org: '丙公司', mbaStatus: 'other' });
    // 组委会：stage:compute ⇒ 全量视角（对照组：可见性过滤不是「谁都看不到」）
    const committee = createUser(db, { name: '组委会', phone: '13900009009', password: 'pw', mbaStatus: 'mba' });

    const grant = (userId, capability) => grantAssignment(db, {
      userId, capability, scopeType: 'global', scopeId: null, grantedBy: null,
    });
    for (const u of [entA, entB]) { grant(u.id, 'signoff:create'); grant(u.id, 'score:write'); }
    grant(judge.id, 'score:write');
    grant(scoreOnly.id, 'score:write');
    grant(seatOnly.id, 'signoff:create');
    grant(committee.id, 'stage:compute');
    grant(committee.id, 'score:write');

    // ── 届期 / 任务包（enterprise_id = 出题企业本人）──
    db.exec(`INSERT INTO editions (id,name,city,starts_at,ends_at,created_at)
             VALUES ('ed_1','首届','上海','2026-01-01','2026-12-31','${now}')`);
    for (const [tp, ent, name] of [['tp_a', entA, '甲公司'], ['tp_b', entB, '乙公司']]) {
      db.exec(`INSERT INTO task_packages (id,edition_id,enterprise_id,enterprise_name,title,pain_point,
                expected_delivery,acceptance_criteria,is_free_brief,submitted_by,status,meta_json,submitted_at)
               VALUES ('${tp}','ed_1','${ent.id}','${name}','${name}任务包','p','e','a',0,'${ent.id}','published','{}','${now}')`);
    }
    // ── 两支队（各属各的任务包）──
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at)
             VALUES ('team_a','ed_1','甲队','${capA.id}','tp_a','active','${now}')`);
    db.exec(`INSERT INTO teams (id,edition_id,name,captain_id,task_package_id,status,created_at)
             VALUES ('team_b','ed_1','乙队','${capB.id}','tp_b','active','${now}')`);
    // ── 每队 2 个里程碑（条数刻意不等于 1 ⇒ 「返回空 / 返回全部」都判得出来）──
    for (const [ms, team, key, label] of [
      ['ms_a1', 'team_a', 'problem_confirmed', '企业问题确认'],
      ['ms_a2', 'team_a', 'pilot_signed', '试点合同已签'],
      ['ms_b1', 'team_b', 'problem_confirmed', '企业问题确认'],
      ['ms_b2', 'team_b', 'pilot_signed', '试点合同已签'],
    ]) {
      db.exec(`INSERT INTO milestones (id,team_id,key,label,counts_toward_tier,requires_signoff,fixed_at,created_at)
               VALUES ('${ms}','${team}','${key}','${label}',1,1,'${now}','${now}')`);
    }
    // ── 里程碑签字（客观事实）：甲签了自己的一条，乙签了自己的一条 ──
    db.exec(`INSERT INTO milestone_signoffs (id,milestone_id,enterprise_id,signatory_user_id,department,content,signed_at,revoked_at)
             VALUES ('so_a','ms_a1','${entA.id}','${entA.id}','业务部','甲企业确认问题已确认','${now}',NULL)`);
    db.exec(`INSERT INTO milestone_signoffs (id,milestone_id,enterprise_id,signatory_user_id,department,content,signed_at,revoked_at)
             VALUES ('so_b','ms_b1','${entB.id}','${entB.id}','业务部','乙企业确认问题已确认','${now}',NULL)`);
    // ── 赛段 + 评委席 ──
    db.exec(`INSERT INTO stages (id,edition_id,"key",name,kind,starts_at,ends_at,scoring_config_key,status)
             VALUES ('st_1','ed_1','s1','决赛','final','2026-01-01','2026-06-30','final','open')`);
    db.prepare(
      'INSERT INTO stage_judges (stage_id,user_id,seat,scope_type,scope_id,assigned_at) VALUES (?,?,?,?,?,?)',
    ).run('st_1', judge.id, 'judge', 'global', null, now);
    // ── 企业确认（主观评分，双签）：各企业各签各的队 ──
    db.exec(`INSERT INTO enterprise_confirmations (id,stage_id,team_id,enterprise_id,dimension,raw_score,
              cross_judge_id,signatory_user_id,content,created_at)
             VALUES ('ec_a','st_1','team_a','${entA.id}','enterprise',85,'${judge.id}','${entA.id}','甲企业双签确认内容','${now}')`);
    db.exec(`INSERT INTO enterprise_confirmations (id,stage_id,team_id,enterprise_id,dimension,raw_score,
              cross_judge_id,signatory_user_id,content,created_at)
             VALUES ('ec_b','st_1','team_b','${entB.id}','enterprise',60,'${judge.id}','${entB.id}','乙企业双签确认内容','${now}')`);

    await fn({
      base, db,
      entA, entB, capA, capB, judge, outsider, scoreOnly, seatOnly, committee,
      tokenEntA: createSession(db, entA.id).token,
      tokenEntB: createSession(db, entB.id).token,
      tokenOutsider: createSession(db, outsider.id).token,
      tokenScoreOnly: createSession(db, scoreOnly.id).token,
      tokenSeatOnly: createSession(db, seatOnly.id).token,
      tokenCommittee: createSession(db, committee.id).token,
    });
  } finally {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════
// 读口 ①：GET /api/signoffs/mine（企业席签字台）
// ══════════════════════════════════════════════════════════════════

test('签字台读口：企业席只读得到**自己出题**的队的里程碑（别家的读不到）', async () => {
  await withTwoEnterprises(async ({ base, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntA}` });
    assert.equal(r.status, 200, `企业席读自己的签字台必须 200：${r.text}`);
    assert.equal(r.json.scope, 'enterprise', `企业席看到的必须是企业视角，实际 ${r.json.scope}`);

    // 判别性①：**精确条数** —— 甲队 2 条里程碑。
    //   ⇒ 实现退化成「返回全部」（4 条）⇒ 红；退化成「返回空」（0 条）⇒ 红。
    assert.equal(
      r.json.items.length, 2,
      `甲企业只该看到自己出题的甲队的 2 条里程碑，实际 ${r.json.items.length} 条：${r.text}`,
    );
    // 判别性②：**逐个 id 点名** —— 不能靠「条数对了」蒙混（换了内容也算错）
    assert.deepEqual(
      r.json.items.map((i) => i.milestoneId).sort(),
      ['ms_a1', 'ms_a2'],
      `甲企业的清单里必须只有甲队的两个里程碑：${r.text}`,
    );
    assert.ok(
      r.json.items.every((i) => i.teamId === 'team_a'),
      `甲企业的清单里不得出现别家的队：${r.text}`,
    );
    // 判别性③：**按名字点名** —— 乙队的队名 / 乙队的里程碑 id 一个都不许出现
    assert.equal(r.text.includes('乙队'), false, '别家的队名不得出现在我的签字台里');
    assert.equal(r.text.includes('ms_b1'), false, '别家的里程碑不得出现在我的签字台里');
    assert.equal(r.text.includes('team_b'), false, '别家的队 id 不得出现在我的签字台里');

    // ── 对照组：乙企业看到的是**乙队**的（该过的必须过 ⇒ 不能靠「一律空」骗绿）──
    const rb = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntB}` });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(rb.json.scope, 'enterprise');
    assert.equal(
      rb.json.items.length, 2,
      `乙企业只该看到自己出题的乙队的 2 条里程碑，实际 ${rb.json.items.length} 条：${rb.text}`,
    );
    assert.deepEqual(
      rb.json.items.map((i) => i.milestoneId).sort(),
      ['ms_b1', 'ms_b2'],
      `乙企业的清单里必须只有乙队的两个里程碑：${rb.text}`,
    );
    assert.ok(rb.json.items.every((i) => i.teamId === 'team_b'), '乙企业的清单里不得出现甲队');
  });
});

test('签字台读口：已签状态与「是不是我签的」必须如实（签字人不公开）', async () => {
  await withTwoEnterprises(async ({ base, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntA}` });
    assert.equal(r.status, 200, r.text);
    const signed = r.json.items.find((i) => i.milestoneId === 'ms_a1');
    const unsigned = r.json.items.find((i) => i.milestoneId === 'ms_a2');
    assert.ok(signed, '清单里必须有 ms_a1');
    assert.ok(unsigned, '清单里必须有 ms_a2');
    assert.equal(signed.signed, true, '已签字的里程碑 signed 必须为 true');
    assert.equal(signed.signedByMe, true, '自己签的必须 signedByMe=true');
    assert.equal(signed.canWithdraw, true, '自己签的必须可以撤回');
    assert.equal(unsigned.signed, false, '没签的里程碑 signed 必须为 false');
    assert.equal(unsigned.signedByMe, false, '没签的 signedByMe 必须是 false');
    // R-ENT-04「签字不公开」：条目里**不得**出现签字人姓名 / id
    assert.equal(r.text.includes('甲企业席'), false, '签字人姓名不得出现在签字台里');
    assert.ok(
      !r.json.items.some((i) => Object.keys(i).some((k) => /signatory|signer|signerId/i.test(k))),
      '签字台条目里不得有「签字人」字段',
    );

    // 对照组：乙企业**看不到**甲的签字（甲那条不在乙的清单里）
    const rb = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenEntB}` });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(
      rb.json.items.some((i) => i.milestoneId === 'ms_a1'),
      false,
      '乙企业的清单里不得出现甲企业的里程碑',
    );
    const own = rb.json.items.find((i) => i.milestoneId === 'ms_b1');
    assert.equal(own.signed, true, '乙自己签的那条 signed 必须为 true');
    assert.equal(own.signedByMe, true, '乙自己签的那条 signedByMe 必须为 true');
  });
});

test('签字台读口：组委会是全量视角（对照组 —— 可见性过滤不是「谁都看不到」）', async () => {
  await withTwoEnterprises(async ({ base, tokenCommittee }) => {
    const r = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenCommittee}` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scope, 'committee', `组委会看到的必须是 committee 视角，实际 ${r.json.scope}`);
    assert.equal(
      r.json.items.length, 4,
      `组委会看得到两队共 4 条里程碑，实际 ${r.json.items.length} 条：${r.text}`,
    );
    assert.deepEqual(
      [...new Set(r.json.items.map((i) => i.teamId))].sort(),
      ['team_a', 'team_b'],
      `组委会的清单必须覆盖两支队：${r.text}`,
    );
  });
});

test('签字台读口：未登录 ⇒ 401（不是 500、不是空集）；无能力点 ⇒ 403', async () => {
  await withTwoEnterprises(async ({ base, tokenOutsider }) => {
    const anon = await call(base, 'GET', '/api/signoffs/mine');
    assert.equal(anon.status, 401, `未登录必须是 401，实际 ${anon.status}：${anon.text}`);
    assert.equal(anon.json?.error?.code, 'UNAUTHENTICATED', '未登录的错误码必须是 UNAUTHENTICATED');
    assert.notEqual(anon.status, 500, '未登录不得变成 500');

    const noPerm = await call(base, 'GET', '/api/signoffs/mine', { cookie: `hk_session=${tokenOutsider}` });
    assert.equal(noPerm.status, 403, `没有能力点必须是 403，实际 ${noPerm.status}：${noPerm.text}`);
    assert.equal(noPerm.json?.error?.code, 'FORBIDDEN', '无能力点的错误码必须是 FORBIDDEN');
  });
});

// ══════════════════════════════════════════════════════════════════
// 读口 ②：GET /api/stages/:stageId/enterprise-confirmations（企业双签清单）
// ══════════════════════════════════════════════════════════════════

test('企业双签清单读口：企业席只读得到**本企业相关**的行（别家的行读不到）', async () => {
  await withTwoEnterprises(async ({ base, entA, entB, tokenEntA, tokenEntB }) => {
    const r = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenEntA}`,
    });
    assert.equal(r.status, 200, `企业席读双签清单必须 200：${r.text}`);
    assert.equal(r.json.scope, 'enterprise', `企业席看到的必须是企业视角，实际 ${r.json.scope}`);
    assert.equal(r.json.myEnterpriseId, entA.id, 'myEnterpriseId 必须是当前登录人自己');

    // 判别性①：**精确条数** —— 甲企业只有 1 条确认记录。
    //   ⇒ 退化成「返回全部」（2 条）⇒ 红；退化成「返回空」（0 条）⇒ 红。
    assert.equal(
      r.json.confirmations.length, 1,
      `甲企业只该看到自己那 1 条确认记录，实际 ${r.json.confirmations.length} 条：${r.text}`,
    );
    // 判别性②：逐个字段点名 —— enterpriseId / teamId 都必须是自己家的
    assert.equal(r.json.confirmations[0].enterpriseId, entA.id, '确认记录的 enterpriseId 必须是本企业');
    assert.equal(r.json.confirmations[0].teamId, 'team_a', '确认记录必须挂在自家出题的队上');
    // 判别性③：别家的确认记录一个都不许出现
    assert.equal(
      r.json.confirmations.some((c) => c.enterpriseId !== entA.id),
      false,
      `不得看到别家企业的确认记录：${r.text}`,
    );
    assert.equal(r.text.includes('乙企业双签确认内容'), false, '别家企业的确认内容不得泄露');
    // 判别性④：**名册**也必须过滤 —— 只列自家出题的队
    assert.deepEqual(
      r.json.teams.map((t) => t.teamId),
      ['team_a'],
      `名册里只该有自家出题的队：${r.text}`,
    );
    assert.equal(r.text.includes('乙队'), false, '别家的队名不得出现在双签清单里');

    // ── 对照组：乙企业看到的是**乙队 + 乙的确认**（该过的必须过）──
    const rb = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenEntB}`,
    });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(rb.json.scope, 'enterprise');
    assert.deepEqual(rb.json.teams.map((t) => t.teamId), ['team_b'], `乙企业的名册里只该有乙队：${rb.text}`);
    assert.equal(
      rb.json.confirmations.length, 1,
      `乙企业只该看到自己那 1 条确认记录，实际 ${rb.json.confirmations.length} 条：${rb.text}`,
    );
    assert.equal(rb.json.confirmations[0].teamId, 'team_b', '乙的确认记录必须挂在乙队上');
    assert.equal(rb.json.confirmations[0].enterpriseId, entB.id, '乙看到的确认记录必须属于乙企业');
    assert.equal(rb.json.myEnterpriseId, entB.id, '乙的 myEnterpriseId 必须是乙企业自己');
  });
});

test('企业双签清单读口：组委会是全量视角（对照组 —— 过滤不是「谁都看不到」）', async () => {
  await withTwoEnterprises(async ({ base, tokenCommittee }) => {
    const r = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenCommittee}`,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scope, 'committee', `组委会看到的必须是 committee 视角，实际 ${r.json.scope}`);
    assert.equal(r.json.teams.length, 2, `组委会的名册必须有两支队，实际 ${r.json.teams.length}：${r.text}`);
    assert.equal(
      r.json.confirmations.length, 2,
      `组委会必须看得到两家的确认记录，实际 ${r.json.confirmations.length}：${r.text}`,
    );
  });
});

test('企业双签清单读口：未登录 ⇒ 401；缺能力点 ⇒ 403；赛段不存在 ⇒ 404', async () => {
  await withTwoEnterprises(async ({ base, tokenOutsider, tokenScoreOnly, tokenSeatOnly }) => {
    // ① 未登录 ⇒ 401（不是 500、不是空集）
    const anon = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations');
    assert.equal(anon.status, 401, `未登录必须是 401，实际 ${anon.status}：${anon.text}`);
    assert.equal(anon.json?.error?.code, 'UNAUTHENTICATED', '未登录的错误码必须是 UNAUTHENTICATED');
    assert.notEqual(anon.status, 500, '未登录不得变成 500');

    // ② 一个能力点都没有 ⇒ 403（不是放行、不是空集）
    const noPerm = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenOutsider}`,
    });
    assert.equal(noPerm.status, 403, `没有能力点必须是 403，实际 ${noPerm.status}：${noPerm.text}`);
    assert.equal(noPerm.json?.error?.code, 'FORBIDDEN', '无能力点的错误码必须是 FORBIDDEN');

    // ③ 只有 score:write（没有 signoff:create）⇒ 403
    const scoreOnly = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenScoreOnly}`,
    });
    assert.equal(
      scoreOnly.status, 403,
      `没有 signoff:create 的人不得读企业双签清单，实际 ${scoreOnly.status}：${scoreOnly.text}`,
    );

    // ④ 只有 signoff:create（没有 score:write）⇒ 403
    //    ⚠️ 写端点 `POST /api/stages/:stageId/enterprise-confirmations` 里
    //    `requireStageCapability(ctx,'score:write')` 是**无条件**执行的 ⇒ 读端点必须同口径。
    const seatOnly = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenSeatOnly}`,
    });
    assert.equal(
      seatOnly.status, 403,
      `没有 score:write 的人不得读企业双签清单，实际 ${seatOnly.status}：${seatOnly.text}`,
    );
    assert.equal(seatOnly.json?.error?.code, 'FORBIDDEN', '缺 score:write 的错误码必须是 FORBIDDEN');

    // ⑤ 赛段不存在 ⇒ 404（单条语义）
    const missing = await call(base, 'GET', '/api/stages/st_nope/enterprise-confirmations', {
      cookie: `hk_session=${tokenOutsider}`,
    });
    assert.equal(missing.status, 404, `赛段不存在必须是 404，实际 ${missing.status}：${missing.text}`);
  });
});

test('企业双签清单读口：响应形状必须给前端够用的字段（维度 / 跨领域评委候选）', async () => {
  await withTwoEnterprises(async ({ base, tokenEntA }) => {
    const r = await call(base, 'GET', '/api/stages/st_1/enterprise-confirmations', {
      cookie: `hk_session=${tokenEntA}`,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stage.id, 'st_1', '必须回赛段摘要');
    // 企业确认维度从规则表来（不硬编码 'enterprise' 键）⇒ final 权重表里有这一维
    assert.deepEqual(
      r.json.dimensions.map((d) => d.key),
      ['enterprise'],
      `企业确认维度必须来自规则表：${r.text}`,
    );
    assert.equal(r.json.dimensions[0].seat, 'enterprise', '维度的席别必须是 enterprise');
    // 跨领域评委候选：排除「我」⇒ 自己不在候选里，但别的评委在
    assert.ok(Array.isArray(r.json.crossJudgeCandidates), '必须给跨领域评委候选数组');
    assert.ok(
      r.json.crossJudgeCandidates.length > 0,
      `跨领域评委候选不得为空（前端凑不齐 R2 双签就没法提交）：${r.text}`,
    );
    // 判别性：候选里**不得**含自己（后端会拒绝 crossJudgeId === 签字人）
    assert.equal(
      r.json.crossJudgeCandidates.some((c) => c.userId === r.json.myEnterpriseId),
      false,
      '跨领域评委候选里不得包含自己',
    );
  });
});
```

**Step 10: 创建 test/static-traversal.test.js**

`platform/test/static-traversal.test.js`：

```javascript
// platform/test/static-traversal.test.js — 静态穿越三层防线的**逐层**断言
//
// 背景：src/http/static.js 的注释自己写着：
//   「⚠️ 穿越防线共三层（'..' 段拒绝 / 分隔符边界 / realpath 边界）：
//      目前只有 realpath 这一层被断言钉住 —— 另两层单独拆掉不会被测出来
//      （三层同拆才会红）。三层都要留着：realpath 之前的路径规范化仍需自保。」
//
// 本文件把另外两层补上，并把「拆掉任一层就必须变红」变成**可验证**的命题：
//   第一层「'..' 段拒绝」  —— 路径里出现 '..' 段 ⇒ 直接拒（必须在 decode **之后**判）
//   第二层「分隔符边界」  —— resolve(root, '.'+rel) 之后必须仍在 root 之下
//   第三层「realpath 边界」—— **已存在**，本文件**不重复造**：
//        platform/test/server.test.js 的
//        「软链指向 web 根外的文件时返回 404，不得读出文件内容（终审 I-1）」
//        与「软链的判定看真实路径：指向根外的被拒，指向根内的放行（终审 M-7）」
//        （前者钉「根外软链不得读出内容」，后者同时钉「根外软链 → 404 / 根内软链 → 200」两个方向）
//        ⇒ 实测：单独拆掉 realpath 那一层 ⇒ 这两条变红（2026-10-24 变异验证）。
//
// ⚠️ **为什么第二层只能用「接线断言」钉住**（本文件最关键的一条推理，别删）：
//   · 行为上，第二层**单独**拆掉是**测不出来的**：对同一个越界目标，
//     第一层（'..' 段）与第三层（realpath）**都会拦** ⇒ 拆掉第二层，响应照样是 404
//     ⇒ 只写行为断言 ⇒ 第二层会被无声拆掉 ⇒ 这正是 static.js 注释里说的那个病。
//   · 而第二层**不能被第一层替代**：第一层只按 '/' 切段，
//     Windows 上 `..\..\x` 是**一个**段（第一层放行）⇒ 只有第二层能拦它。
//   ⇒ 所以第二层必须有一条**直接断言那道防线还在**的接线断言
//     （本仓既有手法：server.test.js 的「serveStatic 必须真的调用 isSameFile 做 dev/ino 对账（接线断言）」），
//     并且这条断言要带**变异对照**（把防线改坏 ⇒ 断言必须变红），否则它自己也可能恒绿。
//
// ⛔ **跨平台纪律**：本仓要求用例在 Windows 与 POSIX 上都成立。
//   · 第一层的探针（'/sub/../index.html'）在两个平台上的语义**完全一致**
//     （resolve 是纯词法运算，与分隔符无关）⇒ 断言逐字相同。
//   · 第二层的**行为**探针（拼出 root 的兄弟目录）在两个平台上都成立；
//     额外加一条**反斜杠**变体，它在 Windows 上**能单独打到第二层**，
//     在 POSIX 上则是无害的恒真（POSIX 里 '\' 是普通文件名字符，不是分隔符）——
//     所以该变体只断言「**不泄露**」（两平台都必须成立），
//     「能单独打到第二层」这个更强的事实由上面的**接线断言**在两平台上保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { stripComments } from '../test-helpers/strip-comments.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const STATIC_SRC = join(here, '..', 'src', 'http', 'static.js');

/**
 * 搭一个静态根：<dataDir>/web-root/web（静态根）、<dataDir>/web-root/web-secret（**兄弟目录**）。
 *
 * ⚠️ 兄弟目录 web-secret/ 是第二层防线要防的那个形状：
 *    '/x/web-secret'.startsWith('/x/web') 为真 ⇒ 只比前缀会把兄弟目录也放进来。
 */
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-static-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const webRoot = join(dataDir, 'web-root');
  const webDir = join(webRoot, 'web');
  mkdirSync(join(webDir, 'sub'), { recursive: true });
  mkdirSync(join(webRoot, 'web-secret'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(webDir, 'sub', 'inner.txt'), 'INNER\n');
  writeFileSync(join(webRoot, 'web-secret', 'passwd'), 'TOP-SECRET');
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, webRoot, webDir, app };
}

/**
 * 用**裸 socket** 发原始请求行。
 * ⚠️ 为什么不能用 fetch / http.request：它们按 WHATWG URL 规范把点段消掉
 *    （'%2e%2e' 也会被规范化成 '..'）⇒ 请求根本发不出原样 ⇒ 穿越测试成了空转。
 *    Node 的 HTTP **解析器**不规范化 ⇒ 原样发出去，服务端收到的就是原样的路径。
 */
function rawRequest(port, rawPath, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const done = (value) => resolvePromise(value);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`请求超时：${rawPath}`));
    });
    socket.on('connect', () => {
      socket.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    socket.on('close', () => done(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

/** 起一个真实 HTTP server（真实 socket ⇒ 真实请求 ⇒ 真实响应） */
async function withServer(app, fn) {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

/**
 * 第二层防线的**接线断言**匹配器。
 *
 * 必须匹配到的形态：目标路径不在 root 之下时**直接拒**，
 * 且比较**带分隔符边界**（`root + sep`）—— 只比前缀（`root`）正是 C7-1 那个
 * 「兄弟目录被放进来」的原始 bug。
 */
const BOUNDARY_GUARD = /if\s*\(\s*target\s*!==\s*root\s*&&\s*!\s*target\s*\.\s*startsWith\(\s*root\s*\+\s*sep\s*\)\s*\)\s*\{?\s*return\s+false\s*;?\s*\}?/;

// ══════════════════════════════════════════════════════════════════════
// 第一层：「'..' 段拒绝」
// ══════════════════════════════════════════════════════════════════════

test('第一层：路径里带 ".." 段的请求必须被拒（只有第一层能拦住下面那条探针）', async () => {
  const { db, close, dataDir, webRoot, webDir, app } = setup();
  try {
    // ── 探针「只打到第一层」的机器可验证证明 ──
    // resolve() 是**纯词法**运算（不碰文件系统）⇒ '/sub/../index.html' 归一化后
    // 落在 root **之内** ⇒ 第二层（分隔符边界）与第三层（realpath 边界）**都会放行**
    // ⇒ 能拦住它的**只有第一层** ⇒ 把第一层拆掉 ⇒ 这条用例必然变红。
    const resolved = resolve(webDir, './sub/../index.html');
    assert.ok(
      resolved.startsWith(resolve(webDir) + sep),
      `探针必须落在 root 之内（否则它测的是第二/三层）：${resolved}`,
    );
    assert.equal(resolved, resolve(webDir, './index.html'), '探针必须归一化到 root 内的真实文件');

    await withServer(app, async (port) => {
      // ── 阳性对照：同一个服务器、同一个文件，去掉 ".." 段就必须是 200 ──
      //    没有这条对照，用例可能因为「服务器根本没起来 / 文件根本不存在」而恒绿。
      const ok = await rawRequest(port, '/index.html');
      assert.ok(ok.includes('200 OK'), `阳性对照：/index.html 必须 200，实际：${ok.slice(0, 120)}`);
      assert.ok(ok.includes('<h1>home</h1>'), '阳性对照：必须真的读到文件内容');

      // ── 真正的断言：带 ".." 段的路径必须被拒 ──
      const blocked = [
        '/sub/../index.html',       // ← 只打到第一层的那条
        '/../etc/passwd',
        '/a/../../etc/passwd',
        '/sub/../../etc/passwd',
        '/%2e%2e/etc/passwd',       // 编码形式：第一层在 decode 之后判 ⇒ 也必须被拒
      ];
      for (const p of blocked) {
        const raw = await rawRequest(port, p);
        assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 必须被拒（不得 200），实际：${raw.slice(0, 120)}`);
        assert.ok(!raw.includes('root:'), `${p} 泄露了 /etc/passwd 的内容`);
      }
    });
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 第二层：「分隔符边界」
// ══════════════════════════════════════════════════════════════════════

test('第二层：分隔符边界防线必须还在（接线断言 + 变异对照 ⇒ 单独拆掉它就会变红）', () => {
  // ⚠️ 必须先剥注释再匹配：否则「把防线改坏、然后在注释里写上正确形态」就能骗过这条断言
  //    （守卫永不触发却仍判绿 —— server.test.js 的终审复核 F-3 就是这个坑）。
  const src = stripComments(readFileSync(STATIC_SRC, 'utf8'));
  assert.ok(
    BOUNDARY_GUARD.test(src),
    'static.js 里必须保留「目标不在 root 之下 ⇒ 直接拒」的防线，且比较必须带分隔符边界（root + sep）',
  );

  // ── 变异对照（阳性对照）：把防线改坏 ⇒ 断言必须**拒绝**它 ──
  //    没有这一段，这条断言自己也可能恒绿（= 钉不住任何东西）。
  const mutants = [
    ['整条防线被删掉', '  const target = resolve(root, `.${relPath}`);\n'],
    ['只比前缀、丢了分隔符边界（C7-1 的原始 bug）',
      '  if (target !== root && !target.startsWith(root)) return false;\n'],
    ['边界条件被削弱成只挡 root 本身',
      '  if (target !== root) return false;\n'],
  ];
  for (const [why, replacement] of mutants) {
    const mutated = src.replace(BOUNDARY_GUARD, replacement);
    assert.notEqual(mutated, src, `变异必须真的改动了源码（否则变异对照是假的）：${why}`);
    assert.ok(
      !BOUNDARY_GUARD.test(mutated),
      `变异「${why}」必须让断言变红 —— 否则这条接线断言钉不住任何东西`,
    );
  }
});

test('第二层：拼出 root 兄弟目录的请求拿不到内容（跨平台稳定）', async () => {
  const { db, close, dataDir, webRoot, app } = setup();
  try {
    await withServer(app, async (port) => {
      // ── 阳性对照：兄弟目录里的文件**确实存在**（否则「拿不到内容」可能是文件不存在）──
      const { existsSync } = await import('node:fs');
      assert.ok(
        existsSync(join(webRoot, 'web-secret', 'passwd')),
        '阳性对照：兄弟目录里的文件必须真的存在',
      );

      // ── 正斜杠形态：'/' 分隔的 '..'（第一层与第二层都会拦）──
      for (const p of ['/../web-secret/passwd', '/sub/../../web-secret/passwd']) {
        const raw = await rawRequest(port, p);
        assert.ok(!/^HTTP\/1\.1 200/.test(raw), `${p} 必须被拒，实际：${raw.slice(0, 120)}`);
        assert.ok(!raw.includes('TOP-SECRET'), `${p} 泄露了兄弟目录的内容`);
      }

      // ── 反斜杠形态：Windows 上第一层放行（'..\..' 是一个段）⇒ 只有第二层能拦 ──
      //    ⚠️ POSIX 上 '\' 是普通文件名字符 ⇒ 这条路径根本解析不出兄弟目录 ⇒ 只会 404
      //    ⇒ 因此这里只断言「**不泄露**」（两平台都必须成立）；
      //    「第二层被拆掉就变红」这个更强的事实由上面的**接线断言**在两平台上保证。
      const winish = '/..\\..\\web-secret\\passwd';
      const rawWin = await rawRequest(port, winish);
      assert.ok(!/^HTTP\/1\.1 200/.test(rawWin), `${winish} 必须被拒，实际：${rawWin.slice(0, 120)}`);
      assert.ok(!rawWin.includes('TOP-SECRET'), `${winish} 泄露了兄弟目录的内容`);
    });
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webRoot, { recursive: true, force: true });
  }
});
```

**Step 11: 创建 test/ops-lifecycle.test.js**

`platform/test/ops-lifecycle.test.js`：

```javascript
// test/ops-lifecycle.test.js — 运维生命周期回归（2026-10-25 评审轮 P1-4 / P2-7）
//
// 覆盖三组：
//   ① P1-4a 写库脚本（seed / migrate）在服务还活着时**必须拒绝**执行（单写者闸）
//   ② P1-4b 两个实例**并发**启动同一个 DATA_DIR ⇒ 只有一个能活（独占创建消 TOCTOU）
//   ③ P2-7a/b prune.js 清理过期数据 + deploy/ 下的 systemd 定时单元
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { insertSession } from '../src/db/repo/sessions.js';
import { incrementBucket } from '../src/db/repo/rate-limit.js';
import { pruneExpiredData, RATE_LIMIT_RETENTION_SECONDS } from '../scripts/prune.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const deployDir = join(platformDir, 'deploy');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');

function readDeploy(name) {
  return readFileSync(join(deployDir, name), 'utf8');
}

// ══════════════════════════════════════════════════════════════════
// P1-4a：单写者闸 —— 写库脚本在服务还活着时必须拒绝执行
// ══════════════════════════════════════════════════════════════════
test('P1-4a 服务还活着时 seed / migrate 必须拒绝执行（单写者闸）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  // 造一个「服务还活着」：pid 文件登记**本进程**的 pid（它确实活着）
  writeFileSync(join(dataDir, 'app.pid'), String(process.pid), 'utf8');

  const cases = [
    ['seed.js', { ADMIN_PASSWORD: '仅用于测试', ADMIN_PHONE: '13900000001' }],
    ['migrate.js', {}],
  ];
  for (const [script, extraEnv] of cases) {
    const res = spawnSync(process.execPath, [join(platformDir, 'scripts', script)], {
      env: { ...process.env, DATA_DIR: dataDir, ...extraEnv },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(res.status, 1, `${script} 必须以退出码 1 拒绝执行（实际 ${res.status}）`);
    assert.match(
      res.stderr,
      /单写者|仍在运行|已被占用/,
      `${script} 必须给人话报错（实际 stderr：${res.stderr.slice(0, 300)}）`,
    );
    // ⛔ 闸必须**在开库之前**拦住 ⇒ 库里不该出现任何表（连迁移都没跑）
    assert.ok(
      !existsSync(join(dataDir, 'app.db')),
      `${script} 在闸拦下之前就已经开库了（单写者闸必须早于开库）`,
    );
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test('P1-4a 服务没在跑时 seed / migrate 必须能正常执行（闸不能误伤）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-gate-ok-'));
  // 前提：目录里**没有** pid 文件 ⇒ 没有活着的服务
  const migrate = spawnSync(process.execPath, [join(platformDir, 'scripts', 'migrate.js')], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(migrate.status, 0, `migrate 必须能跑通（stderr：${migrate.stderr.slice(0, 300)}）`);

  const seed = spawnSync(process.execPath, [join(platformDir, 'scripts', 'seed.js')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: '仅用于测试',
      ADMIN_PHONE: '13900000002',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(seed.status, 0, `seed 必须能跑通（stderr：${seed.stderr.slice(0, 300)}）`);
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// P1-4b：并发启动同一个 DATA_DIR ⇒ 只有一个能活
//   （修复前是「先查 pid 文件、几百毫秒后才写自己的 pid」⇒ 两个都能通过检查）
// ══════════════════════════════════════════════════════════════════
test('P1-4b 同一个 DATA_DIR 并发启动两个实例，只有一个能活', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-race-'));
  const start = () => spawn(process.execPath, [join(platformDir, 'src', 'server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const a = start();
  const b = start();
  let aErr = '';
  let bErr = '';
  a.stderr.on('data', (d) => { aErr += d; });
  b.stderr.on('data', (d) => { bErr += d; });
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const alive = [a, b].filter((p) => p.exitCode === null);
    assert.equal(
      alive.length, 1,
      `同一个 DATA_DIR 起了 ${alive.length} 个实例（必须恰好 1 个）—— 单写者闸没起作用`
      + `（A：${aErr.slice(0, 200)}｜B：${bErr.slice(0, 200)}）`,
    );
    const loser = a.exitCode === null ? b : a;
    const loserErr = a.exitCode === null ? bErr : aErr;
    assert.match(
      loserErr,
      /已被占用|仍在运行|无法解析/,
      `被挡下的那个实例必须给人话报错（实际：${loserErr.slice(0, 300)}）`,
    );
    assert.notEqual(loser.exitCode, null, '被挡下的那个实例必须退出');
  } finally {
    a.kill('SIGKILL');
    b.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// P2-7a：prune 清理过期会话与过期限频计数
// ══════════════════════════════════════════════════════════════════
test('P2-7a prune 删掉过期会话与过期限频计数，且不动还在有效期内的', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-prune-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const user = createUser(db, { name: '清理甲', phone: '13900000003', password: 'pw' });

  insertSession(db, {
    tokenHash: 'h_expired',
    userId: user.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
  });
  insertSession(db, {
    tokenHash: 'h_valid',
    userId: user.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-02T00:00:00.000Z',
  });

  incrementBucket(db, {
    subjectKey: 'login:old',
    rule: 'sliding:loginAttempt',
    bucket: 'old',
    now: '2026-01-01T00:00:00.000Z',
  });
  incrementBucket(db, {
    subjectKey: 'login:new',
    rule: 'sliding:loginAttempt',
    bucket: 'new',
    now: '2026-06-01T00:00:00.000Z',
  });

  const result = pruneExpiredData(db, { now: new Date('2026-06-02T00:00:00.000Z') });
  assert.equal(result.sessions, 1, '过期会话必须被删掉');
  assert.equal(result.rateLimit, 1, '过期限频计数必须被删掉');

  const sessions = db.prepare('SELECT token_hash FROM sessions ORDER BY token_hash').all();
  assert.deepEqual(sessions.map((r) => r.token_hash), ['h_valid'], '未过期的会话必须留下');

  const events = db.prepare('SELECT subject_key FROM rate_limit_events ORDER BY subject_key').all();
  assert.deepEqual(events.map((r) => r.subject_key), ['login:new'], '窗口内的限频计数必须留下');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('P2-7a 限频计数的保留时长必须严格大于任何规则的窗口（否则删了等于绕过限频）', () => {
  // 判据来自**真实规则配置**（rules/audit.json），不是写死的数字：
  // 保留时长一旦小于某个规则的窗口，那个窗口内的计数就会被删掉 ⇒ 限频被绕过。
  const rules = JSON.parse(readFileSync(join(rulesDir, 'audit.json'), 'utf8'));
  let widest = 0;
  for (const [name, profile] of Object.entries(rules.rateLimit || {})) {
    const widths = [
      profile.sliding?.seconds ?? 0,
      profile.lock?.seconds ?? 0,
      profile.perMinute ? 60 : 0,
      profile.perHour ? 3600 : 0,
    ];
    for (const w of widths) widest = Math.max(widest, w);
    assert.ok(widest >= 0, `规则 ${name} 的窗口口径读不出来`);
  }
  assert.ok(widest > 0, 'rules/audit.json 里必须真的有限频规则（否则这条断言是假绿）');
  assert.ok(
    RATE_LIMIT_RETENTION_SECONDS > widest,
    `限频计数保留时长 ${RATE_LIMIT_RETENTION_SECONDS}s 必须严格大于最宽的窗口 ${widest}s`
    + '（否则会删掉还在窗口内的计数 ⇒ 限频被绕过）',
  );
});

// ══════════════════════════════════════════════════════════════════
// P2-7b：systemd 定时单元（备份 / 清理）
// ══════════════════════════════════════════════════════════════════
test('P2-7b deploy/ 下必须有备份与清理的 systemd 单元与定时器', () => {
  const files = [
    'heikesong-backup.service',
    'heikesong-backup.timer',
    'heikesong-prune.service',
    'heikesong-prune.timer',
  ];
  for (const f of files) {
    assert.ok(existsSync(join(deployDir, f)), `缺少 deploy/${f}`);
  }

  // 备份单元：oneshot + 指向真实脚本 + 占位符齐全
  const backupService = readDeploy('heikesong-backup.service');
  assert.match(backupService, /^Type=oneshot$/m, '备份必须是 oneshot（不是第二个常驻写进程）');
  assert.match(backupService, /^ExecStart=.*scripts\/backup\.js$/m, '备份单元必须调用 scripts/backup.js');
  assert.match(backupService, /^User=\w+/m, '备份必须以非 root 运行');
  for (const ph of ['__APP_DIR__', '__DATA_DIR__', '__RUN_USER__']) {
    assert.ok(backupService.includes(ph), `备份单元缺少占位符 ${ph}`);
  }

  // 清理单元：同上
  const pruneService = readDeploy('heikesong-prune.service');
  assert.match(pruneService, /^Type=oneshot$/m, '清理必须是 oneshot');
  assert.match(pruneService, /^ExecStart=.*scripts\/prune\.js$/m, '清理单元必须调用 scripts/prune.js');

  // 定时器：OnCalendar 合法 + Persistent + Unit 指向真实存在的 service
  for (const [timer, service] of [
    ['heikesong-backup.timer', 'heikesong-backup.service'],
    ['heikesong-prune.timer', 'heikesong-prune.service'],
  ]) {
    const unit = readDeploy(timer);
    assert.match(unit, /^OnCalendar=\*-\*-\* \d{2}:\d{2}:\d{2}$/m, `${timer} 必须有合法的每日触发时刻`);
    assert.match(unit, /^Persistent=true$/m, `${timer} 必须 Persistent（关机期间错过的要补跑）`);
    assert.match(unit, new RegExp(`^Unit=${service}$`, 'm'), `${timer} 必须指向 ${service}`);
    assert.match(unit, /^WantedBy=timers\.target$/m, `${timer} 必须开机自启`);
  }
});

test('P2-7b install.sh 必须安装并启用这两个定时器', () => {
  const sh = readDeploy('install.sh');
  assert.match(sh, /heikesong-backup\.timer/, 'install.sh 必须安装备份定时器');
  assert.match(sh, /heikesong-prune\.timer/, 'install.sh 必须安装清理定时器');
  assert.match(
    sh, /systemctl enable --now [^\n]*heikesong-backup\.timer/,
    '备份定时器必须被 enable 且立即启动',
  );
  assert.match(
    sh, /systemctl enable --now [^\n]*heikesong-prune\.timer/,
    '清理定时器必须被 enable 且立即启动',
  );
});

test('P1-4a install.sh 必须在迁移/种子之前停服（否则新闸会让升级直接失败）', () => {
  // ⚠️ 这条是**顺序**断言，不是「有没有这个函数」的断言：
  //    迁移改的是 schema、种子改的是权限规则 ⇒ 服务还在跑时执行会写坏库
  //    ⇒ scripts/migrate.js 与 scripts/seed.js 现在自己会拒绝执行
  //    ⇒ install.sh 必须**先停服**，否则「升级一台在跑的服务」会直接失败。
  const sh = readDeploy('install.sh');
  const mainIdx = sh.indexOf('\nmain() {');
  assert.ok(mainIdx > 0, '找不到 main()，测试本身失效');
  const mainBody = sh.slice(mainIdx);

  const stopIdx = mainBody.indexOf('stop_service_for_maintenance');
  const initIdx = mainBody.indexOf('init_database');
  assert.ok(stopIdx > 0, 'main() 里必须调用停服步骤（升级时服务是运行中的）');
  assert.ok(initIdx > 0, 'main() 里必须调用 init_database，测试本身失效');
  assert.ok(
    stopIdx < initIdx,
    '⛔ 停服必须在 init_database（迁移 + 种子）**之前** —— 否则升级时闸会拒绝执行',
  );

  // 停服函数本身必须真的停（不能只是打条日志）
  const fn = sh.slice(sh.indexOf('stop_service_for_maintenance() {'));
  assert.match(fn, /systemctl stop "\$SERVICE_NAME"/, '停服函数必须真的 systemctl stop');
  assert.match(fn, /systemctl is-active/, '停服前必须先判断服务是否在跑（首次安装时它不在跑）');
});
```

## 5. 收尾闸（本阶段交付前必须全绿）

1. **全量测试**：`cd platform && node --test` ⇒ 1993 例全绿
   （审计基线是 `1991 / 1963 pass / 27 fail / 1 skipped`）。
2. **三档 Node**：`22.16.0`（`engines` 最低版本）/ `22.x` / `24.x` ⇒ 结果**逐字一致**。
3. **五道机器闸**：`audit-scan.js` / `temp-leak-scan.js` / `bash-var-scan.js` /
   `dead-service-scan.mjs` / `plan-block-audit.mjs` ⇒ 退出码全 0，
   且 `plan-block-audit` 报 **C-RW = 0**。
4. **变异检验**：每批的每条修法都要有**被杀死的变异**（存活 ⇒ 补判别性场景）。

### 4.9 2026-10-27 E181 轮（S-8 评审覆盖率闸 + S-9 按时发榜闸 + A3 过滤键闸 + 预演数据）—— 新建文件登记

本轮新建了以下文件。按本仓纪律「**新建文件必须登记进计划块，否则它的漂移查不出来**」，逐个登记如下：

| 文件 | 为什么必须是**新文件** |
|---|---|
| `platform/src/services/readiness.js` | S-8（评审覆盖率汇总闸）与 S-9（超期未发榜告警）**必须自成一个服务**：① 两条闸的**口径**（应交格子怎么算、发榜时刻怎么取）与评审工作台、发榜流程**共用** `getReviewState` / `listSnapshotsByStage` ⇒ 放在既有服务里会与「工作台进度」「发榜」两套口径纠缠；② 两条闸要能被**预演脚本**与 **HTTP 端点**同时调用 ⇒ 不能只挂在某个路由的私有函数上；③ 它是**新增的聚合口径**，塞进 `services/review.js`（P2 owns）会把 P2 的文件撑成第二个「什么都管」的文件。 |
| `platform/src/http/routes/readiness.js` | `GET /api/readiness` 是**组委会专用**的运营读口 ⇒ 权限口径（`audit:read`，只有组委会持有）与形状（按赛段聚合的业务指标）都与既有端点不同 ⇒ 独立成文件才能把「403 而不是 200+空集」这条 fail-closed 纪律写在**文件头**（空集会被读成「各项都达标」）。 |
| `platform/src/db/repo/preview-data.js` | ⛔ 仓内纪律「**所有 SQL 字符串必须收在 platform/src/db/repo/ 下；handler / 脚本里禁止裸 SQL**」（设计文档 §7.2 + 评审编号 I-7，守卫见 `test/sql-boundary.test.js`）⇒ 预演数据要写库，INSERT 语句**只能**住在仓储层。⚠️ 它刻意**绕过业务服务的全部校验与副作用** ⇒ 因此**只能**被预演脚本调用 ⇒ 已登记进 `docs/tools/dead-service-scan.allow.json` 的「种子/运维脚本路径」一类（不塞进 allow 糊弄 ⇒ 理由写全）。 |
| `platform/db/preview/preview-dataset.js` | 预演数据集（**纯数据**，不写库、不含 SQL）必须**独立于**生产种子数据：`scripts/seed.js` 灌的是「可用的最小演示数据」，而本轮要的是「把每个功能用到的数据摆出来、覆盖每个分支」⇒ 两者混在一起会互相污染。⚠️ 它的行**列名与生产表逐字一致** ⇒ 写错列名会被仓储层的 `PRAGMA table_info` 检查当场抓住。 |
| `platform/scripts/preview-seed.js` | 建**临时库**（生产同款迁移 ⇒ 表结构一致）+ 灌预演数据 ⇒ 必须是**独立脚本**（不碰生产库 `platform/data/app.db`，脚本里有三道安全闸：目录写死成 `preview` / 目标目录有 `app.db` 就拒绝 / 默认重建）。 |
| `platform/scripts/preview-report.js` | 「**人话**报告」是给**评审**看的 ⇒ 与机器读的结构化输出（`--json`）分开成脚本，避免把「给人看的措辞」写进 API 契约里。⚠️ 它读的是临时库 ⇒ 真实数据到位后**一个字都不用改**。 |
| `platform/test/readiness.test.js` | S-8 / S-9 的判别性用例**自成一套口径断言**（应交格子数 = 席位数 × 队数 × 维度数、覆盖率百分比、超期小时数、not_applicable 的 null）⇒ 塞进既有测试文件会让「这条钉的是哪条口径」看不出来。 |
| `platform/test/audit-filter.test.js` | A3（过滤键静默失效）的用例要**并排**钉住三端点的三份白名单（同一个键在另一个端点必须 400）⇒ 自成文件才能把「白名单互不相同」这条不变量写成一条用例。 |

⚠️ 本轮**同时**改了 4 个既有文件（`src/http/routes/audit.js` → P4 owns、`src/server.js` → P0 owns、
`src/config.js` → P0 owns、16 份 `rules/*.json` → 各自 owning 阶段）⇒ 它们的计划块**已用
`docs/tools/plan-block-sync.mjs` 逐字同步回 owning 阶段**（C-RW 必须清零）。
⚠️ 规则集又升了一版：`2026-10-26` → **`2026-10-27`**（16 份全改 ——
本轮给 `rules/compliance.json` 加了 `readiness` 阈值段 ⇒ 版本必须全等，否则 `loadRules` 拒绝启动）。

**Step 1: 创建 src/services/readiness.js**

`platform/src/services/readiness.js`：

```javascript
// src/services/readiness.js — S-7~S-10 业务就绪度闸（E181，2026-10-27）
//
// 规则溯源：设计文档 §1.3.1「S-7~S-10：怎么量、今天有没有机器检查」
//   · S-8 评审无漏评 —— 数据来源：`stage_reviews` 空缺 + 计算 trace 的 `normalization` 段
//     ⇒ spec §1.3.1 原文：「⚠️ **部分**：`judge_pool_invalid` / `normalization_fallback`
//       已在 trace 里**显式产出**（S-5），但**没有**「漏评覆盖率」的汇总闸」⇒ **待补**。
//   · S-9 按时发榜 —— 数据来源：`leaderboard_snapshots.created_at` vs 赛段 `ends_at`
//     ⇒ spec §1.3.1 原文：「⚠️ **部分**：发榜时刻已入库，但**没有**「超 72 小时」的告警」⇒ **待补**。
//   · S-10 闭环时效与产出 —— 申诉 SLA 已由 rules/compliance.json 的 `appeal.slaHours` 驱动
//     （M0-2 落地）；「完赛认定数 > 0」**需要真实赛事数据** ⇒ 本文件**不假装能算**。
//
// ⚠️ **本文件为什么从「真实表」读，而不是从「临时表」读**：
//    E181 的做法是 —— 先用一份**预演数据集**（同样的表结构、装在临时库里）让功能可被评审；
//    真实赛事数据到位后**直接灌进同一套表** ⇒ 本文件的代码**一行都不用改**。
//    ⇒ ⛔ 本文件里**不许**出现任何「预演/演示专用」的分支（那会让预演数据与真实数据走两套口径）。
//
// ⚠️ **口径纪律（S-8 的「应交」怎么算）**：
//    应交格子 = **有投票权席位数 × 赛段名册队数 × 评委席维度数**
//    —— 判据取自 `services/review.js` 的 `getReviewState`（**不另起一套**）：
//    ① 名册用 `resolveStageRoster`（赛段级优先、届期级兜底）—— 与外队进榜拦截同一口径；
//    ② 席位排除 `observer`（R-JDG-11：观察员无投票权）；
//    ③ 维度只算 `seat === 'judge'` 的（`enterprise` 维度走企业确认、`self` 维度走自评，
//       **都不落在 `stage_reviews`** —— 写路径 `POST /api/stages/:id/reviews` 白名单同款）。
//    ⇒ **复用 getReviewState 而不是重算一遍**，是为了让「闸里看到的覆盖率」与
//      「评审工作台上显示的进度」**永远是同一个数**（同款纪律见 services/review.js:348
//      「三样东西原先分散在三个地方，且三个口径会各自漂移」）。
//
// ⚠️ **fail-closed 的两处**：
//    ① `expected === 0`（没有席位 / 没有名册 / 没有维度）⇒ 覆盖率**不可判定**，
//       本文件返回 `status: 'not_applicable'` + `coveragePercent: null`，
//       **绝不返回 100%**（那是把「没东西可评」说成「全都评了」）。
//    ② `submitted > expected`（数据异常：写路径禁止非评委席维度进 `stage_reviews`）
//       ⇒ 覆盖率封顶 100% 并显式给出 `overSubmitted: true` + `warnings`，**不静默吞掉**。
import { getStage } from '../db/repo/stages.js';
import { listStages } from '../db/repo/stages.js';
import { listSnapshotsByStage } from '../db/repo/leaderboard.js';
import { listTeamRows } from '../db/repo/teams.js';
import { hasStageRoster, listStageTeamIds } from '../db/repo/stage-teams.js';
import { getReviewState } from './review.js';
import { AppError } from '../errors.js';

const HOUR_MS = 3600 * 1000;

/** 阈值全部来自 rules/compliance.json 的 `readiness` 段 —— 代码里**不硬编码**任何数字。 */
function thresholdsOf(rules) {
  const r = rules?.compliance?.readiness ?? {};
  return {
    minReviewCoveragePercent: Number(r.minReviewCoveragePercent ?? 90),
    publishDeadlineHours: Number(r.publishDeadlineHours ?? 72),
    minTeamsForScale: Number(r.minTeamsForScale ?? 4),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * S-8：某赛段的评审覆盖率（漏评闸）。
 *
 * @param {object} db
 * @param {string} stageId
 * @param {object} [rules] 规则集（用于取维度全集与阈值）
 * @returns {object} 覆盖率报告
 */
function reviewCoverage({ db, stageId, rules = null }) {
  const stage = getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');
  const config = rules?.scoring?.[stage.scoring_config_key];
  if (!config) {
    throw new AppError(500, 'SCORING_CONFIG_MISSING', `赛段 ${stageId} 指向的权重表 ${stage.scoring_config_key} 不存在`);
  }
  const judgeDimensions = (config.dimensions ?? []).filter((d) => d.seat === 'judge').map((d) => d.key);
  const { minReviewCoveragePercent } = thresholdsOf(rules);

  // ⚠️ **「这段开打了没有」的前置判断**：名册（stage_team）没登记 ⇒ 这段还没开打。
  //    ⇒ 此时**不给覆盖率结论**（not_applicable），而不是给一个基于届期兜底名册算出来的数。
  //    ⛔ 为什么不用 `resolveStageRoster` 的届期兜底名册：
  //       它回落到「本届全部队伍」⇒ 一个**根本没开的赛段**也会算出覆盖率
  //       （4 队 × 4 席 × 5 维 = 80 格，没交 ⇒ 0%）⇒ 把「还没开始」说成「全部漏评」。
  //    ⇒ 闸用**赛段级名册**（stage_team），与 S-9 的发榜时限判据**同一把尺**。
  //    ✅ 口径一致性：名册登记过之后，`getReviewState` 内部用的 `resolveStageRoster`
  //       也正是 stage_team ⇒ 闸里的数与评审工作台上的数**同一个**。
  if (!hasStageRoster(db, stageId)) {
    return {
      stageId: stage.id,
      stageKey: stage.key,
      stageName: stage.name,
      status: 'not_applicable',
      statusNote: '赛段名册未登记 ⇒ 这段还没开打（不判定覆盖率）',
      expected: null,
      submitted: null,
      coveragePercent: null,
      thresholdPercent: minReviewCoveragePercent,
      complete: false,
      overSubmitted: false,
      missingCount: null,
      missing: [],
      byDimension: {},
      warnings: [],
    };
  }

  // ⚠️ 复用 getReviewState 的**管理员口径**（isAdmin ⇒ 应交/已交/缺谁 全量）
  const progress = getReviewState({
    db,
    stageId,
    viewer: { userId: null, isAdmin: true },
    dimensions: judgeDimensions,
  });

  const expected = progress.total;
  const submitted = progress.submitted;
  const warnings = [];
  const overSubmitted = submitted > expected;
  if (overSubmitted) {
    warnings.push(
      `已交格子数（${submitted}）大于应交格子数（${expected}）⇒ 数据异常：`
      + 'stage_reviews 里出现了不该存在的维度评分（写路径本应挡住）',
    );
  }
  if (expected === 0) {
    // ⛔ fail-closed：没有应交格子 ⇒ **不可判定**，不是 100%
    return {
      stageId: stage.id,
      stageKey: stage.key,
      stageName: stage.name,
      status: 'not_applicable',
      statusNote: '没有应交格子（无投票权席位 / 无名册 / 无评委席维度）⇒ 覆盖率不可判定',
      expected: 0,
      submitted: 0,
      coveragePercent: null,
      thresholdPercent: minReviewCoveragePercent,
      complete: false,
      overSubmitted: false,
      missingCount: 0,
      missing: [],
      byDimension: progress.dimensionProgress ?? {},
      warnings,
    };
  }
  const coveragePercent = round2(Math.min(submitted, expected) / expected * 100);
  return {
    stageId: stage.id,
    stageKey: stage.key,
    stageName: stage.name,
    status: 'measurable',
    statusNote: null,
    expected,
    submitted,
    coveragePercent,
    thresholdPercent: minReviewCoveragePercent,
    complete: coveragePercent >= minReviewCoveragePercent,
    overSubmitted,
    missingCount: progress.missing.length,
    // ⚠️ missing 的条数 = 席位数 × 队数 × 维度数 —— 大赛段可能上千条
    //    ⇒ 列表**截断**并给出总数（完整清单走详情端点 / 预演报告脚本）。
    missing: progress.missing.slice(0, 200),
    byDimension: progress.dimensionProgress ?? {},
    warnings,
  };
}

/**
 * S-9：赛段发榜时限（超期未发榜告警）。
 *
 * 判定口径：从赛段 `ends_at` 起算，到**第一条发榜快照**的 `created_at` 为止。
 * ⚠️ 为什么取「第一条」：一次发榜会写 3 个 scope 的快照（rank/business/personal，
 *    `services/leaderboard.js` 的 SCOPES），它们 `createdAt` 相同 ⇒ 取最早的一条即发榜时刻。
 *
 * @param {object} db
 * @param {string|null} [editionId] 届期；不传则扫全部赛段
 * @param {object} [rules]
 * @param {string|null} [now] ISO 时刻（不传取当前时间）
 */
function publishDeadlines({ db, editionId = null, rules = null, now = null }) {
  const { publishDeadlineHours } = thresholdsOf(rules);
  const at = now ?? new Date().toISOString();
  const atMs = Date.parse(at);
  const stages = listStages(db, editionId ? { editionId } : {});

  const rows = stages.map((stage) => {
    const endsAt = stage.ends_at;
    const endsMs = Date.parse(endsAt);
    // ⚠️ **赛段级名册（stage_team）**，不是届期级兜底名册 —— 与 S-8 同一把尺。
    //    理由见 reviewCoverage 的注释：没登记名册的赛段**还没开打** ⇒ 不该判它「超期没发榜」。
    const roster = listStageTeamIds(db, stage.id);
    const snapshots = listSnapshotsByStage(db, stage.id);
    const publishedAt = snapshots.length ? snapshots[0].created_at : null;

    const base = {
      stageId: stage.id,
      stageKey: stage.key,
      stageName: stage.name,
      endsAt,
      publishedAt,
      rosterSize: roster.length,
      deadlineHours: publishDeadlineHours,
      delayHours: null,
      overdue: false,
    };

    if (!Number.isFinite(endsMs)) {
      // ⛔ 赛段没有可解析的结束时间 ⇒ 不可判定（不假装它是「没超期」）
      return { ...base, state: 'unknown_end', overdue: false, note: '赛段结束时间不可解析 ⇒ 不可判定' };
    }
    if (atMs < endsMs) {
      return { ...base, state: 'not_due', overdue: false, note: '赛段尚未结束' };
    }
    if (!roster.length) {
      // ⚠️ 没有名册的赛段**不计入超期**（还没建队 / 这段没真办）
      //    ⇒ 但**照样列出来**（人能看到），并写明原因。
      return { ...base, state: 'no_roster', overdue: false, note: '赛段没有名册 ⇒ 不计入超期（但请确认这段是否真的不办）' };
    }
    if (!publishedAt) {
      return {
        ...base,
        state: 'never_published',
        overdue: true,
        delayHours: round2((atMs - endsMs) / HOUR_MS),
        note: `赛段已结束 ${round2((atMs - endsMs) / HOUR_MS)} 小时，仍未发榜`,
      };
    }
    const delayHours = round2((Date.parse(publishedAt) - endsMs) / HOUR_MS);
    const late = delayHours > publishDeadlineHours;
    return {
      ...base,
      state: late ? 'late' : 'published',
      overdue: late,
      delayHours,
      note: late
        ? `发榜比时限晚 ${round2(delayHours - publishDeadlineHours)} 小时（时限 ${publishDeadlineHours} 小时）`
        : '按时发榜',
    };
  });

  const overdue = rows.filter((r) => r.overdue);
  return {
    now: at,
    deadlineHours: publishDeadlineHours,
    stageCount: rows.length,
    overdueCount: overdue.length,
    overdueStageIds: overdue.map((r) => r.stageId),
    stages: rows,
  };
}

/**
 * S-7~S-10 汇总：把能算的算出来，把**不能算的明说不能算**。
 *
 * ⛔ **不许在这里把「没数据」写成「达标」**：
 *   · S-7 规模：队伍数可算（但「报名数」口径需真实赛事数据校准）；
 *   · S-8 评审覆盖：可算（见 reviewCoverage）；
 *   · S-9 按时发榜：可算（见 publishDeadlines）；
 *   · S-10 闭环时效：申诉 SLA 部分可算（review-state 已有），「完赛认定数」**需要真实数据**。
 */
export function readinessSummary({ db, editionId = null, rules = null, now = null }) {
  const at = now ?? new Date().toISOString();
  const { minTeamsForScale } = thresholdsOf(rules);
  const teams = editionId ? listTeamRows(db, { editionId }) : listTeamRows(db, {});
  const coverage = editionId
    ? listStages(db, { editionId }).map((s) => reviewCoverage({ db, stageId: s.id, rules }))
    : listStages(db, {}).map((s) => reviewCoverage({ db, stageId: s.id, rules }));
  const deadlines = publishDeadlines({ db, editionId, rules, now: at });

  const measurable = coverage.filter((c) => c.status === 'measurable');
  const worst = measurable.length
    ? measurable.reduce((a, b) => (b.coveragePercent < a.coveragePercent ? b : a))
    : null;

  return {
    now: at,
    editionId: editionId ?? null,
    s7: {
      // 数据来源：teams 行数（spec §1.3.1「`teams` / `registrations` 行数」）
      teamCount: teams.length,
      thresholdTeams: minTeamsForScale,
      met: teams.length >= minTeamsForScale,
      note: '只数了**队伍数**；「报名数」口径（registrations 行数与去重规则）待真实赛事数据校准',
    },
    s8: {
      stageCount: coverage.length,
      measurableCount: measurable.length,
      worstStageId: worst?.stageId ?? null,
      worstCoveragePercent: worst?.coveragePercent ?? null,
      met: measurable.length > 0 && measurable.every((c) => c.complete),
      stages: coverage,
    },
    s9: {
      stageCount: deadlines.stageCount,
      overdueCount: deadlines.overdueCount,
      overdueStageIds: deadlines.overdueStageIds,
      met: deadlines.overdueCount === 0,
      deadlineHours: deadlines.deadlineHours,
      stages: deadlines.stages,
    },
    s10: {
      // 申诉 SLA 已由 services/review-state.js 落地（M0-2）；这里只做**状态声明**
      met: null,
      note: '申诉 SLA 部分已落地（rules/compliance.json 的 appeal.slaHours）；'
        + '「完赛认定数 > 0」与「按时发榜率 ≥ 90%」**需要真实赛事数据** ⇒ 本闸不判定',
    },
  };
}
```

**Step 2: 创建 src/http/routes/readiness.js**

`platform/src/http/routes/readiness.js`：

```javascript
// src/http/routes/readiness.js — S-7~S-10 业务就绪度端点（E181，2026-10-27）
//
// 规则溯源：设计文档 §1.3.1「S-7~S-10：怎么量、今天有没有机器检查」
//   · S-7 规模达标       → teams / registrations 行数
//   · S-8 评审无漏评     → stage_reviews 空缺 + 计算 trace 的 normalization 段
//   · S-9 按时发榜       → leaderboard_snapshots.created_at vs 赛段 ends_at
//   · S-10 闭环时效与产出 → appeals（SLA 字段已入库）+ milestone_signoffs + 行为分完赛认定
//
// ⛔ **权限口径**：`audit:read`（**只有组委会持有**，见 scripts/seed.js 的 ROLE_CAPABILITIES）
//    —— 这份汇总里含「哪些赛段没发榜」「哪些格子没评分」这类**内部运营信息**。
//    ⇒ 未登录 → 401；有登录但无能力点 → 403（**不是** 200 + 空集 ——
//      空集会被误读成「都达标了」，那是本文件最危险的误读方向）。
//
// ⚠️ **为什么是独立端点而不是塞进 /api/audit/log**：
//    ① 口径完全不同（一个是审计行，一个是**按赛段聚合的业务指标**）；
//    ② 权限不同（审计日志是审计:read 起步，复核队列是 audit:write 才能裁决）；
//    ③ 形状不同（聚合结构 vs 分页行）⇒ 混在一起会让前端拿到两套没法对齐的数组。
//
// ⛔ **可见性在 API 层过滤（白名单，fail-closed）**：本端点只吐**聚合数与 id**，
//    **不吐**任何队伍的名称、手机号、分数明细（明细走各自的既有端点，那里才有可见性规则）。
import { listEditions } from '../../db/repo/editions.js';
import { can } from '../../auth/permissions.js';
import { unauthenticated, forbidden, notFound } from '../../errors.js';
import { readinessSummary } from '../../services/readiness.js';
import { pickCurrentEdition } from './registration.js';

function requireLogin(user) {
  if (!user) throw unauthenticated();
}

export function registerReadinessRoutes(router, { db, rules }) {
  router.add('GET', '/api/readiness', async ({ user, query }) => {
    requireLogin(user);
    // ⛔ 无 `audit:read` ⇒ 403（不是空集）：空集会被读成「各项都达标」。
    if (!can(user, 'audit:read', null, db)) throw forbidden('无权查看业务就绪度汇总');

    // 届期口径与注册端点一致：**当届** = 尚未结束的最早一届，都没有就退回最后一届。
    // ⚠️ 允许显式传 `?editionId=` 查历史届期（组委会要复盘上一届时用）。
    const editions = listEditions(db);
    const edition = query?.editionId
      ? editions.find((e) => e.id === query.editionId) ?? null
      : pickCurrentEdition(editions);
    if (query?.editionId && !edition) {
      // 显式指定了不存在的届期 ⇒ 404（不静默退回「当届」—— 那会查错届期而不报错）
      throw notFound(`届期不存在：${query.editionId}`);
    }
    return readinessSummary({
      db,
      editionId: edition?.id ?? null,
      rules,
      now: new Date().toISOString(),
    });
  });
}
```

**Step 3: 创建 src/db/repo/preview-data.js**

`platform/src/db/repo/preview-data.js`：

```javascript
// src/db/repo/preview-data.js — 预演数据集的**写入口**（E181，2026-10-27）
//
// ⚠️ **为什么这个文件存在**：仓内纪律「**所有 SQL 字符串必须收在 platform/src/db/repo/ 下；
//    handler / 脚本里禁止裸 SQL**」（设计文档 §7.2 + 评审编号 I-7，
//    见 test/sql-boundary.test.js 的守卫）。
//    ⇒ 预演数据要写库，就得从仓储层出去 ⇒ 由本文件承担。
//
// ⚠️ **它做的是「按表插行」，不是「业务写入」**：
//    预演数据的目的是**把每个功能用到的数据摆出来**，让功能可被评审；
//    它刻意**绕过业务服务的全部校验与副作用**（不建冲突声明、不算分、不写审计…）。
//    ⇒ ⛔ 因此它**只能被预演脚本调用**，不许被业务代码当通用写入口用
//      （已登记进 docs/tools/dead-service-scan.allow.json 的「种子/运维脚本路径」一类）。
//
// ⚠️ **列名必须与生产表逐字一致**：本文件按 `PRAGMA table_info` 读真实列名，
//    数据集里写错列名 ⇒ **立刻抛错**（插不进去）⇒ 「预演数据与生产表不同格式」当场暴露。
/**
 * 把一批行插进指定表（内部函数，不导出 —— 唯一的对外入口是 insertDataset）。
 */
function insertRows(db, table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.length) throw new Error(`预演数据：表 ${table} 不存在（迁移没跑？）`);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!cols.includes(key)) {
        throw new Error(
          `预演数据：${table} 有列「${key}」，但生产表没有这一列 ⇒ 数据集与生产表不同格式`,
        );
      }
    }
  }
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
  }
  return rows.length;
}

/**
 * 按「表名 → 行数组」的映射批量插入（**顺序由调用方决定**：外键依赖在前）。
 *
 * @param {object} db
 * @param {Record<string, object[]>} dataset
 * @param {string[]} order 插入顺序（表名数组）
 * @returns {Record<string, number>} 每张表插了多少行
 */
export function insertDataset(db, dataset, order) {
  const counts = {};
  for (const table of order) {
    counts[table] = insertRows(db, table, dataset[table] ?? []);
  }
  return counts;
}
```

**Step 4: 创建 db/preview/preview-dataset.js**

`platform/db/preview/preview-dataset.js`：

```javascript
// platform/db/preview/preview-dataset.js — 预演数据集（E181，2026-10-27）
//
// ⚠️ **这是「临时表」的数据侧**：预演数据装在一个**临时库**里，
//    库的 schema 由**生产同款迁移**建出来 ⇒ 表结构与生产**逐字一致**。
//    ⇒ 真实赛事数据到位后，**直接灌进同一套表** ⇒ services/readiness.js 的代码**一行都不用改**。
//    ⇒ ⛔ 本文件只提供**数据**；不许在这里出现任何「让闸更好通过」的特判。
//
// ⚠️ **为什么用相对日期而不是写死日期**：
//    写死的日期会随时间流逝而失效（今天「超期」的赛段，明天就变成「未到期」）。
//    ⇒ 所有时间都相对**锚点时刻**生成 ⇒ 无论什么时候跑预演，
//      五个赛段分别落在五个**分支**上（下面「场景矩阵」那一段就是验收标准）。
//
// ⚠️ **列名与生产表逐字一致**：本文件每一行都直接对应一张生产表的一行，
//    插入时按**表的名字**映射（见 scripts/preview-seed.js）⇒ 改列名会立刻插不进去（好事）。
//
// ── 场景矩阵（本文件的核心验收标准）────────────────────────────────
//   赛段 s1 调研   名册4队 席位3评委+1企业+1观察员 评分满格   → S-8 100% 达标 ｜ S-9 按时发榜（+24h）
//   赛段 s2 任务   同上但**故意漏 17 格**            → S-8 78.75% **不达标** ｜ S-9 超期发榜（+90h）
//   赛段 s3 开发   评分满格但**从未发榜**             → S-8 100% 达标 ｜ S-9 **never_published**
//   赛段 s4 路演   **没登记名册**（还没开打）        → S-8 **not_applicable** ｜ S-9 **no_roster**
//   赛段 s5 落地   尚未结束                          → S-8 部分评分（不给结论的重点段）｜ S-9 **not_due**
//
// ⚠️ **观察员（observer）不进应交格子**（R-JDG-11：观察员无投票权）
//    ⇒ s1 的应交 = 4 个有投票权席位 × 4 队 × 5 个评委席维度 = **80 格**。
//    ⚠️ **企业席（enterprise）有投票权** ⇒ 它**要打分**，且同样只打评委席维度。
//    ⚠️ **评委席维度**：初赛 5 个（track_fit / innovation / feasibility / completeness / collaboration）；
//    `enterprise` 维度走企业确认、`self` 维度走自评，**都不落在 stage_reviews**。

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const JUDGE_DIMS_INITIAL = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];
const JUDGE_DIMS_FINAL = ['innovation', 'feasibility', 'completeness', 'collaboration'];

const VOTING_SEATS = [
  { userId: 'pv-judge-1', seat: 'judge' },
  { userId: 'pv-judge-2', seat: 'judge' },
  { userId: 'pv-judge-3', seat: 'judge' },
  { userId: 'pv-ent-1', seat: 'enterprise' },
];
const OBSERVER = { userId: 'pv-obs-1', seat: 'observer' };

const TEAMS = ['pv-team-1', 'pv-team-2', 'pv-team-3', 'pv-team-4'];
const CAPTAINS = ['pv-cap-1', 'pv-cap-2', 'pv-cap-3', 'pv-cap-4'];

/**
 * s2 故意漏掉的 17 格（**刻意分组**，便于评审时看出「漏评长什么样」）：
 *   · judge-3 完全没评 team-4            → 5 格
 *   · judge-2 漏评 team-4 的 4 个维度      → 4 格
 *   · ent-1   漏评 team-3 的 4 个维度      → 4 格
 *   · judge-1 漏评 team-2 的 4 个维度      → 4 格
 *   合计 17 格 ⇒ 覆盖率 = (80-17)/80 = 78.75% < 90% ⇒ **不达标**
 */
const S2_MISSING = new Set([
  ...['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-judge-3|pv-team-4|${d}`),
  ...['innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-judge-2|pv-team-4|${d}`),
  ...['innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-ent-1|pv-team-3|${d}`),
  ...['innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-judge-1|pv-team-2|${d}`),
]);

function iso(anchorMs, offsetMs) {
  return new Date(anchorMs + offsetMs).toISOString();
}

/**
 * 生成一份完整的预演数据集。
 * @param {Date|string|number} [anchor] 锚点时刻（默认当前时间）
 * @returns {object} 按**表名**分组的行数组（列名与生产表逐字一致）
 */
export function buildPreviewDataset(anchor = new Date()) {
  const anchorMs = anchor instanceof Date ? anchor.getTime() : Date.parse(anchor);
  const nowIso = iso(anchorMs, 0);

  // ── editions ────────────────────────────────────────────────────
  const editions = [{
    id: 'pv-ed-1',
    name: '预演届期 · 华东区 AI 商业黑客松',
    city: '上海',
    starts_at: iso(anchorMs, -30 * DAY),
    ends_at: iso(anchorMs, 30 * DAY),
    created_at: iso(anchorMs, -30 * DAY),
  }];

  // ── cities ──────────────────────────────────────────────────────
  const cities = [{ id: 'pv-city-1', name: '上海', edition_id: 'pv-ed-1' }];

  // ── users ───────────────────────────────────────────────────────
  // ⚠️ phone 用**不可拨号的占位串**（不是 11 位数字）——
  //    既不会撞真实号码，也不会被敏感值扫描误判成「疑似真实手机号」。
  const mkUser = (id, name, extra = {}) => ({
    id,
    name,
    phone: `pv-${id}`,
    password_hash: 'preview-only-not-a-real-hash',
    mba_status: 'other',
    org: null,
    is_superadmin: 0,
    active: 1,
    created_at: iso(anchorMs, -30 * DAY),
    ...extra,
  });
  const users = [
    mkUser('pv-admin-1', '预演组委会', { is_superadmin: 1, org: '组委会' }),
    mkUser('pv-judge-1', '预演评委一', { org: '预演企业 A' }),
    mkUser('pv-judge-2', '预演评委二', { org: '预演企业 B' }),
    mkUser('pv-judge-3', '预演评委三', { org: '预演企业 C' }),
    mkUser('pv-ent-1', '预演企业席', { org: '预演企业 D' }),
    mkUser('pv-obs-1', '预演观察员', { org: '预演媒体' }),
    ...CAPTAINS.map((id, i) => mkUser(id, `预演队长${i + 1}`, { mba_status: 'mba' })),
  ];

  // ── task_packages ───────────────────────────────────────────────
  const taskPackages = CAPTAINS.map((capId, i) => ({
    id: `pv-tp-${i + 1}`,
    edition_id: 'pv-ed-1',
    enterprise_id: null,
    enterprise_name: `预演企业 ${String.fromCharCode(65 + i)}`,
    title: `预演任务卡 ${i + 1}`,
    pain_point: '预演痛点（占位）',
    expected_delivery: '预演交付物（占位）',
    acceptance_criteria: '预演验收标准（占位）',
    grade: 'A',
    status: 'approved',
    solvability_score: 3,
    solvability_grade: 'A',
    commitment: null,
    agreement: null,
    is_free_brief: 0,
    submitted_by: capId,
    submitted_at: iso(anchorMs, -29 * DAY),
    approved_by: 'pv-admin-1',
    approved_at: iso(anchorMs, -29 * DAY),
    meta_json: null,
    deleted_at: null,
  }));

  // ── teams ───────────────────────────────────────────────────────
  const teams = CAPTAINS.map((capId, i) => ({
    id: TEAMS[i],
    edition_id: 'pv-ed-1',
    name: `预演战队 ${i + 1}`,
    captain_id: capId,
    task_package_id: `pv-tp-${i + 1}`,
    tier: 'B',
    status: 'active',
    milestones_json: null,
    created_at: iso(anchorMs, -28 * DAY),
    deleted_at: null,
  }));

  // ── stages ──────────────────────────────────────────────────────
  // ⛔ 赛段时间全部相对锚点（见文件头「为什么用相对日期」）
  // ⚠️ `roster` 是**预演专用标记**（这段开没开打），**不进生产表** ⇒ 单独留在 specs 里，
  //    不能混进 stages 行（stageReviews / stageJudges / stage_team 都要按它分支）。
  const stageSpecs = [
    {
      id: 'pv-stg-s1', key: 's1', name: '调研', kind: 'initial',
      starts_at: iso(anchorMs, -14 * DAY), ends_at: iso(anchorMs, -10 * DAY),
      scoring_config_key: 'initial', roster: true,
    },
    {
      id: 'pv-stg-s2', key: 's2', name: '任务', kind: 'initial',
      starts_at: iso(anchorMs, -9 * DAY), ends_at: iso(anchorMs, -6 * DAY),
      scoring_config_key: 'initial', roster: true,
    },
    {
      id: 'pv-stg-s3', key: 's3', name: '开发', kind: 'initial',
      starts_at: iso(anchorMs, -5 * DAY), ends_at: iso(anchorMs, -3 * DAY),
      scoring_config_key: 'initial', roster: true,
    },
    {
      id: 'pv-stg-s4', key: 's4', name: '路演', kind: 'final',
      starts_at: iso(anchorMs, -2 * DAY), ends_at: iso(anchorMs, -1 * DAY),
      scoring_config_key: 'final', roster: false,
    },
    {
      id: 'pv-stg-s5', key: 's5', name: '落地', kind: 'final',
      starts_at: iso(anchorMs, 1 * DAY), ends_at: iso(anchorMs, 10 * DAY),
      scoring_config_key: 'final', roster: true,
    },
  ];
  const stages = stageSpecs.map((s) => ({
    id: s.id,
    edition_id: 'pv-ed-1',
    key: s.key,
    name: s.name,
    kind: s.kind,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    freeze_at: null,
    scoring_config_key: s.scoring_config_key,
    status: 'open',
  }));

  // ── stage_judges / stage_team ───────────────────────────────────
  const stageJudges = [];
  const stageTeam = [];
  for (const s of stageSpecs) {
    if (!s.roster) continue; // s4：没登记名册 ⇒ 也没派评委（这段还没开打）
    for (const seat of [...VOTING_SEATS, OBSERVER]) {
      stageJudges.push({
        stage_id: s.id,
        user_id: seat.userId,
        seat: seat.seat,
        scope_type: 'edition',
        scope_id: 'pv-ed-1',
        assigned_at: iso(anchorMs, -15 * DAY),
        conflict_declared_at: iso(anchorMs, -15 * DAY),
        conflict_declaration_id: null,
      });
    }
    for (const teamId of TEAMS) {
      stageTeam.push({
        id: `pv-st-${s.key}-${teamId}`,
        stage_id: s.id,
        team_id: teamId,
        registered_at: iso(anchorMs, -15 * DAY),
      });
    }
  }

  // ── stage_reviews ───────────────────────────────────────────────
  const stageReviews = [];
  let revSeq = 0;
  for (const s of stageSpecs) {
    if (!s.roster) continue;
    const dims = s.scoring_config_key === 'initial' ? JUDGE_DIMS_INITIAL : JUDGE_DIMS_FINAL;
    // s5 尚未结束 ⇒ 只给部分评分（评审时能看到「未结束段落的部分数据」长什么样）
    const partial = s.key === 's5';
    for (const seat of VOTING_SEATS) {
      for (const teamId of TEAMS) {
        for (const dim of dims) {
          const cellKey = `${seat.userId}|${teamId}|${dim}`;
          if (s.key === 's2' && S2_MISSING.has(cellKey)) continue; // 故意漏评
          if (partial && (dim === 'collaboration' || (seat.userId === 'pv-ent-1' && dim === 'feasibility'))) continue;
          revSeq += 1;
          stageReviews.push({
            id: `pv-rev-${String(revSeq).padStart(4, '0')}`,
            stage_id: s.id,
            judge_id: seat.userId,
            team_id: teamId,
            dimension: dim,
            raw_score: 60 + ((revSeq * 7) % 35),
            submitted_at: iso(anchorMs, -12 * DAY),
            request_id: null,
            calibrated: 0,
            deleted_at: null,
          });
        }
      }
    }
  }

  // ── leaderboard_snapshots（发榜时刻）────────────────────────────
  // 一次发榜写 3 个 scope（services/leaderboard.js 的 SCOPES = rank/business/personal），
  // 它们 created_at 相同 ⇒ 取最早的一条即发榜时刻。
  const leaderboardSnapshots = [];
  const snap = (stageId, atIso, seq) => {
    for (const scope of ['rank', 'business', 'personal']) {
      leaderboardSnapshots.push({
        id: `pv-snap-${stageId}-${scope}`,
        edition_id: 'pv-ed-1',
        stage_id: stageId,
        scope,
        payload_json: JSON.stringify({ preview: true, scope }),
        created_at: atIso,
      });
      seq += 1;
    }
    return seq;
  };
  // s1：结束 +24h 发榜 ⇒ 按时（时限 72h）
  snap('pv-stg-s1', iso(anchorMs, -10 * DAY + 24 * HOUR), 0);
  // s2：结束 +90h 发榜 ⇒ 超期（时限 72h）
  snap('pv-stg-s2', iso(anchorMs, -6 * DAY + 90 * HOUR), 3);
  // s3：**不发** ⇒ never_published
  // s4 / s5：也不发

  return {
    editions,
    cities,
    users,
    task_packages: taskPackages,
    teams,
    stages,
    stage_judges: stageJudges,
    stage_team: stageTeam,
    stage_reviews: stageReviews,
    leaderboard_snapshots: leaderboardSnapshots,
    _meta: {
      anchor: nowIso,
      note: '预演数据集 —— 装在临时库里（生产同款迁移建的 schema）⇒ 真实数据可直接灌进同一套表',
      expectedCells: { s1: 80, s2: 80, s3: 80, s5: 64 },
    },
  };
}

export const PREVIEW_SCENARIO = {
  s1: '名册4队·席位4有投票权+1观察员·评分满格 ⇒ S-8 100% 达标；结束+24h发榜 ⇒ S-9 按时',
  s2: '同 s1 但故意漏 17 格 ⇒ S-8 78.75% 不达标；结束+90h发榜 ⇒ S-9 超期',
  s3: '评分满格但从未发榜 ⇒ S-8 达标；S-9 never_published',
  s4: '没登记名册（还没开打）⇒ S-8 not_applicable；S-9 no_roster',
  s5: '尚未结束 ⇒ S-9 not_due；S-8 只给了部分评分',
};
```

**Step 5: 创建 scripts/preview-seed.js**

`platform/scripts/preview-seed.js`：

```javascript
#!/usr/bin/env node
// scripts/preview-seed.js — 建**临时库**并灌入预演数据集（E181，2026-10-27）
//
// ⚠️ **这是什么**：一个**临时的库**，schema 由**生产同款迁移**建出来，
//    数据来自 `db/preview/preview-dataset.js`。
//    ⇒ 表结构与生产**逐字一致** ⇒ 真实赛事数据到位后**直接灌进同一套表**，
//      services/readiness.js 的代码**一行都不用改**。
//    ⇒ 评审时用它看「功能行为是否符合预期」，**不是**用它冒充真实数据。
//
// ⛔ **安全闸**：本脚本**只**写 `<platform>/data/preview/preview.db`，
//    **绝不**碰生产库（`platform/data/app.db`）——
//    ① 目录名写死成 `preview` 子目录；
//    ② 若目标目录里已经有 `app.db`（生产库同名）⇒ 拒绝执行；
//    ③ 每次执行前**重建**（先删旧的 preview.db）⇒ 预演数据永远是最新的那一份。
//
// 用法：
//   node scripts/preview-seed.js              # 用当前时间做锚点
//   node scripts/preview-seed.js --anchor 2026-10-20T00:00:00Z
//   node scripts/preview-seed.js --keep       # 不删旧库，直接灌（增量）
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { insertDataset } from '../src/db/repo/preview-data.js';
import { buildPreviewDataset, PREVIEW_SCENARIO } from '../db/preview/preview-dataset.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const previewDir = join(platformDir, 'data', 'preview');
const dbFile = join(previewDir, 'preview.db');

function parseArgs(argv) {
  const out = { anchor: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--anchor') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('[preview-seed] --anchor 后面必须是 ISO 时间');
        process.exit(2);
      }
      out.anchor = v;
      i += 1;
    } else if (argv[i] === '--keep') {
      out.keep = true;
    } else {
      console.error(`[preview-seed] 未知参数：${argv[i]}`);
      console.error('[preview-seed] 用法：node scripts/preview-seed.js [--anchor <ISO>] [--keep]');
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ⛔ 安全闸 ②：目标目录里若有名为 app.db 的东西 ⇒ 那是**生产库** ⇒ 拒绝。
mkdirSync(previewDir, { recursive: true });
if (existsSync(join(previewDir, 'app.db'))) {
  console.error(`[preview-seed] 拒绝执行：${join(previewDir, 'app.db')} 存在（生产库同名）`);
  process.exit(1);
}
// ⛔ 安全闸 ③：默认重建。
if (!args.keep && existsSync(dbFile)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) rmSync(dbFile + suffix);
  }
}

const anchor = args.anchor ? new Date(args.anchor) : new Date();
if (Number.isNaN(anchor.getTime())) {
  console.error(`[preview-seed] 锚点时间不可解析：${args.anchor}`);
  process.exit(2);
}

const { db, close } = openDatabase({ dataDir: previewDir, filename: 'preview.db' });
try {
  const migrated = applyMigrations(db, join(platformDir, 'db', 'migrations'));
  const data = buildPreviewDataset(anchor);

  // ⚠️ 插入顺序按**外键依赖**：父表先插。
  //    ⛔ 真正的 INSERT 语句在**仓储层**（src/db/repo/preview-data.js）——
  //    仓内纪律「SQL 字符串只许住在 src/db/repo/ 下」（test/sql-boundary.test.js 的守卫）。
  const ORDER = [
    'editions', 'cities', 'users', 'task_packages', 'teams',
    'stages', 'stage_judges', 'stage_team', 'stage_reviews', 'leaderboard_snapshots',
  ];
  let counts = {};
  db.exec('BEGIN');
  try {
    counts = insertDataset(db, data, ORDER);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`[preview-seed] 临时库：${dbFile}`);
  console.log(`[preview-seed] 迁移版本：${migrated.version}（生产同款迁移 ⇒ 表结构与生产一致）`);
  console.log(`[preview-seed] 锚点时刻：${data._meta.anchor}`);
  console.log('[preview-seed] 灌入行数：');
  for (const t of ORDER) console.log(`    ${t.padEnd(24)} ${counts[t]}`);
  console.log('[preview-seed] 场景矩阵（评审时对照这个看）：');
  for (const [k, v] of Object.entries(PREVIEW_SCENARIO)) console.log(`    ${k}: ${v}`);
  console.log('');
  console.log('[preview-seed] 下一步：node scripts/preview-report.js');
} finally {
  close();
}
```

**Step 6: 创建 scripts/preview-report.js**

`platform/scripts/preview-report.js`：

```javascript
#!/usr/bin/env node
// scripts/preview-report.js — 打印预演库的**人话报告**（E181，2026-10-27）
//
// ⚠️ **这个脚本是给人看的**：它把 S-7~S-10 的四个就绪度闸跑一遍，
//    然后用**中文**把「哪些赛段达标、哪些没达标、为什么」讲清楚 ——
//    目的是让**评审**能判断「功能行为是否符合预期」，而不是看一堆数字。
//
// ⚠️ **它读的是临时库**（`data/preview/preview.db`，由 preview-seed.js 建）：
//    schema = 生产同款迁移；数据 = 预演数据集。
//    ⇒ 真实赛事数据到位后，把同样的表灌满，这个脚本**一个字都不用改**。
//
// 用法：
//   node scripts/preview-report.js
//   node scripts/preview-report.js --json       # 机器读（结构化）
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { getDefaultRules } from '../src/config.js';
import { readinessSummary } from '../src/services/readiness.js';
import { PREVIEW_SCENARIO } from '../db/preview/preview-dataset.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const dbFile = join(platformDir, 'data', 'preview', 'preview.db');

const asJson = process.argv.includes('--json');

if (!existsSync(dbFile)) {
  console.error(`[preview-report] 临时库不存在：${dbFile}`);
  console.error('[preview-report] 先跑：node scripts/preview-seed.js');
  process.exit(2);
}

const rules = getDefaultRules();
const { db, close } = openDatabase({ dataDir: join(platformDir, 'data', 'preview'), filename: 'preview.db' });
try {
  const now = new Date().toISOString();
  const summary = readinessSummary({ db, editionId: 'pv-ed-1', rules, now });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  const yesNo = (v) => (v === true ? '✅ 达标' : v === false ? '❌ 未达标' : '⚪ 不可判定');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  S-7 ~ S-10 业务就绪度 · 预演报告');
  console.log(`  临时库：${dbFile}`);
  console.log(`  锚点时刻：${now}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`【S-7 规模达标】${yesNo(summary.s7.met)}`);
  console.log(`   队伍数 ${summary.s7.teamCount} 支 / 门槛 ${summary.s7.thresholdTeams} 支`);
  console.log(`   注：${summary.s7.note}`);
  console.log('');

  console.log(`【S-8 评审无漏评】${yesNo(summary.s8.met)}`);
  console.log(`   赛段 ${summary.s8.stageCount} 个，其中可判定 ${summary.s8.measurableCount} 个`);
  for (const s of summary.s8.stages) {
    if (s.status === 'not_applicable') {
      console.log(`   · ${s.stageKey} ${s.stageName}：⚪ 不可判定 —— ${s.statusNote}`);
      continue;
    }
    const mark = s.complete ? '✅' : '❌';
    console.log(`   · ${s.stageKey} ${s.stageName}：${mark} 覆盖率 ${s.coveragePercent}%`
      + `（已交 ${s.submitted} / 应交 ${s.expected}，门槛 ${s.thresholdPercent}%）`
      + (s.missingCount ? `，漏评 ${s.missingCount} 格` : ''));
    if (s.overSubmitted) console.log('     ⚠️ ' + s.warnings.join(' / '));
  }
  console.log('');

  console.log(`【S-9 按时发榜】${yesNo(summary.s9.met)}`);
  console.log(`   时限 ${summary.s9.deadlineHours} 小时；超期 ${summary.s9.overdueCount} 个赛段`);
  for (const s of summary.s9.stages) {
    const mark = s.overdue ? '❌' : '✅';
    const delay = s.delayHours === null ? '—' : `${s.delayHours}h`;
    console.log(`   · ${s.stageKey} ${s.stageName}：${mark} 状态=${s.state} 延迟=${delay}`);
    console.log(`     ${s.note}`);
  }
  console.log('');

  console.log(`【S-10 闭环时效与产出】⚪ ${summary.s10.note}`);
  console.log('');

  console.log('── 场景矩阵对照（预演数据应当落在这五个分支上）──────────────');
  for (const [k, v] of Object.entries(PREVIEW_SCENARIO)) console.log(`   ${k}: ${v}`);
  console.log('');
  console.log('⚠️ 这些是**预演数据**，不是真实赛事数据 —— 用途是评审功能行为是否符合预期。');
  console.log('   真实数据到位后灌进同一套表（schema 不变）⇒ 闸的代码一行都不用改。');
} finally {
  close();
}
```

**Step 7: 创建 test/readiness.test.js**

`platform/test/readiness.test.js`：

```javascript
// platform/test/readiness.test.js —— S-8 评审覆盖率闸 + S-9 按时发榜闸（E181，2026-10-27）
//
// 规则溯源：
//   - 设计文档 §1.3.1「S-7~S-10：怎么量、今天有没有机器检查」
//     （spec 原文：S-8「⚠️ **部分** …但**没有**「漏评覆盖率」的汇总闸 ⇒ 待补」；
//      S-9「⚠️ **部分**：发榜时刻已入库，但**没有**「超 72 小时」的告警 ⇒ 待补」）
//   - 阈值来源：rules/compliance.json 的 `readiness` 段（**代码不硬编码数字**）
//   - 三态状态码 → 设计文档 §7.3；可见性在 API 层过滤 → 设计文档 §6.6
//
// ⚠️ **判别性要求**（本仓纪律：用例必须能抓住「把修复去掉」）：
//   每条用例都钉住**具体数字**（应交格子数 = 席位数 × 队数 × 维度数、覆盖率百分比、
//   超期小时数），而不是钉「不是 undefined」那种糊弄断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules, validateRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { createUser, getUserById, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { registerStageTeams } from '../src/db/repo/stage-teams.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { readinessSummary } from '../src/services/readiness.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

// 初赛评委席维度（rules/scoring-initial.json）—— ⛔ 不含 enterprise / self 维度
// （那两个维度走企业确认与自评，**不落在 stage_reviews**）。
const JUDGE_DIMS_INITIAL = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-ready-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app, rules };
}

/**
 * 建一个「1 届 · 2 队 · 2 个评委席 + 1 个观察员」的骨架。
 * ⚠️ 观察员**无投票权**（R-JDG-11）⇒ 不进应交格子。
 */
function seedStage(db, {
  key = 's1', kind = 'initial', scoringConfigKey = 'initial',
  endsAt = '2026-10-10', teamCount = 2, withRoster = true, withSeats = true,
} = {}) {
  const captain = createUser(db, { name: `队长${key}`, phone: `1390000${key.length}${key.charCodeAt(1)}`, password: 'pw' });
  const judgeA = createUser(db, { name: `评委A${key}`, phone: `1391000${key.length}${key.charCodeAt(1)}`, password: 'pw' });
  const judgeB = createUser(db, { name: `评委B${key}`, phone: `1392000${key.length}${key.charCodeAt(1)}`, password: 'pw' });
  const observer = createUser(db, { name: `观察员${key}`, phone: `1393000${key.length}${key.charCodeAt(1)}`, password: 'pw' });

  const edition = createEdition(db, {
    name: `届${key}`, city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key, name: `赛段${key}`, kind,
    startsAt: '2026-10-01', endsAt, scoringConfigKey, status: 'open', now: NOW,
  });
  const teams = [];
  for (let i = 0; i < teamCount; i += 1) {
    teams.push(insertTeam(db, {
      editionId: edition.id, name: `${key}队${i + 1}`, captainId: captain.id, status: 'active', now: NOW,
    }));
  }
  if (withRoster) registerStageTeams(db, { stageId: stage.id, teamIds: teams.map((t) => t.id), now: NOW });
  if (withSeats) {
    assignStageJudge(db, { stageId: stage.id, userId: judgeA.id, seat: 'judge', now: NOW });
    assignStageJudge(db, { stageId: stage.id, userId: judgeB.id, seat: 'judge', now: NOW });
    assignStageJudge(db, { stageId: stage.id, userId: observer.id, seat: 'observer', now: NOW });
  }
  return { edition, stage, teams, judgeA, judgeB, observer, captain };
}

/** 给某赛段铺满评分（返回已插行数）。 */
function fillReviews(db, stage, teams, judges, dims = JUDGE_DIMS_INITIAL, now = NOW) {
  let n = 0;
  for (const j of judges) {
    for (const t of teams) {
      for (const d of dims) {
        insertReview(db, { stageId: stage.id, judgeId: j.id, teamId: t.id, dimension: d, rawScore: 80, now });
        n += 1;
      }
    }
  }
  return n;
}


/** 走**公开 API**取某个赛段的覆盖率（⛔ 不直接调内部函数 —— 内部函数是模块私有的）。 */
function coverageOf(db, stageId, rules, now = NOW) {
  const sum = readinessSummary({ db, rules, now });
  return sum.s8.stages.find((s) => s.stageId === stageId);
}

/** 走**公开 API**取某个赛段的发榜时限行。 */
function deadlineOf(db, stageId, rules, now = NOW) {
  const sum = readinessSummary({ db, rules, now });
  return sum.s9.stages.find((s) => s.stageId === stageId);
}

// ── S-8 ──────────────────────────────────────────────────────────────

test('S-8：评分铺满 ⇒ 覆盖率 100%，且**观察员不进应交格子**', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', teamCount: 2 });
    // 2 个评委席 × 2 队 × 5 个评委席维度 = 20 格
    // ⚠️ 观察员**不算**（R-JDG-11：无投票权）⇒ 若误把它算进去，应交会变成 30
    fillReviews(s.db, f.stage, f.teams, [f.judgeA, f.judgeB]);

    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.status, 'measurable');
    assert.equal(cov.expected, 20, '应交格子必须是 席位数(2) × 队数(2) × 评委席维度数(5)');
    assert.equal(cov.submitted, 20);
    assert.equal(cov.coveragePercent, 100);
    assert.equal(cov.complete, true);
    assert.equal(cov.missingCount, 0);
  } finally {
    s.close();
  }
});

test('S-8：漏评 ⇒ 覆盖率按缺口算，低于门槛即**不达标**，且 missing 清单可用', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', teamCount: 2 });
    // 只铺 1 个评委 ⇒ 10 / 20 = 50% < 90%
    fillReviews(s.db, f.stage, f.teams, [f.judgeA]);

    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.expected, 20);
    assert.equal(cov.submitted, 10);
    assert.equal(cov.coveragePercent, 50);
    assert.equal(cov.complete, false, '50% < 门槛 90% ⇒ 必须判不达标');
    assert.equal(cov.missingCount, 10, '漏评 10 格');
    assert.ok(cov.missing.length > 0, '必须给出漏评清单（评审要知道谁没交）');
    assert.ok(cov.missing.every((m) => m.judgeId && m.teamId && m.dimension));
  } finally {
    s.close();
  }
});

test('S-8：**名册未登记** ⇒ not_applicable（这段还没开打，不是「全部漏评」）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's4', teamCount: 2, withRoster: false });
    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.status, 'not_applicable');
    assert.equal(cov.coveragePercent, null, '⛔ 不可判定时绝不能返回 100%（那会把「没开打」说成「都交了」）');
    assert.equal(cov.complete, false);
    assert.ok(cov.statusNote && cov.statusNote.includes('名册'), '必须写明为什么不可判定');
  } finally {
    s.close();
  }
});

test('S-8：**没有投票权席位** ⇒ 应交 0 格 ⇒ 不可判定（不得返回 100%）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's5', teamCount: 2, withSeats: false });
    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.status, 'not_applicable');
    assert.equal(cov.coveragePercent, null);
    assert.equal(cov.expected, 0);
  } finally {
    s.close();
  }
});

test('S-8：阈值来自 rules（改阈值 ⇒ 结论跟着变；代码里不硬编码）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', teamCount: 2 });
    fillReviews(s.db, f.stage, f.teams, [f.judgeA]); // 10 / 20 = 50%

    const cov = coverageOf(s.db, f.stage.id, s.rules);
    assert.equal(cov.complete, false, '门槛 90% ⇒ 50% 不达标');
    assert.equal(cov.thresholdPercent, 90);

    // 把门槛降到 40% ⇒ 同样的数据应当判达标（证明阈值是配置驱动的）
    const lax = structuredClone(s.rules);
    lax.compliance.readiness.minReviewCoveragePercent = 40;
    const cov2 = coverageOf(s.db, f.stage.id, lax);
    assert.equal(cov2.complete, true, '门槛改成 40% ⇒ 50% 必须判达标');
  } finally {
    s.close();
  }
});

// ── S-9 ──────────────────────────────────────────────────────────────

function seedSnapshot(db, editionId, stageId, createdAt) {
  for (const scope of ['rank', 'business', 'personal']) {
    db.prepare(
      'INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)',
    ).run(`snap-${stageId}-${scope}`, editionId, stageId, scope, '{}', createdAt);
  }
}

test('S-9：结束 +24h 发榜 ⇒ 按时（不超期）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', endsAt: '2026-10-10' });
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-11T00:00:00.000Z'); // 结束 +24h
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'published');
    assert.equal(row.overdue, false);
    assert.equal(row.delayHours, 24);
    assert.equal(out.overdueCount, 0);
  } finally {
    s.close();
  }
});

test('S-9：结束 +90h 发榜 ⇒ **超期**（时限 72h），且延迟小时数报得出来', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's2', endsAt: '2026-10-10' });
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-13T18:00:00.000Z'); // 结束 +90h
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'late');
    assert.equal(row.overdue, true);
    assert.equal(row.delayHours, 90);
    assert.equal(out.overdueCount, 1);
    assert.ok(out.overdueStageIds.includes(f.stage.id));
  } finally {
    s.close();
  }
});

test('S-9：结束 84h 仍**从未发榜** ⇒ 判 never_published 并计入超期', () => {
  // ⚠️ **用例名与断言对齐**：本用例的 now 是 10-13 12:00、赛段 10-10 结束 ⇒ 实际延迟 **84 小时**
  //    （原名写的「72h」与断言里的 84 不符 —— 已改正；断言值未动）。
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's3', endsAt: '2026-10-10' });
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-13T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'never_published');
    assert.equal(row.overdue, true, '84h > 72h ⇒ 必须判超期');
    assert.equal(row.publishedAt, null);
    assert.equal(row.delayHours, 84, '结束 10-10 00:00 → now 10-13 12:00 = 84 小时');
  } finally {
    s.close();
  }
});

test('S-9：**从未发榜**与**已发榜**同一把尺（E182 · F3）：时限内不报红，超时才报', () => {
  // ⚠️ **这是 F3 的判别性用例**：修复前 `never_published` 分支的 `overdue` 是**无条件 true**
  //    ⇒ 赛段结束 **1 小时**没发榜就报红，而已发榜的同一时刻要 >72h 才算 late
  //    ⇒ 同一条 SLA 两种不对称判定 ⇒ 试赛第一天就会误报一片红。
  // ⇒ 这里必须**同时**钉住两个方向：时限内**不**报 + 超时**才**报。
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's6', endsAt: '2026-10-10' });
    // ① 结束 +1h（远在 72h 时限内）⇒ **不得**判超期
    const early = deadlineOf(s.db, f.stage.id, s.rules, '2026-10-10T01:00:00.000Z');
    assert.equal(early.state, 'never_published', '状态仍是 never_published（「一次都没发过」与「晚发」是两件事）');
    assert.equal(early.delayHours, 1);
    assert.equal(early.overdue, false, '⛔ 时限内没发榜**不得**判超期 —— 修复前这里恒为 true（试赛第一天就误报红）');
    assert.equal(early.publishedAt, null);

    // ② 结束 +72h（**正好**等于时限）⇒ 仍不报（与「已发榜」分支同尺：严格大于才算超期）
    const exact = deadlineOf(s.db, f.stage.id, s.rules, '2026-10-13T00:00:00.000Z');
    assert.equal(exact.delayHours, 72);
    assert.equal(exact.overdue, false, '正好 72h 不算超期（与已发榜分支同一把尺：严格大于）');

    // ③ 结束 +73h ⇒ 报超期
    const late = deadlineOf(s.db, f.stage.id, s.rules, '2026-10-13T01:00:00.000Z');
    assert.equal(late.delayHours, 73);
    assert.equal(late.overdue, true, '超过 72h 必须报超期');
    assert.equal(
      readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-13T01:00:00.000Z' }).s9.overdueCount, 1,
      '超期计数必须同步（汇总层不得漏）',
    );
  } finally {
    s.close();
  }
});

test('S-9：赛段**尚未结束** ⇒ not_due，不算超期', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's5', endsAt: '2026-12-01' });
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'not_due');
    assert.equal(row.overdue, false);
  } finally {
    s.close();
  }
});

test('S-9：**名册未登记**（这段没开打）⇒ 不计入超期', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's4', endsAt: '2026-10-10', withRoster: false });
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    const row = out.stages.find((x) => x.stageId === f.stage.id);
    assert.equal(row.state, 'no_roster');
    assert.equal(row.overdue, false, '没开打的赛段不该被判「超期没发榜」');
    assert.equal(out.overdueCount, 0);
  } finally {
    s.close();
  }
});

test('S-9：同一赛段**发榜两次** ⇒ 判**首次**发榜时刻（重发不掩盖首发的按时性）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's1', endsAt: '2026-10-10' });
    // 首发 +24h（按时）；重发 +100h（超期）
    // ⚠️ 若闸取「最后一条快照」⇒ 会得出 100h ⇒ 误判超期 ⇒ 这条用例必须能抓住它。
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-11T00:00:00.000Z');
    for (const scope of ['rank', 'business', 'personal']) {
      s.db.prepare(
        'INSERT INTO leaderboard_snapshots (id, edition_id, stage_id, scope, payload_json, created_at) VALUES (?,?,?,?,?,?)',
      ).run(`snap2-${f.stage.id}-${scope}`, f.edition.id, f.stage.id, scope, '{}', '2026-10-14T04:00:00.000Z');
    }
    const row = deadlineOf(s.db, f.stage.id, s.rules, '2026-10-20T12:00:00.000Z');
    assert.equal(row.publishedAt, '2026-10-11T00:00:00.000Z', '必须取**首次**发榜时刻');
    assert.equal(row.delayHours, 24);
    assert.equal(row.overdue, false, '首发按时 ⇒ 不得被后来的重发拖成超期');
  } finally {
    s.close();
  }
});

test('S-9：时限来自 rules（改时限 ⇒ 超期判定跟着变）', () => {
  const s = setup();
  try {
    const f = seedStage(s.db, { key: 's2', endsAt: '2026-10-10' });
    seedSnapshot(s.db, f.edition.id, f.stage.id, '2026-10-12T00:00:00.000Z'); // 结束 +48h
    const out = readinessSummary({ db: s.db, rules: s.rules, now: '2026-10-20T12:00:00.000Z' }).s9;
    assert.equal(out.stages.find((x) => x.stageId === f.stage.id).overdue, false, '48h < 72h ⇒ 不超期');

    const lax = structuredClone(s.rules);
    lax.compliance.readiness.publishDeadlineHours = 24;
    const out2 = readinessSummary({ db: s.db, rules: lax, now: '2026-10-20T12:00:00.000Z' }).s9;
    assert.equal(out2.stages.find((x) => x.stageId === f.stage.id).overdue, true, '时限改成 24h ⇒ 48h 必须超期');
  } finally {
    s.close();
  }
});

// ── 配置层机器闸 ──────────────────────────────────────────────────────

test('配置闸：readiness 三个阈值非法 ⇒ validateRules 报错（拒绝启动）', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.compliance.readiness.minReviewCoveragePercent = 0;
  bad.compliance.readiness.publishDeadlineHours = -1;
  bad.compliance.readiness.minTeamsForScale = 0;
  const errs = validateRules(bad);
  assert.ok(errs.some((e) => e.includes('minReviewCoveragePercent')), '覆盖率下限 0 必须报错');
  assert.ok(errs.some((e) => e.includes('publishDeadlineHours')), '时限负数必须报错');
  assert.ok(errs.some((e) => e.includes('minTeamsForScale')), '规模门槛 0 必须报错');
});

test('配置闸：覆盖率下限 > 100 也必须报错（否则闸永远红）', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.compliance.readiness.minReviewCoveragePercent = 101;
  assert.ok(validateRules(bad).some((e) => e.includes('minReviewCoveragePercent')));
});

// ── HTTP 端点 ────────────────────────────────────────────────────────

function seedCommittee(db) {
  const admin = createUser(db, { name: '组委会', phone: '13700000001', password: 'pw' });
  setSuperadmin(db, admin.id);
  const adminUser = getUserById(db, admin.id);
  const plain = createUser(db, { name: '普通用户', phone: '13700000002', password: 'pw' });
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'admin', 'audit:read');
  insertUserRole(db, plain.id, 'admin');
  return { admin: adminUser, plain };
}

test('HTTP：GET /api/readiness 未登录 ⇒ 401', async () => {
  const s = setup();
  try {
    const res = await callJson(s.app, 'GET', '/api/readiness');
    assert.equal(res.status, 401);
  } finally {
    s.close();
  }
});

test('HTTP：GET /api/readiness 登录但无 audit:read ⇒ 403（**不是** 200+空集）', async () => {
  const s = setup();
  try {
    const outsider = createUser(s.db, { name: '路人', phone: '13700000003', password: 'pw' });
    const token = createSession(s.db, outsider.id).token;
    const res = await callJson(s.app, 'GET', '/api/readiness', { token });
    // ⛔ 空集会被读成「各项都达标」⇒ 必须 403
    assert.equal(res.status, 403);
  } finally {
    s.close();
  }
});

test('HTTP：GET /api/readiness 组委会 ⇒ 200 且给出 S-7~S-10 四段结构', async () => {
  const s = setup();
  try {
    const { admin } = seedCommittee(s.db);
    const token = createSession(s.db, admin.id).token;
    const res = await callJson(s.app, 'GET', '/api/readiness', { token });
    assert.equal(res.status, 200);
    const body = res.json;
    for (const k of ['s7', 's8', 's9', 's10']) {
      assert.ok(body[k], `返回体必须含 ${k} 段`);
    }
    assert.equal(typeof body.s7.teamCount, 'number');
    assert.equal(typeof body.s9.overdueCount, 'number');
    assert.equal(body.s10.met, null, 'S-10 需要真实赛事数据 ⇒ 不得假装判达标');
  } finally {
    s.close();
  }
});

test('HTTP：GET /api/readiness?editionId=不存在 ⇒ 404（不静默退回「当届」）', async () => {
  const s = setup();
  try {
    const { admin } = seedCommittee(s.db);
    const token = createSession(s.db, admin.id).token;
    const res = await callJson(s.app, 'GET', '/api/readiness?editionId=ed-not-exist', { token });
    assert.equal(res.status, 404);
  } finally {
    s.close();
  }
});

// ── 汇总 ─────────────────────────────────────────────────────────────

test('汇总：S-8 有任何一个赛段不达标 ⇒ 整体不达标；S-9 超期数 > 0 ⇒ 不达标', () => {
  const s = setup();
  try {
    const f1 = seedStage(s.db, { key: 's1', teamCount: 2 });
    fillReviews(s.db, f1.stage, f1.teams, [f1.judgeA, f1.judgeB]); // 满覆盖
    const f2 = seedStage(s.db, { key: 's2', teamCount: 2 });
    fillReviews(s.db, f2.stage, f2.teams, [f2.judgeA]); // 半覆盖 ⇒ 50%

    const sum = readinessSummary({ db: s.db, rules: s.rules, now: NOW });
    assert.equal(sum.s8.met, false, '有一个赛段不达标 ⇒ 整体不达标');
    assert.equal(sum.s8.worstCoveragePercent, 50, '最差赛段就是那个 50% 的');
    assert.equal(sum.s8.worstStageId, f2.stage.id);
    assert.equal(sum.s7.teamCount, 4, '两届各 2 队 ⇒ 共 4 支（seedStage 每建一个赛段建一届）');
  } finally {
    s.close();
  }
});
```

**Step 8: 创建 test/audit-filter.test.js**

`platform/test/audit-filter.test.js`：

```javascript
// platform/test/audit-filter.test.js —— 审计/复核/申诉三端点的过滤键闸（E181 · A3，2026-10-27）
//
// 规则溯源：
//   - 设计文档 §7.3 三态状态码（未登录 401 / 无权限 403 / 不满足 200+空集 / 单条 404）
//   - 设计文档 §6.6「可见性在 API 层过滤」
//   - 缺陷（E181 实测）：`pickFilter` 用**一份并集白名单**给三个端点用
//     ⇒ `/api/audit/log?status=open` 被**接受**但仓储层不认识 status ⇒ **过滤被静默丢弃**
//     ⇒ 调用方拿到**未筛选的全量**却以为自己筛过了。
//
// ⚠️ **判别性要求**：
//   ① 「未知键 ⇒ 400」用例必须真的红在「400」这个数字上（不是「非 200」）；
//   ② 「已知键 ⇒ 真的过滤」用例必须断言**返回行数变少**，否则把过滤实现抽掉也测不出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { createUser, getUserById, setSuperadmin } from '../src/db/repo/users.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { insertAuditLogRow } from '../src/db/repo/audit-log.js';
import { createFlag } from '../src/db/repo/flags.js';
import { insertAppeal } from '../src/db/repo/appeals.js';
import { callJson } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-auditfilter-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  const admin = createUser(db, { name: '组委会', phone: '13800000001', password: 'pw' });
  setSuperadmin(db, admin.id);
  const adminUser = getUserById(db, admin.id);
  insertCapability(db, 'audit:read', '读取审计与计算快照');
  insertCapability(db, 'audit:write', '裁决复核项与申诉');
  insertRole(db, 'admin', '组委会');
  insertRoleCapability(db, 'admin', 'audit:read');
  insertRoleCapability(db, 'admin', 'audit:write');
  insertUserRole(db, adminUser.id, 'admin');
  const token = createSession(db, adminUser.id).token;
  return { db, close, dataDir, app, rules, admin: adminUser, token };
}

/** 造两条不同 action 的审计行。 */
function seedAuditRows(db, actorId) {
  insertAuditLogRow(db, {
    actorId, action: 'leaderboard.publish', entity: 'stage', entityId: 'st1',
    detailJson: '{}', createdAt: '2026-10-20T10:00:00.000Z',
  });
  insertAuditLogRow(db, {
    actorId, action: 'flag.resolve', entity: 'flag', entityId: 'f1',
    detailJson: '{}', createdAt: '2026-10-20T11:00:00.000Z',
  });
}

test('/api/audit/log：未知过滤键 ⇒ 400（不再**静默丢弃**过滤条件）', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    // ⛔ `status` 是**复核队列**的过滤键，审计日志端点**不支持** ⇒ 之前被静默忽略
    const res = await callJson(s.app, 'GET', '/api/audit/log?status=open', { token: s.token });
    assert.equal(res.status, 400, '未知过滤键必须 400，而不是返回未筛选的全量');
    assert.ok(res.json?.error?.message?.includes('status'), '错误文案要点名是哪个参数');
  } finally {
    s.close();
  }
});

test('/api/audit/log：拼错的参数名 ⇒ 400', async () => {
  const s = setup();
  try {
    const res = await callJson(s.app, 'GET', '/api/audit/log?acton=leaderboard.publish', { token: s.token });
    assert.equal(res.status, 400);
  } finally {
    s.close();
  }
});

test('/api/audit/log：支持的过滤键 ⇒ 200 且**真的过滤**（行数变少）', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    const all = await callJson(s.app, 'GET', '/api/audit/log', { token: s.token });
    assert.equal(all.status, 200);
    assert.equal(all.json.rows.length, 2, '先确认有两条');

    const filtered = await callJson(s.app, 'GET', '/api/audit/log?action=flag.resolve', { token: s.token });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.rows.length, 1, '按 action 过滤后必须只剩一条');
    assert.equal(filtered.json.rows[0].action, 'flag.resolve');
  } finally {
    s.close();
  }
});

test('/api/audit/log：`entity` 过滤键同样生效', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    const res = await callJson(s.app, 'GET', '/api/audit/log?entity=stage', { token: s.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.rows.length, 1);
    assert.equal(res.json.rows[0].entity, 'stage');
  } finally {
    s.close();
  }
});

test('/api/audit/log：非法分页参数（limit=abc）**仍然 200**（既有契约不破）', async () => {
  const s = setup();
  try {
    seedAuditRows(s.db, s.admin.id);
    // ⚠️ 这条是既有契约（test/audit-api.test.js 钉住「不得打成 500」）：
    //    非法 limit/offset 是**静默忽略**，不是 400 —— 本次修复只治「过滤键静默失效」。
    const res = await callJson(s.app, 'GET', '/api/audit/log?limit=abc&offset=xyz', { token: s.token });
    assert.equal(res.status, 200);
  } finally {
    s.close();
  }
});

test('/api/audit/flags：未知过滤键 ⇒ 400（entity 不属于复核队列）', async () => {
  const s = setup();
  try {
    createFlag(s.db, { stageId: 'st1', kind: 'low_variance', detail: { judgeId: 'j1' } });
    const res = await callJson(s.app, 'GET', '/api/audit/flags?entity=stage', { token: s.token });
    assert.equal(res.status, 400);
  } finally {
    s.close();
  }
});

test('/api/audit/flags：`kind` / `status` 过滤键 ⇒ 200 且**真的过滤**', async () => {
  const s = setup();
  try {
    createFlag(s.db, { stageId: 'st1', kind: 'low_variance', detail: { judgeId: 'j1' } });
    createFlag(s.db, { stageId: 'st1', kind: 'burst_submit', detail: { subjectId: 'j2' } });

    const all = await callJson(s.app, 'GET', '/api/audit/flags', { token: s.token });
    assert.equal(all.status, 200);
    assert.equal(all.json.rows.length, 2, '先确认有两条');

    const byKind = await callJson(s.app, 'GET', '/api/audit/flags?kind=low_variance', { token: s.token });
    assert.equal(byKind.status, 200);
    assert.equal(byKind.json.rows.length, 1, '按 kind 过滤后必须只剩一条');
    assert.equal(byKind.json.rows[0].kind, 'low_variance');

    const byStatus = await callJson(s.app, 'GET', '/api/audit/flags?status=open', { token: s.token });
    assert.equal(byStatus.status, 200);
    assert.ok(Array.isArray(byStatus.json.rows));
  } finally {
    s.close();
  }
});

test('/api/appeals：未知过滤键 ⇒ 400（action 不属于申诉列表）', async () => {
  const s = setup();
  try {
    insertAppeal(s.db, { subjectType: 'team_result', subjectId: 'st1:t1', filedBy: s.admin.id, reason: '算错了', now: NOW });
    const res = await callJson(s.app, 'GET', '/api/appeals?action=leaderboard.publish', { token: s.token });
    assert.equal(res.status, 400);
  } finally {
    s.close();
  }
});

test('/api/appeals：`subjectType` 过滤键 ⇒ 200 且**真的过滤**', async () => {
  const s = setup();
  try {
    insertAppeal(s.db, { subjectType: 'team_result', subjectId: 'st1:t1', filedBy: s.admin.id, reason: '算错了', now: NOW });
    insertAppeal(s.db, { subjectType: 'registration', subjectId: 'r1', filedBy: s.admin.id, reason: '报名有问题', now: NOW });

    const all = await callJson(s.app, 'GET', '/api/appeals', { token: s.token });
    assert.equal(all.status, 200);
    assert.equal(all.json.rows.length, 2, '先确认有两条');

    const filtered = await callJson(s.app, 'GET', '/api/appeals?subjectType=registration', { token: s.token });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.rows.length, 1, '按 subjectType 过滤后必须只剩一条');
    assert.equal(filtered.json.rows[0].subjectType, 'registration');
  } finally {
    s.close();
  }
});

test('三端点的白名单**互不相同**（同一个键在另一个端点必须 400）', async () => {
  const s = setup();
  try {
    // action 只属于 audit/log；kind 只属于 flags；subjectType 只属于 appeals
    assert.equal((await callJson(s.app, 'GET', '/api/audit/log?kind=x', { token: s.token })).status, 400);
    assert.equal((await callJson(s.app, 'GET', '/api/audit/flags?action=x', { token: s.token })).status, 400);
    assert.equal((await callJson(s.app, 'GET', '/api/appeals?kind=x', { token: s.token })).status, 400);
  } finally {
    s.close();
  }
});
```

### 4.10 2026-10-28 E182 轮（E180/E181 复评发现的七条修复）—— 新建文件登记

本轮修的是 2026-10-27 第三方复评报告里**经我方逐条亲验属实**的发现。本轮新建了以下文件。
按本仓纪律「**新建文件必须登记进计划块，否则它的漂移查不出来**」，逐个登记如下：

| 文件 | 为什么必须是**新文件** |
|---|---|
| `platform/db/migrations/011_behavior_event_subject_unique.sql` | 「同一里程碑只记一次」的**数据库层**约束必须是**独立的一条迁移**：behavior_events 是**只增不改**的审计型表（INTERFACES.md §0「追加式」）⇒ 只能加列、不能改既有行、不能删列 ⇒ 既有的 009 迁移（加列）**不能**被就地改写（迁移文件名不可变更，`src/db/migrate.js` 会对改名抛错）⇒ 约束补强只能**另起一条**。⚠️ 用**部分唯一索引**（`WHERE subject_id IS NOT NULL`）：`subject_id` 只对 countBy='milestone' 的事件有值 ⇒ 其余 once 类事件共用「终身一次」桶，不受这条索引约束（否则一次类事件会互相顶掉）。 |
| `platform/test/e182-regression.test.js` | 本轮的七条修复**跨了七个不同的口径**（控制字节 / 申诉白名单 / 发榜时限 / 里程碑确认方 / 截尾门槛 / 数据库约束 / 接口契约登记）⇒ 塞进任何**单个**既有测试文件，都会让「这条钉的是哪条口径」看不出来。⚠️ 它还含一条**跨全仓**的扫描用例（F1：文本源文件不得有裸 NUL / 控制字节）⇒ 只能独立成文件才能扫到 `docs/` 下的计划块（F1 的两处 NUL 里**有一处就在计划块里**）。 |

⚠️ 本轮**同时**改了既有文件（`src/services/review-state.js` → P4 owns、`src/services/readiness.js` → P13 owns、
`src/config.js` → P0 owns、`src/domain/behavior.js` → P3 owns、`web/api.demo.js` → P6 owns、
16 份 `rules/*.json` → 各自 owning 阶段）⇒ 它们的计划块**已用 `docs/tools/plan-block-sync.mjs` 逐字同步回 owning 阶段**
（C-RW 必须清零 ⇒ 本轮同步了 **15 + 5** 处）。
⚠️ 规则集又升了一版：`2026-10-27` → **`2026-10-28`**（16 份全改 —— 本轮改了
`rules/milestones.default.json`（demo_ready 的确认方）与两份 `rules/scoring-*.json`（minJudgesForTrim），
且 `rules/compliance.json` 的 readiness 段未动 ⇒ 版本必须全等，否则 `loadRules` 拒绝启动）。

**Step 1: 创建 db/migrations/011_behavior_event_subject_unique.sql**

`platform/db/migrations/011_behavior_event_subject_unique.sql`：

```sql
-- 011_behavior_event_subject_unique.sql —— 「同一里程碑只记一次」落到**数据库层**（2026-10-28）
--
-- 依据：E182 · F6（2026-10-27 复评发现的 Minor）
--   · **服务层已经是对的**：`domain/behavior.js` 的 `countLimitOf` 对 `countBy:'milestone'`
--     返回 `{ max: 1 }` ⇒ 同一个里程碑只计一次；`services/behavior.js` 在 insert **之前**
--     先跑一次 probe ⇒ 同一里程碑的第二次提交撞 `subject_limit` ⇒ 409 ⇒ 根本不落库。
--   · 但 009 建的 `idx_behavior_events_subject` 是**普通索引**，不是 UNIQUE
--     ⇒ 数据库层**没有任何约束** ⇒ 约束只存在于服务层的「先查再插」里。
--   · 同款病根在本仓有先例，两处都写着同一句话：
--       007_p13_defect_fixes.sql（F23）：「服务层的『先查再插』在并发下挡不住
--         两个同时通过的请求（两边都读到『不存在』）⇒ 唯一约束必须落在数据库上。」
--       `review_request_keys` 用**复合 PRIMARY KEY** 做幂等的数据库层保证。
--     ⇒ 本条是把同一纪律补到行为分事件上。
--
-- ⚠️ 为什么是**部分唯一索引**（`WHERE subject_id IS NOT NULL`）：
--    `subject_id` 只对 `countBy:'milestone'` 的事件有值 ——
--      · 迁移 009 之前的事件一律 NULL（`ALTER TABLE ... ADD COLUMN` 的可空列）；
--      · `services/behavior.js` 也**只**对 `countBy:'milestone'` 写主体。
--    ⇒ 而 4 个 `once` 类事件（weekly_progress / workshop_output / enterprise_meeting /
--      first_demo）**共用同一个「终身一次」桶**（桶键 = 事件类型 + 空主体）。
--    ⇒ 显式写上 `WHERE subject_id IS NOT NULL` 有两个好处：
--      ① 语义自解释：这条索引**只管「有主体」的行**；
--      ② 不用依赖「SQLite 的 UNIQUE 视 NULL 与 NULL 互不相等」这一条实现细节
--         —— 换到 Postgres（UNIQUE 默认视 NULL 为相等，除非显式 NULLS NOT DISTINCT）
--            那样**不加 WHERE 就会真的撞键**，把 4 个 once 事件互相顶掉。
--         ⇒ 把「NULL 主体不受约束」写进索引定义本身，而不是靠引擎的默认值。
--
-- ⚠️ **本迁移不删行、不改行**（behavior_events 是**只增不改**的审计型表，
--    INTERFACES.md §0「追加式」⇒ 只能加列，不能改既有行、不能删列）：
--    若库里已存在重复的 (team_id, type, subject_id)，下面的建索引会**响亮失败**
--    （UNIQUE constraint failed）⇒ 整个迁移回滚（`src/db/migrate.js` 的单事务）
--    ⇒ 部署被挡住 ⇒ **人来看**。
--    ⇒ 这是刻意的取舍：**宁可部署停下来，也不静默改写审计数据**。
--    ⇒ 「正常路径不可能产生重复」是可证的，三条：
--      ① 服务层在 insert 前就 409 挡掉第二次提交（`subject_limit` 分支）；
--      ② `submitBehaviorEvent` 是**同步函数**（全程没有 await）⇒ 单进程内不会交错；
--      ③ 单写者闸（设计文档 §14.2 / README「SQLite 只允许单写进程」）⇒ 只有一个写进程。
CREATE UNIQUE INDEX ux_behavior_events_subject
  ON behavior_events(team_id, type, subject_id)
 WHERE subject_id IS NOT NULL;
```

**Step 2: 创建 test/e182-regression.test.js**

`platform/test/e182-regression.test.js`：

```javascript
// platform/test/e182-regression.test.js —— E182 复评发现的七条修复的回归闸（2026-10-28）
//
// 依据：2026-10-27 的 E180/E181 第三方复评报告 + 我方**逐条亲验**后确认属实的发现：
//   F1（Critical·工程）源码里嵌入了**裸 NUL 字节** ⇒ git 把核心计分文件判成二进制
//        ⇒ diff / blame / git grep / 基于 diff 的机器闸**全部失效**
//   F2（Important）申诉理由类型白名单的**豁免写宽**（豁免「一切非 team_result」）
//        ⇒ 未知 subjectType 能绕过程序性白名单落库
//   F3（Important）S-9 的 `never_published` **无条件**判超期 ⇒ 与 `published` 分支不对称
//   F4（Important·业务）`demo_ready` 的确认方写 `judge`，而达成闸只认企业签字
//        ⇒ 配置与实现、与 R-PTS-12 **三重矛盾**
//   F5（Minor）`minJudgesForTrim: 5` 与评委池下限 3 **互相打架**
//        ⇒ `trimmed` 策略在 3 人池下**永不触发** ⇒ C-07 的理由没兑现
//   F6（Minor）`behavior_events` 的主体索引**非 UNIQUE** ⇒ 缺数据库层兜底
//   F7（Minor）`readiness` 端点没登记进跨阶段接口契约；demo parity 没有排除项清单
//
// ⚠️ **判别性要求**（本仓纪律：用例必须能抓住「把修复去掉」）：
//   每条用例都钉住**具体行为与具体数字**，不是「不是 undefined」那种糊弄断言。
//   —— 尤其 F3：修复前 `never_published` 一律 overdue=true ⇒ 用例必须同时钉住
//      「时限内不报」与「超时才报」两个方向，只钉一个方向等于没钉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules, validateRules } from '../src/config.js';
import { fileAppeal } from '../src/services/review-state.js';
import { transition } from '../src/services/review-state-core.js';
import { trimOutliers } from '../src/domain/trim.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

// ── F1：裸 NUL / 控制字节 ───────────────────────────────────────────────
//
// ⚠️ **为什么这条闸值得存在**：git 的二进制启发式是「**前 8000 字节**里出现 NUL ⇒ 判二进制」
// ⇒ 一个裸 NUL 字节会让**整份文件**在 git 眼里变成二进制 ⇒ diff 变成 "Binary files differ"
// ⇒ 而本仓的核心纪律恰恰是「计划块与实现**逐字**一致」⇒ diff 失效 = 纪律失效。
// ⚠️ 计划块（docs/superpowers/plans/*.md）也必须扫：F1 的两处 NUL 里**有一处就在计划块里**
//    ⇒ 只扫实现文件会漏掉「计划块与实现一起带 NUL」的那种。
const F1_SCAN_DIRS = [
  'platform/src', 'platform/web', 'platform/test', 'platform/scripts',
  'platform/rules', 'platform/db', 'docs',
];
const F1_TEXT_EXT = new Set([
  '.js', '.mjs', '.json', '.md', '.sql', '.html', '.css', '.sh', '.txt', '.yml', '.yaml', '.conf', '.service',
]);
const F1_SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', 'data', 'backups']);

test('F1：仓库的**文本源文件里不得有裸 NUL / 控制字节**（否则 git 把它们判成二进制 ⇒ diff 失效）', () => {
  const offenders = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!F1_SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!F1_TEXT_EXT.has(extname(entry.name))) continue;
      const buf = readFileSync(full);
      scanned += 1;
      const hits = [];
      for (let i = 0; i < buf.length; i += 1) {
        const b = buf[i];
        // ⛔ 只放行 \t(0x09) / \n(0x0a) / \r(0x0d) —— 其余控制字节（含 NUL）一律算异常。
        if (b === 0 || b < 0x09 || (b > 0x0a && b < 0x20 && b !== 0x0d)) hits.push([i, b]);
      }
      if (hits.length) {
        offenders.push(`${relative(repoRoot, full)}：${hits.length} 处（首个在偏移 ${hits[0][0]}，字节 0x${hits[0][1].toString(16)}）`);
      }
    }
  };
  for (const d of F1_SCAN_DIRS) walk(join(repoRoot, d));
  assert.ok(scanned > 100, `扫描的文件数异常地少（${scanned}）⇒ 扫描范围本身坏了`);
  assert.deepEqual(
    offenders, [],
    `以下文件含裸 NUL / 控制字节 ⇒ git 会把它们判成二进制，diff/blame/git grep 全部失效：\n${offenders.join('\n')}`,
  );
});

// ── F2：申诉主体类型白名单 ───────────────────────────────────────────────
//
// ⚠️ **修复前的漏洞**：`appealReasonKindGate` 的豁免条件写的是
//    `subjectType !== 'team_result' && !kind` ⇒ 豁免的是「**一切非 team_result**」
//    ⇒ 传 `subjectType: 'foo'` + 不传 reasonKind 就能跳过程序性理由类型白名单落库成功。
//    而 `subjectType` **全链路没有白名单**（表无 CHECK / 路由不校验 / 服务层只分两支）
//    ⇒ 'foo' 还会落进「赛段结果类」的裁决分支 ⇒ 既绕过了白名单、又没有正确的裁决口径。
const F2_RULES = {
  audit: {
    reviewState: {
      appealSubjectType: 'team_result',
      appealAllowedTiers: ['A', 'B', 'C', 'D'],
      appealReasonKinds: ['scoring_error', 'procedure_violation', 'data_error'],
    },
  },
};

function f2Setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-e182-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000999','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z'),
           ('u_captain','甲队队长','13900000888','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z');
    INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
    VALUES ('t1','ed_1','甲队','u_captain',NULL,'active','2026-10-20T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_t1','t1','D',0,0,'[]','2026-10-20T00:00:00.000Z',NULL);
  `);
  return { db, close, dataDir };
}

/** 把 st1 推到 FINALIZED（赛段结果类申诉的前提） */
function f2Finalize(db) {
  for (const [from, to, key] of [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ]) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
}

test('F2：未知的申诉主体类型 ⇒ **400**（不得借它绕过程序性理由类型白名单）', () => {
  const { db, close, dataDir } = f2Setup();
  try {
    f2Finalize(db);
    // ① 未知类型 + **不传** reasonKind ⇒ 必须 400
    //    ⚠️ 修复前这里是「豁免」⇒ 直接落库成功 ⇒ 这条断言就是那个洞的照妖镜。
    assert.throws(
      () => fileAppeal({
        db, subjectType: 'foo', subjectId: 'st1:t1', filedBy: 'u_captain',
        reason: '我不服这个名次', now: '2026-10-20T01:00:00.000Z', rules: F2_RULES,
      }),
      (e) => e.status === 400 && /主体类型非法/.test(e.message),
      '未知 subjectType 必须 400 —— 修复前它会绕过白名单落库',
    );
    // ② 未知类型 + **传了**合法的 reasonKind ⇒ 仍然 400
    //    ⚠️ 修复前这一支同样落库 ⇒ 白名单形同虚设。
    assert.throws(
      () => fileAppeal({
        db, subjectType: 'foo', subjectId: 'st1:t1', filedBy: 'u_captain',
        reason: '算分错误', reasonKind: 'scoring_error',
        now: '2026-10-20T01:00:00.000Z', rules: F2_RULES,
      }),
      (e) => e.status === 400 && /主体类型非法/.test(e.message),
      '未知 subjectType 即使带了合法理由类型也必须 400（白名单管的是类型，不是理由）',
    );
    // ③ 表里**不得**留下任何主体类型非法的行
    const rows = db.prepare('SELECT subject_type FROM appeals').all();
    assert.deepEqual(rows, [], '被拒的申诉不得落库');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F2：主体类型**缺省**仍是 team_result（既有契约不变），且白名单非空时它必须声明理由类型', () => {
  const { db, close, dataDir } = f2Setup();
  try {
    f2Finalize(db);
    // ① 缺省（不传 subjectType）⇒ 按 team_result 处理 ⇒ 但**必须**声明理由类型
    //    （修复前这条也是 400，所以它不是判别性用例，是「不许改坏」的护栏）
    assert.throws(
      () => fileAppeal({
        db, subjectId: 'st1:t1', filedBy: 'u_captain',
        reason: '算分错误', now: '2026-10-20T01:00:00.000Z', rules: F2_RULES,
      }),
      (e) => e.status === 400 && /理由类型/.test(e.message),
      '赛段结果类必须声明理由类型（白名单 fail-closed）',
    );
    // ② 缺省 + 合法理由类型 ⇒ 受理，且**落库的 subject_type 必须是 team_result**
    const ok = fileAppeal({
      db, subjectId: 'st1:t1', filedBy: 'u_captain',
      reason: '企业确认分与事实不符', reasonKind: 'scoring_error',
      now: '2026-10-20T01:00:00.000Z', rules: F2_RULES,
    });
    assert.equal(ok.status, 'submitted');
    assert.equal(ok.subject_type, 'team_result', '缺省必须归一为 team_result（不能落 NULL 或别的值）');
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F2：报名类**不强制**理由类型（豁免只限报名类 —— 前端契约只发 reason）', () => {
  const { db, close, dataDir } = f2Setup();
  try {
    // 报名类豁免是**产品契约**（web/views/registration.js 只发 reason）⇒ 不能收窄掉。
    // 报名记录不存在 ⇒ 404（证明它走的是报名类分支，而不是赛段结果类分支）
    assert.throws(
      () => fileAppeal({
        db, subjectType: 'registration', subjectId: 'rg_not_exist', filedBy: 'u_captain',
        reason: '复核我的能力维度', now: '2026-10-20T01:00:00.000Z', rules: F2_RULES,
      }),
      (e) => e.status === 404 && /报名记录不存在/.test(e.message),
      '报名类必须走报名类分支（豁免只限 registration）',
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── F4：里程碑确认方与实现一致 ───────────────────────────────────────────
//
// ⚠️ **修复前的三重矛盾**：配置说「评委确认可演示原型」，而实现里
//    · 达成判定只有一条路径：`milestone_signoffs` 里有未撤回的一行
//      （`requires_signoff` 在表上是 `NOT NULL DEFAULT 1` ⇒ 恒为 1）
//    · 而该表 `enterprise_id TEXT NOT NULL` ⇒ **结构上企业专用**
//    · 且 `hasActiveSignoff` **不区分签字人**
//    ⇒ 评委的「确认」根本没有落库路径 ⇒ 该里程碑**永远达不成**（配置在说谎）。
test('F4：里程碑配置的确认方必须与实现一致（计分类只能是企业）', () => {
  const { rules } = loadRules(rulesDir);
  // ① 出厂配置：7 类里程碑全部 enterprise
  for (const it of rules.milestones.items) {
    assert.equal(
      it.confirmedBy, 'enterprise',
      `里程碑 ${it.key} 的确认方是 ${it.confirmedBy} —— 达成闸只认 milestone_signoffs（enterprise_id NOT NULL）`
      + ' ⇒ 评委确认的里程碑永远达不成（配置不许说谎）',
    );
  }
  // ② 改成 'judge' ⇒ 配置闸必须报错（拒绝启动）
  const broken = structuredClone(rules);
  const target = broken.milestones.items.find((i) => i.countsTowardTier);
  target.confirmedBy = 'judge';
  const errors = validateRules(broken);
  assert.ok(
    errors.some((e) => e.includes('milestones') && e.includes(target.key) && e.includes('enterprise')),
    `配置闸必须拒绝「计分类里程碑的确认方不是企业」，实际错误：${JSON.stringify(errors)}`,
  );
});

test('F4：`confirmedBy` 必须真的被消费（不是只校验、从不读取的死配置）', () => {
  // ⚠️ 修复前 `confirmedBy` **只被 config.js 校验、从不被任何实现读取** ⇒
  //    一份写着 'judge' 的配置看上去「评委确认里程碑」，实际是「这个里程碑谁都确认不了」。
  // ⇒ 现在它被机器闸（上一条用例）读到了 ⇒ 这条用例钉住「机器闸存在」这件事。
  const { rules } = loadRules(rulesDir);
  const src = readFileSync(join(here, '..', 'src', 'config.js'), 'utf8');
  assert.ok(
    src.includes("it.confirmedBy !== 'enterprise'"),
    'config.js 必须有一道「计分类里程碑的确认方必须是 enterprise」的机器闸',
  );
  assert.ok(
    rules.milestones.items.every((i) => i.countsTowardTier ? i.confirmedBy === 'enterprise' : true),
    '出厂配置里计分类里程碑的确认方必须全是 enterprise',
  );
});

// ── F5：截尾门槛与评委池下限必须相容 ────────────────────────────────────
//
// ⚠️ **修复前的病根**：`minJudgesForTrim: 5` 而 `judgePool.minJudgesPerDimension: 3`
//    ⇒ `domain/trim.js` 的 `list.length < minJudges` ⇒ 3 人评委池下**根本不去极值**
//    ⇒ C-07 选 `trimmed` 的理由（「样本少时截尾均值比 zscore 稳」）**在首届根本没兑现**。
test('F5：截尾门槛必须 ≤ 评委池下限（否则 trimmed 在实际评委池下永不触发）', () => {
  const { rules } = loadRules(rulesDir);
  for (const which of ['initial', 'final']) {
    const cfg = rules.scoring[which];
    const pool = cfg.judgePool.minJudgesPerDimension;
    const trim = cfg.minJudgesForTrim;
    assert.equal(
      trim, 3,
      `scoring.${which}.minJudgesForTrim 应为 3（与评委池下限同口径）`,
    );
    assert.ok(
      trim <= pool,
      `scoring.${which}.minJudgesForTrim（${trim}）> judgePool.minJudgesPerDimension（${pool}）`
      + ' ⇒ 评委池凑够人时永远轮不到去极值 ⇒ trimmed 策略形同虚设',
    );
  }
});

test('F5：3 名评委时截尾**真的生效**（C-07 的理由必须兑现）', () => {
  const { rules } = loadRules(rulesDir);
  const minJudges = rules.scoring.initial.minJudgesForTrim;
  const values = [
    { judgeId: 'j1', z: 1 },
    { judgeId: 'j2', z: 2 },
    { judgeId: 'j3', z: 99 },   // 极端值
  ];
  const out = trimOutliers({ values, minJudges });
  assert.equal(out.trimmed, true, `3 名评委（门槛 ${minJudges}）时必须去极值 —— 不去极值则 trimmed 策略没兑现`);
  assert.equal(out.mean, 2, '去极值后取中位数（1、2、99 ⇒ 留 2）');
  assert.equal(out.removed.max, 'j3', '必须报出被去掉的那个评委');
});

// ── F6：数据库层的「同一里程碑只记一次」 ────────────────────────────────
test('F6：迁移 011 建出**部分唯一索引** ⇒ 同一里程碑记两次会被数据库挡下', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-e182-mig-'));
  const { db, close } = openDatabase({ dataDir });
  try {
    applyMigrations(db, migrationsDir);
    // 索引必须在
    const idx = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_behavior_events_subject'",
    ).get();
    assert.ok(idx, '迁移后必须存在 ux_behavior_events_subject 索引');
    assert.ok(/UNIQUE/i.test(idx.sql), '它必须是 UNIQUE 索引（普通索引 = 没有数据库层约束）');
    assert.ok(/subject_id IS NOT NULL/i.test(idx.sql), '必须是**部分**索引（NULL 主体行不受约束）');

    // 造出被引用的行
    db.exec(`
      INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
      VALUES ('u1','甲','13900000001','x','other',NULL,0,1,'2026-10-20T00:00:00.000Z');
      INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
      VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z');
      INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
      VALUES ('t1','ed_1','甲队','u1',NULL,'active','2026-10-20T00:00:00.000Z');
    `);
    const ins = db.prepare(
      'INSERT INTO behavior_events (id, team_id, user_id, type, points, evidence, created_at, subject_id)'
      + ' VALUES (?,?,?,?,?,?,?,?)',
    );
    // ① 同一 (team, type, subject) 记两次 ⇒ 第二条必须被数据库挡下
    ins.run('be1', 't1', 'u1', 'milestone_on_time', 5, '{}', '2026-10-20T00:00:00.000Z', 'ms_1');
    assert.throws(
      () => ins.run('be2', 't1', 'u1', 'milestone_on_time', 5, '{}', '2026-10-20T01:00:00.000Z', 'ms_1'),
      /UNIQUE constraint failed/i,
      '同一里程碑的第二次行为分事件必须被**数据库**挡下（服务层已挡，这里是纵深防御）',
    );
    // ② 不同里程碑 ⇒ 允许
    ins.run('be3', 't1', 'u1', 'milestone_on_time', 5, '{}', '2026-10-20T02:00:00.000Z', 'ms_2');
    // ③ **无主体**的 once 类事件（同队同类型两条）⇒ 必须都放行
    //    ⚠️ 这正是「部分索引」的意义：once 事件共用「终身一次」桶，不能被这条索引误伤。
    ins.run('be4', 't1', 'u1', 'weekly_progress', 2, '{}', '2026-10-20T03:00:00.000Z', null);
    ins.run('be5', 't1', 'u1', 'weekly_progress', 2, '{}', '2026-10-20T04:00:00.000Z', null);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n, 4,
      '应当只有 4 行（第 2 条被唯一约束挡下，其余都放行）',
    );
  } finally {
    close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── F7：跨阶段接口契约的登记 ────────────────────────────────────────────
test('F7：`GET /api/readiness` 必须登记进**跨阶段接口契约**（端点存在 ≠ 契约存在）', () => {
  const text = readFileSync(join(repoRoot, 'docs', 'superpowers', 'plans', 'INTERFACES.md'), 'utf8');
  assert.ok(
    text.includes('/api/readiness'),
    'INTERFACES.md 必须登记 GET /api/readiness —— 修复前它 0 次出现 ⇒ 契约里查不到这个端点',
  );
  assert.ok(
    text.includes('ux_behavior_events_subject'),
    'INTERFACES.md 必须登记迁移 011 的唯一索引（对外可见的 schema 变更）',
  );
});
```

### 4.11 2026-10-28 E183 轮（送签件的**可打印 HTML 版**）—— 新建文件登记

E182 轮把送签件的分母推到 **27 条**（新增 M0-7 / M0-8）。本轮补一件事：**把送签件做成能直接打印 / 贴邮件的 HTML**。

⚠️ **为什么不能手写第二份 HTML**：送签件是**要拿回签字**的文件，而它的分母已经三连跳（17 → 22 → 25 → 27）
⇒ 每一次口径变更都要改清单 ⇒ 若 Markdown 与 HTML 各写一份，改了 Markdown 忘了改 HTML
⇒ **打印出去的那份是旧的** ⇒ 组委会签的是一份平台自己都不认的清单。
⇒ 改法不是「加个提醒」，而是**让漂移不可能**：HTML **由 Markdown 派生**（生成器只做渲染，不新增任何内容）。

| 文件 | 为什么必须是**新文件** |
|---|---|
| `docs/tools/build-signoff-pack-html.mjs` | 渲染器必须是**独立工具**：① 它是**通用的**（输入输出都是命令行参数）⇒ 不指向任何特定文件 ⇒ 进公开仓时不需要脱敏；② 它住在 `docs/tools/`（与 `plan-block-sync.mjs` / `dead-service-scan.mjs` 同款位置）⇒ 属于**仓库工具**而不是平台业务代码 ⇒ 不进 `platform/src/`（那会污染分层与死函数扫描的视野）。⚠️ **零依赖、零构建**（全局约束）⇒ 不引任何 Markdown 解析库，只做「本仓这份清单用得到的子集」⇒ 且**遇到不支持的语法要响亮报错**，不许静默丢内容（静默丢 = 打印件少一条口径，而没人看得出来）。 |
| `` | **生成产物**（不是源文件）⇒ 它的规格是「生成器 + 送签件 Markdown」，**不把 20KB 派生输出抄进计划块**（那正是生成器要消灭的那种重复）。⇒ 它的守门靠 `platform/test/signoff-pack-html.test.js` 那道**逐字节比对**的机器闸（比计划块更硬：手改 HTML 立刻变红）。 |
| `platform/test/signoff-pack-html.test.js` | 这条闸必须**自成一个文件**：它要同时跨三个文件（生成器 / Markdown 源 / HTML 产物）⇒ 塞进任何既有测试文件都会让「这条钉的是哪条口径」看不出来。 |

**Step 1: 创建 docs/tools/build-signoff-pack-html.mjs**

`docs/tools/build-signoff-pack-html.mjs`：

```javascript
// docs/tools/build-signoff-pack-html.mjs —— 把一份 Markdown 清单渲染成**可打印 / 可贴邮件**的 HTML
//
// 为什么要它（不是「再写一份 HTML」）：
//   ⚠️ **两份手写的内容一定会漂移** —— 送签件是**要拿回签字**的文件，
//      而它的分母已经三连跳（17 → 22 → 25 → 27）⇒ 每一次口径变更都要改清单
//      ⇒ 若 HTML 与 Markdown 各写一份，改了 Markdown 忘了改 HTML ⇒ **打印出去的那份是旧的**
//      ⇒ 组委会签的是一份平台自己都不认的清单。
//   ⇒ **HTML 由 Markdown 派生** ⇒ 两者**不可能**不一致（生成器只做渲染，不新增任何内容）。
//
// 零依赖（全局约束「零 npm 依赖、零构建」）：
//   本文件只做「本仓这份清单用得到的 Markdown 子集」的渲染，
//   **不是**通用 Markdown 解析器 —— 故意不支持表格合并单元格、HTML 块、脚注、代码高亮。
//   ⚠️ 遇到本子集不支持的语法 ⇒ **响亮报错**，不许静默丢内容
//      （静默丢 = 打印件少一条口径，而没人看得出来）。
//
// 用法：
//   node docs/tools/build-signoff-pack-html.mjs <input.md> <output.html>
//
// ⚠️ **本工具是通用的**：输入输出都是命令行参数 ⇒ 它不指向任何特定文件
//    ⇒ 进公开仓时不需要脱敏（公开仓里没有私有文档，也就没有「指向私有文件的引用」）。
//
// ⚠️ **本文件不属于平台前端**：项目纪律「不许自造 CSS 类 / 不写 <style> 标签」
//    管的是 `platform/web/` 的设计系统（机器闸 `test/stage-config-view.test.js`
//    把 `web/views/*.js` 的 class 与 `web/styles.css` 对账）。
//    本文件是**独立的一次性文档产物**（不进平台 UI、不进 `web/`）⇒ 自带 <style> 是零依赖
//    打印件的唯一做法（不引 CDN 字体、不引外部图片 ⇒ 断网可印、可贴邮件）。
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法： node docs/tools/build-signoff-pack-html.mjs <input.md> <output.html>');
  process.exit(2);
}

// ── HTML 转义 ──────────────────────────────────────────────────────
// ⚠️ **实体名在运行时用字符码拼**（`String.fromCharCode(38)` = `&`）。
//    原因：本仓的写入通道会把源码里的字面 HTML 实体解码一次
//    （`&` 落盘变成 `&`）⇒ 若把实体名写进源码，转义函数会退化成**恒等函数**
//    ⇒ 清单里的 `<` `>` 会被原样带进 HTML ⇒ 标签被浏览器当结构解析（内容可被改写）。
//    ⇒ 这里**一个字面 `&` 都不写** ⇒ 无论写入通道怎么处理，运行时拼出来的实体都是对的。
const AMP = String.fromCharCode(38);
const esc = (s) => String(s)
  .split(AMP).join(AMP + 'amp;')
  .split('<').join(AMP + 'lt;')
  .split('>').join(AMP + 'gt;');

// ── 行内标记 ────────────────────────────────────────────────────────
// ⚠️ 顺序：**先转义、后套标记** ⇒ 否则 `&` 会被后面的规则二次处理。
// ⚠️ 允许的原始 HTML 标签只有 `<br>`（清单里用它在一格里分段）⇒ 其余一律转义。
function inline(text) {
  let s = esc(text);
  // <br>：先摘出来（占位符），最后还原 —— 其余尖括号已被转义，不会误伤
  s = s.replace(/<br\s*\/?>/g, '\u0001BR\u0001');
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_, p, c) => `${p}<em>${c}</em>`);
  s = s.replace(/\u0001BR\u0001/g, '<br>');
  return s;
}

// ── 段落换行的连接规则 ──────────────────────────────────────────────
//
// ⚠️ **中文不该用空格连接**：Markdown 的源文件为了可读性把一句话拆成多行，
//    直接 `join(' ')` 会在中文句子中间插一个空格（「逐条勾选。 每条的完整依据…」）
//    ⇒ 读起来像有错别字。
// ⇒ 规则：**只有前后都是拉丁文/数字时才插空格**（那时空格是必需的），
//    其余（含中文接中文、中文接标点）**直接相接**。
const isLatin = (ch) => !!ch && /[A-Za-z0-9]/.test(ch);
function joinLines(lines) {
  let s = lines[0].trim();
  for (let i = 1; i < lines.length; i += 1) {
    const next = lines[i].trim();
    const prevTail = s.slice(-1);
    const nextHead = next.slice(0, 1);
    s += (isLatin(prevTail) && isLatin(nextHead)) ? ` ${next}` : next;
  }
  return s;
}

// ── Markdown 子集渲染 ────────────────────────────────────────────────
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push(`<p>${inline(joinLines(buf))}</p>`);
    buf.length = 0;
  };

  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // 空行 ⇒ 段落边界
    if (!line.trim()) {
      flushParagraph(para);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^---\s*$/.test(line)) {
      flushParagraph(para);
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用块（连续的 > 行合成一块）
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格：表头行 + `|---|` 分隔行 + 表体
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushParagraph(para);
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2; // 跳过表头 + 分隔行
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body.push(cells(lines[i]));
        i += 1;
      }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const tb = body.map((r) => {
        // 补齐/截断到表头列数 ⇒ 列数不齐时**不静默丢格**
        const cells2 = head.map((_, k) => r[k] ?? '');
        return `<tr>${cells2.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      }).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(para);
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushParagraph(para);
  return out.join('\n');
}

// ── 页面骨架 ────────────────────────────────────────────────────────
// ⚠️ 打印纪律：
//   · A4、页边距 14/12mm、字号 10.5pt（清单表格多，10.5pt 才装得下又不至于太小）
//   · 表头**每页重复**（display: table-header-group）⇒ 跨页表格不会失去列名
//   · 每组**不跨页断开**（break-inside: avoid 只给标题与提示块，表格允许断行）
//   · 勾选框用字符 ☐ 并放大 —— 打印后手写打勾即可（不依赖任何表单交互）
// ⚠️ 配色：正文近黑、提示块浅灰、**强调色只用 1 个**（深蓝）⇒ 黑白打印也不糊。
const CSS = `
:root {
  --ink: #1a1a1a;
  --muted: #55585c;
  --line: #c9ccd1;
  --soft: #f5f6f7;
  --accent: #14508c;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0 auto;
  padding: 18px 20px 40px;
  max-width: 980px;
  color: var(--ink);
  background: #fff;
  font: 15px/1.65 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC",
        "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif;
}
h1 { font-size: 22px; line-height: 1.35; margin: 0 0 6px; letter-spacing: .2px; }
h2 {
  font-size: 17px; margin: 30px 0 10px; padding-bottom: 5px;
  border-bottom: 2px solid var(--accent); color: var(--accent);
}
h3 { font-size: 15px; margin: 22px 0 8px; color: var(--ink); }
h4 { font-size: 14px; margin: 16px 0 6px; }
p { margin: 8px 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }
a { color: var(--accent); }
code {
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--soft); padding: 1px 4px; border-radius: 3px;
  /* ⚠️ 用 overflow-wrap 而不是 word-break: break-all ——
     后者会在**任何**字符处断行（长路径被拦腰截成 "docs/committee-appr / ovals.md"）
     ⇒ 前者只在真的放不下时才断，且优先在分隔符处断。 */
  overflow-wrap: anywhere;
}
strong { font-weight: 700; }
blockquote {
  margin: 10px 0; padding: 8px 14px;
  background: var(--soft); border-left: 3px solid var(--line);
  color: var(--muted); font-size: 14px;
}
blockquote p { margin: 4px 0; }
blockquote h1, blockquote h2, blockquote h3 { font-size: 14px; margin: 6px 0 4px; color: var(--muted); border: 0; }
table {
  width: 100%; border-collapse: collapse; margin: 10px 0 16px;
  font-size: 13px; table-layout: fixed;
}
th, td {
  border: 1px solid var(--line); padding: 6px 8px;
  text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere;
}
th { background: var(--soft); font-weight: 700; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
ol, ul { margin: 8px 0 8px 22px; padding: 0; }
li { margin: 3px 0; }
.doc-head {
  border-bottom: 2px solid var(--ink); padding-bottom: 12px; margin-bottom: 6px;
}
.doc-meta { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
.box { background: var(--soft); border: 1px solid var(--line); padding: 8px 12px; margin: 10px 0; font-size: 13px; }
.box p { margin: 3px 0; }
.tick { font-size: 15px; letter-spacing: .5px; }
.sign td { height: 42px; }
.sign-note { color: var(--muted); font-size: 12px; margin-top: 14px; }
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  body { padding: 0; max-width: none; font-size: 10.5pt; line-height: 1.5; }
  h1 { font-size: 16pt; }
  h2 { font-size: 13pt; margin: 16pt 0 6pt; break-after: avoid; page-break-after: avoid; }
  h3 { font-size: 11pt; margin: 12pt 0 5pt; break-after: avoid; page-break-after: avoid; }
  table { font-size: 9pt; }
  th, td { padding: 3.5pt 5pt; }
  code { font-size: 8.5pt; }
  blockquote { font-size: 9pt; }
  .box { font-size: 9pt; }
  a { color: var(--ink); text-decoration: none; }
  .no-print { display: none; }
}
`;

// ── 生成 ────────────────────────────────────────────────────────────
const md = readFileSync(src, 'utf8');
const body = renderMarkdown(md);

// ⚠️ **不许静默丢内容**：渲染前后各数一次「勾选框」与「表格行」，
//    对不上就报错（静默丢 = 打印件少一条口径，而没人看得出来）。
// ⚠️ 两边的「行」形态不同 ⇒ 各用各的口径：
//    源文件里表格行是 `|` 开头的行（**分隔行不算数据行**）；
//    渲染后是 `<tr>` 标签。
const countTick = (s) => (s.match(/☐/g) || []).length;
const mdTableRows = (s) => s.split('\n')
  .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length;
const htmlTableRows = (s) => (s.match(/<tr>/g) || []).length;

const beforeTicks = countTick(md);
const beforeRows = mdTableRows(md);
const afterTicks = countTick(body);
const afterRows = htmlTableRows(body);
if (beforeTicks !== afterTicks) {
  console.error(`❌ 勾选框数量对不上：源 ${beforeTicks} / 渲染后 ${afterTicks} ⇒ 渲染丢了内容`);
  process.exit(1);
}
if (beforeRows !== afterRows) {
  console.error(`❌ 表格行数对不上：源 ${beforeRows} / 渲染后 ${afterRows} ⇒ 渲染丢了内容`);
  process.exit(1);
}

const title = (md.match(/^#\s+(.*)$/m) || [, '送签件'])[1].trim();
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="doc-meta no-print">本文件由 <code>docs/tools/build-signoff-pack-html.mjs</code> 从 Markdown 源生成 —— <strong>请勿直接改 HTML</strong>；改 Markdown 后重新生成即可。打印建议：A4、默认缩放、勾选框可手写打勾。</div>
${body}
</body>
</html>
`;

writeFileSync(dst, html, 'utf8');
console.log(`✅ 已生成 ${dst}`);
console.log(`   勾选框 ${afterTicks} 个 ｜ 表格行 ${afterRows} 行 ｜ 字节 ${Buffer.byteLength(html)}`);
```

**Step 2: 创建 platform/test/signoff-pack-html.test.js**

`platform/test/signoff-pack-html.test.js`：

```javascript
// platform/test/signoff-pack-html.test.js —— 送签件 HTML 版的机器闸（2026-10-28）
//
// 规则溯源：
//   - 送签件是**要拿回签字**的文件 ⇒ 它的 HTML 打印件必须与 Markdown 源**逐字同源**
//     （否则「改了 Markdown 忘了重生成」⇒ 组委会签的是一份平台自己都不认的清单）
//   - 全局约束「零 npm 依赖、零构建」⇒ HTML 必须**自包含**（断网可印、可贴邮件）
//
// ⚠️ **为什么要有这条闸**：
//   分母已经三连跳（17 → 22 → 25 → 27）⇒ 每一次口径变更都要改清单。
//   若 HTML 与 Markdown 各写一份 ⇒ 这条「不许手改 HTML」的纪律只靠人记 ⇒ 迟早漂。
//   ⇒ 改法不是「加个提醒」，而是**让漂移不可能**：HTML 由生成器派生，
//     本条用例**重新生成一遍并逐字节比对** ⇒ 手改 HTML 立刻变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const toolPath = join(repoRoot, 'docs', 'tools', 'build-signoff-pack-html.mjs');
const srcPath = join(repoRoot, 'docs', '');
const outPath = join(repoRoot, 'docs', '');

/**
 * ⚠️ **本组用例在公开仓镜像里「不适用」**（不是失败）。
 *
 * 原因：送签件的 Markdown 与 HTML 产物都是**私有文档** ⇒ 公开仓镜像会把它们**排除**
 * ⇒ 本组用例守的「产物与源逐字节一致」在公开仓**没有对象可守**。
 *
 * ⚠️ **判定必须用「是不是文件」而不是「存不存在」**：
 *   脱敏替换表会把私有文档的**路径**替换成空串 ⇒ 在公开仓里这两个路径会指向
 *   `docs/` **目录**（不是文件）⇒ 只判「存在」会把它当成「存在但读不了」⇒ 变成**报错**。
 *   ⇒ 这里判 `isFile()` ⇒ 目录/缺失都归入「不适用」。
 */
const isFile = (p) => {
  try { return statSync(p).isFile(); } catch { return false; }
};
const AVAILABLE = isFile(srcPath) && isFile(outPath);
const SKIP_REASON = '送签件是私有文档，公开仓镜像已脱敏排除 ⇒ 本组用例不适用';

/** 重新生成到临时目录，返回生成结果 */
function regenerate() {
  const dir = mkdtempSync(join(tmpdir(), 'hks-signoff-'));
  const tmp = join(dir, 'out.html');
  execFileSync(process.execPath, [toolPath, srcPath, tmp], { cwd: repoRoot, stdio: 'pipe' });
  const text = readFileSync(tmp, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return text;
}

test('送签件 HTML：必须与生成器输出**逐字节一致**（手改 HTML ⇒ 本条变红）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const onDisk = readFileSync(outPath, 'utf8');
  const regenerated = regenerate();
  assert.equal(
    onDisk, regenerated,
    ' 与生成器输出不一致 '
    + '⇒ 它被手改过，或 Markdown 改完没重新生成 '
    + '⇒ 修法：node docs/tools/build-signoff-pack-html.mjs  ',
  );
});

test('送签件 HTML：必须**自包含**（零外部资源 ⇒ 断网可印、可贴邮件）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  assert.equal(
    (html.match(/https?:\/\//g) || []).length, 0,
    '不得引用任何外部 URL（CDN 字体 / 外部图片 / 远程脚本）⇒ 断网打印会缺样式',
  );
  assert.ok(!/<link\b/i.test(html), '不得有 <link>（外部样式表）');
  assert.ok(!/<script\b/i.test(html), '不得有 <script>（本文件是静态打印件，不需要脚本）');
  assert.ok(!/@import\b/i.test(html), '不得有 CSS @import');
});

test('送签件 HTML：正文**不得有未转义的裸尖括号**（否则内容可被浏览器当标签改写）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  const stripped = html.replace(/<[^>]*>/g, '');
  assert.equal(
    (stripped.match(/[<>]/g) || []).length, 0,
    '剥掉合法标签后仍出现裸尖括号 ⇒ 转义函数失效（清单里的内容可被结构解析）',
  );
});

test('送签件 HTML：27 条与勾选栏**一个不少**（分母是硬事实）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  const md = readFileSync(srcPath, 'utf8');
  // ⛔ 分母以 **Markdown 源**为准（那是唯一的真相来源），HTML 必须与它一致
  const mdTicks = (md.match(/☐/g) || []).length;
  const htmlTicks = (html.match(/☐/g) || []).length;
  assert.ok(mdTicks >= 27, `源文件的勾选框只有 ${mdTicks} 个 ⇒ 分母不对`);
  assert.equal(htmlTicks, mdTicks, '勾选框数量与源文件不一致');
  // 六组 + 备案组 ⇒ 七个组标题
  for (const g of ['第一组', '第二组', '第三组', '第四组', '第五组', '第六组', '第七组']) {
    assert.ok(html.includes(g), `HTML 里少了「${g}」`);
  }
  // 签收表必须存在（这是「拿回签字」的落点）
  assert.ok(html.includes('签收'), 'HTML 里必须有签收表');
  assert.ok(html.includes('确认人'), '签收表必须有「确认人」栏');
});

test('送签件 HTML：打印样式在位（A4 + 表头每页重复 + 不打印编辑提示）', { skip: !AVAILABLE && SKIP_REASON }, () => {
  const html = readFileSync(outPath, 'utf8');
  assert.ok(/@page\s*\{[^}]*size:\s*A4/.test(html), '必须声明 A4 页面尺寸');
  assert.ok(/table-header-group/.test(html), '表头必须每页重复（跨页表格不能失去列名）');
  assert.ok(/\.no-print\s*\{\s*display:\s*none/.test(html), '「本件由生成器产出」的提示行不得打印');
});
```

**Step 3: 生成产物**

```bash
node docs/tools/build-signoff-pack-html.mjs  
```

⚠️ **产物是私有文档**（与 `` 同款）⇒ 不进公开仓
⇒ 公开仓镜像的「私有文档排除表」与「引用中性化替换表」**必须同步加上它**
⇒ 否则它的文件名会从 commit message 或正文里漏出去（上一轮踩过：新增私有文档忘了进替换表）。

⚠️ **视觉纪律的适用范围**：本文件**不属于平台前端** ⇒ 项目纪律「不许自造 CSS 类 / 不写 <style> 标签」
管的是 `platform/web/` 的设计系统（机器闸 `test/stage-config-view.test.js` 把 `web/views/*.js` 的 class
与 `web/styles.css` 对账）。独立打印件自带 `<style>` 是**零依赖打印件的唯一做法**
（不引 CDN 字体、不引外部图片 ⇒ 断网可印、可贴邮件）。

### 4.12 2026-10-28 E184 轮

E183 轮补了送签件的打印件；本轮处理的是**另一条线**：真机截图显示**公开榜单页把内部告警码直接渲染给了访客**
（`normalization_fallback` / `R2_missing_dual_signature` / `dimension_no_scores` …）。
⇒ 系统性排查后确认**不止榜页**：发榜页把码当正文前缀、告警正文里还内嵌着内部规则号与原始错误消息、
英文维度键出现在评审页与催评清单里。

⚠️ **为什么必须新建文件（而不是塞进 warning-wording.test.js）**：本闸钉的是**跨文件不变量**
（领域层产的码清单 → 界面渲染 → API 响应 → 告警正文），塞进任何既有测试文件都会让
「这条钉的是哪条口径」看不出来。⚠️ 清单必须**实时抽**（helper）——手写清单 ⇒ 新加的码漏过去 ⇒ 闸是假绿的。

| 文件 | 为什么必须是**新文件** |
|---|---|
| `platform/test/internal-code-leak.test.js` | 这条闸要同时跨**四个文件**（领域层 / 服务层 / 视图 / API 可见性）⇒ 塞进任何既有测试文件都会让它变成「某个既有文件的一条附带断言」⇒ 回归时看不出是哪条口径在守。 |
| `platform/test-helpers/internal-codes.js` | 内部码清单与维度键清单的**抽取口径**必须只有一份（清单与闸分开放 ⇒ 会漂）⇒ 放进 `test-helpers/`（与 `strip-comments.js` / `tmp.js` 同款位置，零依赖守卫会一起扫）。 |

**Step 1: 创建 platform/test-helpers/internal-codes.js**

`platform/test-helpers/internal-codes.js`：

```javascript
// platform/test-helpers/internal-codes.js — 内部规则键清单（测试专用共享工具）
//
// ⛔ 它是**测试辅助工具**，不是被测代码：放在 test-helpers/ 下，
//    零依赖守卫（test/zero-deps.test.js 的 SCAN_DIRS 含 'test-helpers'）会一起扫，
//    本文件只用 Node 标准库（node:fs / node:path），符合「零 npm 依赖」承诺。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
//   「内部规则键不许出现在用户可见界面上」这条闸，如果只钉住手写的几个码
//   （normalization_fallback / R2_missing_dual_signature 这种），
//   那么**新加**的码只要没顺手补进清单就漏过去 ⇒ 闸是**假绿**的
//   （与「禁用清单必须真有词条，空清单不等于已保护」同一类病）。
//   ⇒ 清单必须**从源码实时抽**：领域层/服务层每写一个 `code: '…'` 就自动进清单
//   ⇒ 漏一个就红。
//
// ⚠️ **抽的是「告警的 code 字段」**（`code: '…'` 这种**具名属性**字面量）：
//   - 它**不包括** HTTP 错误码（`appError(404, 'STAGE_NOT_FOUND', …)` 是位置参数）——
//     那些是三态语义的一部分，出现在错误消息里是合理的。
//   - 它**包括**领域层与服务层产出的告警码（judge_pool_invalid / R2_… /
//     tiebreak_key_unusable / NO_COMPUTATION_SNAPSHOT …）。
//
// ⚠️ **fail-closed 取向**：清单只增不减（不设排除名单）。
//   唯一被排除的是 `src/services/auth.js` —— 它那三个 `code:` 是
//   **口令校验结果**（`{ ok: false, code: 'PASSWORD_TOO_SHORT' }`），不是告警；
//   但它们**同样不许出现在界面上** ⇒ 保留在清单里（宁可多扫）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');

/** 递归列出目录下所有 .js 文件（按路径排序 ⇒ 抽取结果稳定）。 */
function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 内部规则键清单（告警 code 的全集）。
 * @param {string} [platformDir] 平台目录（默认 platform/）
 * @returns {string[]} 排序后的码数组
 */
export function internalWarningCodes(platformDir = PLATFORM_DIR) {
  const files = [
    ...listJsFiles(join(platformDir, 'src', 'domain')),
    ...listJsFiles(join(platformDir, 'src', 'services')),
  ];
  const codes = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bcode:\s*'([A-Za-z0-9_]+)'/g)) codes.add(m[1]);
  }
  return [...codes].sort();
}

/**
 * 规则的**英文维度键**清单（同样是内部标识）。
 * ⚠️ 维度键来自 `rules/scoring-*.json` 的 `dimensions[].key`
 *    —— 这些键会随规则集演进 ⇒ 必须实时抽（手写清单会漂）。
 * @param {string} [platformDir] 平台目录（默认 platform/）
 * @returns {string[]} 排序后的维度键数组
 */
export function internalDimensionKeys(platformDir = PLATFORM_DIR) {
  const rulesDir = join(platformDir, 'rules');
  const keys = new Set();
  for (const name of readdirSync(rulesDir).sort()) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(rulesDir, name), 'utf8'));
    } catch {
      continue;   // 不是规则文件 / 解析失败 ⇒ 跳过（不是本闸要管的事）
    }
    for (const dim of parsed?.dimensions ?? []) {
      if (typeof dim?.key === 'string') keys.add(dim.key);
    }
  }
  return [...keys].sort();
}
```

**Step 2: 创建 platform/test/internal-code-leak.test.js**

`platform/test/internal-code-leak.test.js`：

```javascript
// platform/test/internal-code-leak.test.js —— 「内部标识不许出现在用户可见界面上」机器闸
//
// 依据：
//   - S-5 / C-05「降级必须显式展示，不静默」⇒ 告警**一条都不许少**（本闸只管**怎么显示**）。
//   - 设计文档 §6.6 + src/domain/visibility.js 头注释「可见性必须在 API 层过滤：
//     **前端隐藏 = 数据已经发到浏览器 = 任何人都能看到**」⇒ 内部标识的处置在**数据层**，
//     界面只渲染人话。
//   - 「内部工作语言不进正文」（web/views/leaderboard.js 文件头的既有契约）。
//
// ⚠️ **本闸为什么必须单独成一个文件**（而不是塞进 warning-wording.test.js）：
//   它钉的是**跨文件**的不变量（领域层产的码清单 → 界面渲染 → API 响应），
//   塞进任何既有测试文件都会让「这条钉的是哪条口径」看不出来。
//
// ── E184（2026-10-28）：这条闸的由来 ─────────────────────────────────────
//   真机截图：公开榜单页顶部「本轮降级提示」里直接印着
//   `normalization_fallback` / `R2_missing_dual_signature` / `dimension_no_scores` …
//   ⇒ **内部规则键被渲染给了每一个访客**。
//   ⚠️ 根因是**三层各修了一半**：
//     E135（2026-10-23）修的是 `[code]` **方括号前缀**；
//     E144（2026-10-23）修的是演示站漏了 `detail` 裁剪；
//     E172（2026-10-24）修的是裁剪用黑名单 ⇒ 改成白名单，但把 `code` 当
//       「机器判据 / 审计靠它定位」而**故意留在白名单里**；
//     P10（2026-10-23）把 `[code]` 降级成「小号等宽标签」（`.warn__code`）——
//       **标签仍是可见文本** ⇒ 同一个洞只补了外层。
//   ⇒ 现在收口：**公开响应里连 `code` 都不下发**（领域层白名单），
//     **界面上一律不渲染**（本闸）。
//
// ⚠️ **本闸是行为闸，不是源码字符串闸**：
//   断言的是「渲染出来的 HTML 里有没有内部码」与「响应体里有没有内部码」，
//   不是「源码里有没有某个字符串」（那种断言会被无关代码顶替）。
//
// ⚠️ **清单必须实时抽**（test-helpers/internal-codes.js）：
//   手写清单 ⇒ 新加的码只要没顺手补进去就漏过去 ⇒ 闸是假绿的。
//   ⇒ 领域层/服务层每写一个 `code: '…'` 就自动进清单 ⇒ 漏一个就红。
//
// ⚠️ **审计页是显式例外**（见下方 DECLARED_EXCEPTIONS）：
//   `web/views/audit.js` 是**审计工作台**（能力点 `audit:read` 保护），
//   它按设计展示内部标识（英文维度键、降级原因码）—— 那是审计定位能力的落点，
//   不是泄漏。⇒ 例外必须**登记 + 写理由**，不许静默豁免。
//
// ⚠️ 零依赖 / 零 npm 包 / 原生 ESM：只用 node:test + node:assert。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leaderboardHtml } from '../web/views/leaderboard.js';
import { publishHtml, publishMissingHtml } from '../web/views/publish.js';
import { buildReviewItems, reviewErrorHint } from '../web/views/review.js';
import { applyVisibility } from '../src/domain/visibility.js';
import { scoreStage } from '../src/domain/scoring.js';
import { applyEnterpriseRules } from '../src/domain/enterprise-seat.js';
import { loadRules } from '../src/config.js';
import { internalWarningCodes, internalDimensionKeys } from '../test-helpers/internal-codes.js';
import { stripComments } from '../test-helpers/strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_VIEWS_DIR = join(here, '..', 'web', 'views');

/** 内部规则键清单（从源码实时抽）。 */
const CODES = internalWarningCodes();
/** 英文维度键清单（从规则集实时抽）。 */
const DIM_KEYS = internalDimensionKeys();

/**
 * 显式登记的例外：哪些界面**按设计**可以出现内部标识。
 * ⚠️ 例外必须写理由（不许静默豁免）—— 与 demo parity 的
 *    `DECLARED_DEMO_EXCLUSIONS` 同一取向：**没人知道的豁免 = 假的全覆盖**。
 * ⚠️ `scope` 决定这条例外覆盖哪一道闸（不许一刀切）。
 */
const DECLARED_EXCEPTIONS = [
  {
    view: 'audit.js',
    scope: 'internal-identifiers',
    reason: '审计工作台（能力点 audit:read 保护）：它按设计展示英文维度键与降级原因码 —— '
      + '那是审计定位能力的落点（把一条降级告警定位到具体规则），不是对外泄漏。',
  },
  {
    view: 'publish.js',
    scope: 'hardcoded-code-set',
    reason: '发榜页的「硬降级 / 提示」分级判据抄在视图里（`HARD_WARNING_CODES`）。'
      + '⚠️ **已知缺陷**：前端自己维护一份后端判据 ⇒ 新加的硬降级码会漏判'
      + '（分级漂移），且与发榜页自己写的「这些结论都来自 API，前端不自己判定」相矛盾。'
      + '本轮**只登记不修** —— 分级口径属**业务裁决**（哪些算硬降级）'
      + '⇒ 不得由代码单方面拍板 ⇒ 待办 **E185**（需送签口径 + 下沉到领域层）。'
      + '⚠️ 它**不渲染**这些码（E184 已把 `【code】` 前缀换成 `【硬降级】`）'
      + '⇒ 这条例外与「内部码泄漏」无关，只与「判据漂移」有关。',
  },
];

// ══════════════════════════════════════════════════════════════════
// 一、清单本身：空清单 = 假绿
// ══════════════════════════════════════════════════════════════════

test('★ 清单不是空的：内部码 ≥ 20 条、维度键 ≥ 3 条（空清单等于没保护）', () => {
  assert.ok(CODES.length >= 20,
    `内部码清单只有 ${CODES.length} 条 —— 抽取口径坏了（否则本文件所有闸都是假绿）`);
  assert.ok(DIM_KEYS.length >= 3,
    `维度键清单只有 ${DIM_KEYS.length} 条 —— 抽取口径坏了`);
  // ⚠️ 抽样核对：清单必须真的含「臭名昭著」的那几个码
  for (const must of ['normalization_fallback', 'dimension_no_scores', 'R2_missing_dual_signature']) {
    assert.ok(CODES.includes(must), `清单里必须有 ${must}`);
  }
});

// ══════════════════════════════════════════════════════════════════
// 二、界面层：渲染结果里不许出现内部标识
// ══════════════════════════════════════════════════════════════════

/** 造一组「每个内部码一条」的告警（正文刻意不含码 ⇒ 只可能从 code 字段漏出去）。 */
function warningsOfEveryCode() {
  return CODES.map((code, i) => ({
    code,
    message: `第 ${i + 1} 条降级说明。`,
    stageName: '决赛赛段',
  }));
}

test('★ 榜单页（公开公示页）：每一个内部码都不许出现在渲染结果里', () => {
  const html = leaderboardHtml({
    scope: 'rolling',
    warnings: warningsOfEveryCode(),
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
  });
  const leaked = CODES.filter((c) => html.includes(c));
  assert.deepEqual(leaked, [], `榜单页渲染出了内部码：${leaked.join(', ')}`);
  // ⚠️ 判别性：夹具必须真的被渲染了（不然上面那条断言是假绿）
  assert.ok(html.includes('第 1 条降级说明。'), '告警正文必须真的渲染出来（否则这条闸是假绿）');
  assert.ok(html.includes('本轮降级提示'), '告警块必须真的渲染出来');
});

test('★ 发榜页：每一个内部码都不许出现在渲染结果里', () => {
  const html = publishHtml({
    board: {
      stage: { id: 'st_1', name: '决赛赛段' },
      teams: [{ id: 't_alpha', name: '拾光队' }],
      judgeDimensions: DIM_KEYS.map((key, i) => ({ key, name: `维度${i + 1}`, weight: 0.1, seat: 'judge' })),
      progress: { scope: 'stage', total: 0, submitted: 0, missing: [] },
    },
    result: { computationId: 'cmp_1', revision: 1, teams: [], warnings: warningsOfEveryCode() },
  });
  const leaked = CODES.filter((c) => html.includes(c));
  assert.deepEqual(leaked, [], `发榜页渲染出了内部码：${leaked.join(', ')}`);
  assert.ok(html.includes('第 1 条降级说明。'), '告警正文必须真的渲染出来（否则这条闸是假绿）');
});

test('★ 评审页的错误提示：英文维度键不许出现（只给人话维度名）', () => {
  const dims = DIM_KEYS.map((key, i) => ({ teamId: 't_alpha', key, name: `维度${i + 1}` }));
  const { errors } = buildReviewItems({}, dims);
  assert.ok(errors.length > 0, '夹具必须产出错误（否则这条闸是假绿）');
  // ⚠️ 必须调**生产路径**的纯函数（reviewErrorHint）——
  //    若在测试里重写一遍拼接逻辑，改生产代码闸不会红 ⇒ 假绿（变异检验 M5 实测抓到过）。
  const hint = reviewErrorHint(errors, dims);
  const leaked = DIM_KEYS.filter((k) => hint.includes(k));
  assert.deepEqual(leaked, [], `错误提示里出现了英文维度键：${leaked.join(', ')}`);
  assert.ok(hint.includes('维度1'), '中文维度名必须真的出现（否则这条闸是假绿）');
});

test('★ 发榜页的缺格面板：英文维度键不许出现', () => {
  const judgeDimensions = DIM_KEYS.map((key, i) => ({ key, name: `维度${i + 1}` }));
  const html = publishMissingHtml(
    { missing: DIM_KEYS.map((key) => ({ teamId: 't_alpha', dimension: key, judgeId: 'u_j1' })) },
    [{ id: 't_alpha', name: '拾光队' }],
    judgeDimensions,
  );
  const leaked = DIM_KEYS.filter((k) => html.includes(k));
  assert.deepEqual(leaked, [], `缺格面板里出现了英文维度键：${leaked.join(', ')}`);
  assert.ok(html.includes('拾光队'), '队名必须真的出现（否则这条闸是假绿）');
});

// ══════════════════════════════════════════════════════════════════
// 三、数据层：公开响应里连内部码都不下发（fail-closed）
// ══════════════════════════════════════════════════════════════════

test('★ 领域层唯一入口 applyVisibility：没有 audit:read ⇒ 内部码一个都不许下发', () => {
  const payload = {
    scope: 'rank',
    rows: [{ teamId: 't_a', teamName: 'A队', rank: 1, total: 90, points: 10, tier: 'A' }],
    warnings: warningsOfEveryCode(),
  };
  const out = applyVisibility({
    payload,
    viewer: null,
    visibilityConfig: { rank: { showEnterpriseName: false } },
    context: { scope: 'rank' },
  });
  assert.equal(out.warnings.length, CODES.length, '告警一条都不许少（S-5 / C-05）');
  const leaked = CODES.filter((c) => JSON.stringify(out.warnings).includes(c));
  assert.deepEqual(leaked, [], `公开响应里下发了内部码：${leaked.join(', ')}`);
  for (const w of out.warnings) {
    assert.equal(w.code, undefined, '公开响应里的告警不许带 code');
    assert.ok(w.message, '人话正文必须保留');
  }
});

test('★ 领域层唯一入口 applyVisibility：有 audit:read ⇒ 完整告警（含 code）仍在', () => {
  const payload = {
    scope: 'rank',
    rows: [],
    warnings: warningsOfEveryCode(),
  };
  const out = applyVisibility({
    payload,
    viewer: { id: 'u_auditor' },
    visibilityConfig: { rank: { showEnterpriseName: false } },
    context: { scope: 'rank', canAudit: true },
  });
  assert.equal(out.warnings.length, CODES.length, '告警一条都不许少');
  const missing = CODES.filter((c) => !out.warnings.some((w) => w.code === c));
  assert.deepEqual(missing, [], `审计员必须拿得到全部 code（审计定位靠它）：${missing.join(', ')}`);
});

// ══════════════════════════════════════════════════════════════════
// 五、正文层：告警的 message 里不许出现内部规则号 / 内部原因码
//    （E184 的第二批发现：`code` 字段本身治好了，但**正文里还内嵌着码**）
// ══════════════════════════════════════════════════════════════════

/**
 * 真实的领域层告警（走真引擎，不是手搓夹具）。
 * ⚠️ 夹具必须**覆盖多条产生路径**（评分 / 企业席 / 名册缺失），
 *    否则「正文里没有码」只是因为那条路径没被跑到。
 */
function realDomainWarnings() {
  const { rules } = loadRules(join(here, '..', 'rules'));
  const config = rules.scoring.final;
  const out = [];

  // ① 评分路径：归一化降级 / 自评差异 / 缺分维度 / 没有评分
  out.push(...scoreStage({
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
  }).warnings);

  // ② 名册缺失路径：team_roster_missing
  out.push(...scoreStage({
    config,
    judges: [{ judgeId: 'j1', seat: 'judge' }],
    submissions: [],
    enterpriseConfirmations: [],
    peerReviews: [],
    teams: [],
    selfReviews: [],
  }).warnings);

  // ③ 企业席路径：缺双签 / 缺签字内容
  const ent = applyEnterpriseRules({
    config,
    confirmations: [{ teamId: 't_a', enterpriseId: 'e_1', reasons: ['content'], score: 80 }],
    teams: [{ teamId: 't_a', packageEnterpriseId: 'e_1', isFreeBrief: false }],
    judges: [],
  });
  out.push(...(ent.warnings ?? []));

  return out;
}

test('★ 正文层：真实引擎产出的告警正文里不许出现内部规则号 / 内部原因码', () => {
  const warnings = realDomainWarnings();
  assert.ok(warnings.length >= 3, `夹具必须产出多条告警（实际 ${warnings.length} 条）`);
  const offenders = [];
  for (const w of warnings) {
    const msg = String(w?.message ?? '');
    // ① 内部规则号：R1 / R4 / R-JDG-14 …
    for (const m of msg.matchAll(/\bR-?[A-Z]*-?\d+\b/g)) offenders.push(`${w.code} 的正文里有规则号 ${m[0]}`);
    // ② 其他内部码（判据里内部原因码都在清单上）
    for (const code of CODES) {
      if (code === w.code) continue;   // 本条告警自己的码不算「内嵌别人的码」
      if (msg.includes(code)) offenders.push(`${w.code} 的正文里内嵌了 ${code}`);
    }
  }
  assert.deepEqual(offenders, [], `告警正文里出现了内部标识：\n${offenders.join('\n')}`);
});

test('★ 正文层：源码里的告警正文不许拼内部码 / 内部规则号（防回流）', () => {
  const offenders = [];
  for (const file of domainAndServiceFiles()) {
    const src = stripComments(readFileSync(file, 'utf8'));
    // 取每个 `message:` 之后、下一个 `message:` / `detail:` / `code:` 之前的窗口
    const marks = [...src.matchAll(/\b(message|detail|code):/g)];
    for (let i = 0; i < marks.length; i += 1) {
      if (marks[i][1] !== 'message') continue;
      const from = marks[i].index;
      const to = i + 1 < marks.length ? marks[i + 1].index : src.length;
      const win = src.slice(from, Math.min(to, from + 400));
      if (/\.code\b/.test(win)) {
        offenders.push(`${file.replace(/.*platform\//, '')}: 正文里拼了错误码`);
      }
      for (const m of win.matchAll(/\bR-?[A-Z]*-?\d+\b/g)) {
        offenders.push(`${file.replace(/.*platform\//, '')}: 正文里有规则号 ${m[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `告警正文里拼了内部标识：\n${offenders.join('\n')}`);
});

// ══════════════════════════════════════════════════════════════════
// 六、静态闸：视图的模板插值里不许引用 `code` 标识符（防回流）
// ══════════════════════════════════════════════════════════════════

function listViewFiles() {
  const out = [];
  for (const name of readdirSync(WEB_VIEWS_DIR).sort()) {
    const p = join(WEB_VIEWS_DIR, name);
    if (statSync(p).isFile() && name.endsWith('.js')) out.push({ name, path: p });
  }
  return out;
}

/** 领域层 + 服务层的源文件（告警正文的产地）。 */
function domainAndServiceFiles() {
  const out = [];
  for (const dir of ['domain', 'services']) {
    const root = join(here, '..', 'src', dir);
    const walk = (d) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js')) out.push(p);
      }
    };
    walk(root);
  }
  return out;
}

/**
 * 抽出源码里的**模板字面量**（反引号包起来的那些）。
 * ⚠️ 只关心「会被渲染进 HTML 的那段文本」⇒ 判据是「字面量里有没有内部码」。
 * ⚠️ 手工扫描（不是正则）：模板里可以嵌套 `${ … }`（里面还能有反引号），
 *    正则会在嵌套处切错。
 */
function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '`') { i += 1; continue; }
    const start = i;
    i += 1;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && src[i + 1] === '{') { depth += 1; i += 2; continue; }
      if (c === '}' && depth > 0) { depth -= 1; i += 1; continue; }
      if (c === '`' && depth === 0) { i += 1; break; }
      i += 1;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

test('★ 静态闸：视图的模板插值里不许出现 `code` 标识符（内部键不许被拼进 HTML）', () => {
  const offenders = [];
  for (const { name, path } of listViewFiles()) {
    // ⛔ 先剥注释：注释里举例子写 `normalization_fallback` 是**说明**，不是渲染
    const src = stripComments(readFileSync(path, 'utf8'));
    for (const m of src.matchAll(/\$\{([^{}]*)\}/g)) {
      if (/\bcode\b/.test(m[1])) {
        offenders.push(`${name}: ${m[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `视图把 code 标识符拼进了 HTML（内部规则键会泄到界面上）：\n${offenders.join('\n')}`);
});

test('★ 静态闸：视图的模板字面量里不许出现任何内部码字面量（渲染层不许硬编码内部码）', () => {
  const offenders = [];
  for (const { name, path } of listViewFiles()) {
    const src = stripComments(readFileSync(path, 'utf8'));
    for (const tpl of templateLiterals(src)) {
      for (const code of CODES) {
        // 只认「被引号包起来的完整字面量」：避免把长词里的子串误判
        if (new RegExp(`(['"\`])${code}\\1`).test(tpl)) offenders.push(`${name}: ${code}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `视图把内部码写进了 HTML 模板（渲染层不许硬编码内部码）：\n${offenders.join('\n')}`);
});

test('★ 静态闸：视图里硬编码的内部码集合必须显式登记（前端抄后端判据 ⇒ 会漂）', () => {
  const offenders = [];
  for (const { name, path } of listViewFiles()) {
    const src = stripComments(readFileSync(path, 'utf8'));
    const hardcoded = CODES.filter((code) => new RegExp(`(['"\`])${code}\\1`).test(src));
    if (hardcoded.length < 3) continue;   // 单个码不算「抄了一份判据」
    const registered = DECLARED_EXCEPTIONS.some(
      (e) => e.view === name && e.scope === 'hardcoded-code-set',
    );
    if (!registered) {
      offenders.push(`${name}: ${hardcoded.join(', ')}（未在 DECLARED_EXCEPTIONS 登记）`);
    }
  }
  assert.deepEqual(offenders, [],
    `视图硬编码了内部码集合却没有显式登记（前端自己抄了一份后端判据 ⇒ 会漂）：\n${offenders.join('\n')}`);
});
```

⚠️ **变异检验 8/8 全杀**（脚本 `/tmp/mutation-e184.js`）：M1 榜页恢复渲染码 / M2 公开白名单放回 code /
M3 发榜页恢复码前缀 / M4 告警正文放回规则号 / M5 评审页放回维度键 / M6 评委池正文放回错误码 /
M7 缺格面板放回维度键 / M8 公开响应放回 code。
⚠️ **M5 首轮存活**（闸无判别力）⇒ 原因是**闸在测试里重写了一遍渲染拼接逻辑**，
生产代码改了闸不会红 ⇒ 假绿 ⇒ 改成调**生产路径的纯函数** `reviewErrorHint(errors, dims)`（已从 review.js 导出）
⇒ M5 被杀。**这条自曝是本轮最有价值的产出**：它证明「行为闸」也可能是假的，必须配变异检验。

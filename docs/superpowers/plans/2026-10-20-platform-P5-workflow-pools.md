# P5 工作流与三池 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「任务包 → 工作流 → 任务清单 → 队员自主领取任务完成」这条链路落成可运行的代码（R-OPS-13），并在**不提供岗位制**的前提下保证任务只能被自主领取（R-OPS-14）；在此之上建三池**底座**——项目池 / 人才池 / 资源池的派生同步与只读 API（R-POOL-01/02/03），以及增长飞轮闭环的最小可观测形态（R-POOL-04）；最后给出**无需登录**的公开榜单 API（token 鉴权 + 可见性过滤）与赛程 iCal 订阅，并配套个人积分终生上榜（R-RNK-10）。

**Architecture:** 延续 P0 的单进程零依赖架构。`src/domain/` 放纯函数（三池派生 / 任务完成证据校验 / iCal 生成，无 IO、无 `Date.now()`、无 `Math.random()`）；`src/services/` 放用例编排（workflow / pools / public-api）；所有 SQL 收在 `src/db/repo/`；`src/http/routes/` 挂 P5 的 9 条 API；`web/views/tasks.js` 是唯一的本阶段前端视图。**本阶段的灵魂是「一个派生值只有一个计算点、一条任务只有一个有效领取、一个公开接口只给该给的字段」**：三池同步是幂等重建（不是增量累加），任务领取靠数据库唯一约束兜底（不是应用层先查再插），公开接口显式过 `applyVisibility` 再做字段白名单投影（不是"默认给全量"）。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

> **上游依赖（执行前确认）**：本阶段消费 P0（基础设施 / `users` / `can()` / `audit_log`）、**P1**（`teams` / `team_members` / `task_packages` / `registrations`）、**P2**（`stage_results` / `stages`，**只读**）、**P3**（`points_ledger` / `tier_records` / `applyVisibility`）、**P4**（`src/db/tx.js` 的 `withTransaction`）与 **P0**（`src/errors.js` 的 `appError`，**status-first**）。
> ⚠️ `INTERFACES.md` §8 的依赖表写的是「P5 ← P0 + P1 + P3」，但 §6 的 `syncPoolProjects` 明确要求从 `stage_results` 派生，而 `stage_results` 是 **P2** 建的表 → **P5 额外只读 P2 的两张表**（见文末偏差章节 D-4）。
> 若 P1–P4 尚未落地，P5 的测试会以「找不到模块 / 缺表」失败——**这是依赖缺失，不是本阶段的 bug**。

## Global Constraints

（代码块，逐字复制 P0 约束块 + 本阶段追加）

```
运行时      Node ≥ 22.16.0（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
npm 依赖    0 个。package.json 只有 {"type":"module"}，不得新增 dependencies
数据库      node:sqlite。data/app.db，WAL 模式。单写者：禁止多 worker 写同一文件
测试        node:test。命令：node --test
密码        node:crypto scrypt，存储格式 scrypt$N$r$p$<salt_b64>$<hash_b64>，比对用 timingSafeEqual
会话        服务端 session 表，token 只存 SHA-256 哈希；Cookie HttpOnly + SameSite=Lax + Path=/
代码目录    platform/
规则配置    platform/rules/*.json，一切可变规则只改 JSON
配置校验    fail-fast：权重合计≠100% / 阈值不单调 / 段位门槛不递增 → 拒绝启动并报错
权限模型    capability + assignment；判定只有一个入口 can(user, capability, ctx)
三态状态码  列表不满足 → 200+空集；单条不满足 → 404；规则被禁用 → 403
SQL 边界    所有 SQL 收进 src/db/repo/；handler 内禁止裸 SQL
规则溯源    每条规则在代码注释里写明来源文档与章节
禁用清单    platform/scripts/forbidden.txt 不得为空
────────── 以下为 P5 追加 ──────────────────────────────────────────
三池只做底座 一期只做【数据模型 + 仓储 + 同步服务 + 只读 API】，⛔ 不做三池前台页面。
            依据：设计文档 §1.2「一期做三池底座（数据模型 + 读写接口）… ❌ 三池前台页面 ——
            一期做出来会是"空池无内容"的死界面」/ §5.4。
            理由：三池是报名、评审、里程碑这三块数据的自然沉淀物；先让源头跑通并可复算，
            三池的数据才有质量。倒过来先做前台 = 一个漂亮的空池。
派生值单一源 派生值（pool_talents.total_points 等）⛔ 不手工维护、不增量累加。
            【只有一个计算点】：src/domain/pool-derive.js 的纯函数。
            同一派生值绝不允许两处各算一次（那正是本项目"同一动作在两份材料里被标成一手与
            二手"的同构风险）。同步写库后必须用【同一个】纯函数重算比对，不一致即抛错。
同步=幂等重建 syncPool* 是【按派生源全量重算并覆盖】，⛔ 不是增量累加。
            连跑两次结果必须一致（有测试断言）。派生源表变了就重跑同步，不做增量修补。
任务≠里程碑 工作流任务（workflow_tasks）与里程碑（milestones）不共享表、不共享规则。
            里程碑 = 企业签字的客观事实（报名时固定、不可自行新增，S10 §3.4 / R-STG-03）；
            工作流任务 = 队内自主领取的工作项。
            同"两种企业签字必须分表"（设计文档 §5.3）的同构纪律。
禁止岗位制   ⛔ 本阶段【不提供】任何「按岗位 / 身份分配任务」的接口、函数或数据列。
            任务只能自主领取（R-OPS-14 / 任务书 §六 AI 原生组织红线：
            「严禁按岗位和身份分工」；探月黑客松因岗位制失败——忙的忙死、闲的闲死、
            最后一个人说了算）。
            这是【刻意的功能缺失】，不是遗漏 —— 代码注释里必须留 `// R-OPS-14：禁止岗位制，任务只能自主领取`。
唯一领取   同一 task_id 同时只能有一个有效领取（released_at IS NULL 的部分唯一索引）。
            ⛔ 不靠应用层"先查再插"——并发下会插出两个领取（设计文档 §6.4 同款纪律：
            「应用层的'先查再插'在并发下会插出两票」）。
公开接口   公开 API 同样必须过可见性过滤（applyVisibility）+ 公开字段白名单投影。
            ⛔ 公开接口是最容易泄露的地方：不允许"默认给全量"。
            D 段不公示排名 / B 榜评分与签字人不公开 / 企业名不公示 / 互评来源不公示。
公开令牌   public_tokens 存 SHA-256 十六进制（与 P0 的 sessions.token_hash 同一纪律），
            明文 token 只在签发时返回一次。无 token / 过期 / 跨届期 / scope 不符 → 一律 403。
iCal 零依赖 手写 RFC 5545：行折叠（每行 ≤75 octets）、逗号/分号/反斜杠转义、CRLF 行尾、
            UTC 时间戳 YYYYMMDDTHHMMSSZ。⛔ 不引第三方 ical 库（零依赖约束 R-OPS-07）。
            可借鉴 dribdat 的 iCal 思路（MIT），但【自己写】——它依赖 Django 生态。
```

## File Structure

**本阶段创建**

```
platform/
├── rules/
│   └── pools.json                   三池与工作流配置（packageStatusFilter / 积分口径 / 公开 scope / 证据要求 / claimMode）
├── db/migrations/
│   └── 006_pools.sql                workflows / workflow_tasks / task_claims / pool_projects / pool_talents / pool_resources / public_tokens
├── src/
│   ├── db/repo/
│   │   ├── workflows.js             workflows + workflow_tasks（工作流与任务清单）
│   │   ├── task-claims.js           task_claims（唯一约束在这一层被数据库兜住）
│   │   ├── teamMembers.js           **P1 已建**；hasActiveMembership / listMemberTeams **已由 Task 1 追加**（team_members 的唯一归属；P5 Task 2 不再追加，见台账 T2-1 C-1）
│   │   ├── pools.js                 pool_projects / pool_talents / pool_resources
│   │   ├── pool-sources.js          只读派生源：teams / stages / stage_results / tier_records / points_ledger / registrations / task_packages / users
│   │   └── public-tokens.js         public_tokens（签发 / 校验 / 吊销）
│   ├── domain/
│   │   ├── pool-derive.js           三池派生纯函数（projects / talents / resources + 个人积分聚合）
│   │   ├── evidence.js              任务完成证据校验纯函数（R-STG-04 的边界）
│   │   └── icalendar.js             iCal 文本生成纯函数（转义 / 折叠 / 时间戳）
│   ├── services/
│   │   ├── workflow.js               建工作流 / 建任务 / 列任务 / 领取 / 释放 / 完成
│   │   ├── pools.js                  syncPoolProjects / syncPoolTalents / syncPoolResources / listPool*
│   │   └── public-api.js             createPublicToken / resolvePublicToken / getPublicLeaderboard / buildICalendar
│   └── routes/
│       ├── workflow.js               任务清单 API（6 条）
│       ├── pools.js                  三池只读 API + 同步（4 条）
│       └── public.js                 公开榜单 + iCal（2 条）
├── web/views/
│   └── tasks.js                      任务清单页（可领取的 / 我领取的 / 已完成的）
└── test/
    ├── pools-migration.test.js       迁移 006 + 7 张表 + 部分唯一索引 + 三池唯一约束
    │                                 + 真并发用例（两连接同时 insert）+ 仓储层用例 + 约束矩阵用例（共 13 例）
    ├── workflow-service.test.js      领取唯一性 / 释放 / 完成证据 / 禁止岗位制 / 完成不加分
    ├── pools-sync.test.js            三池派生正确性 + 幂等（连跑两次一致）+ 积分唯一真源自检
    ├── public-api.test.js            token 鉴权 4 种失败 + 可见性过滤 + 公开字段白名单
    ├── icalendar.test.js             RFC 5545：VEVENT 数 / 折叠 / 转义 / CRLF / UTC 时间戳
    └── workflow-e2e.test.js          端到端：工作流 → 任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜单
```

**本阶段修改**

```
platform/src/config.js                加载并校验 rules/pools.json（新增 rules.pools 命名空间）
platform/src/server.js                挂载 src/http/routes/workflow.js + pools.js + public.js；响应支持原文输出（.ics）
platform/web/app.js                   注册 /tasks/:workflowId 路由 + 把路由参数透传给视图
```

> **不改动**：`src/http/respond.js`（原文响应走 `server.js` 里已有的 `text()`）、`scripts/seed.js`（`pool:read` / `pool:write` 两个能力点 P0 的种子已经有了，本阶段不新增能力点）、`package.json`（仍是零依赖）。
> **公开令牌的签发入口**：服务层 `createPublicToken`。⛔ 一期**不做**面向用户的自助签发接口——契约未列，且"谁能拿到公开令牌"必须受控（签发权属组委会）。

---

### Task 1: 工作流与三池数据模型与迁移 `006_pools.sql`

**Files:**
- Create: `platform/db/migrations/006_pools.sql`
- Create: `platform/src/db/repo/workflows.js`
- Create: `platform/src/db/repo/task-claims.js`
- Create: `platform/src/db/repo/pools.js`
- Create: `platform/src/db/repo/pool-sources.js`
- Create: `platform/src/db/repo/public-tokens.js`
- Test: `platform/test/pools-migration.test.js`

**Interfaces:**
- Consumes: P0 的 `users` 表；P1 的 `editions` / `task_packages` / `teams` / `team_members`；P2 的 `stages` / `stage_results`；P3 的 `points_ledger` / `tier_records`
- Produces（表结构与 `INTERFACES.md` §6 **逐字一致**，只多索引与 3 列）：
  - `workflows(id, edition_id, task_package_id, name, created_at)`
  - `workflow_tasks(id, workflow_id, title, detail, owner_team_id, status, due_at, created_at)` + **追加** `evidence_json` / `completed_at` / `completed_by`
  - `task_claims(id, task_id, team_id, user_id, claimed_at, released_at)`
  - `pool_projects(id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at)`
  - `pool_talents(id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at)`
  - `pool_resources(id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at)`
  - `public_tokens(token, scope, edition_id, expires_at, created_at)`
  - 仓储函数：`insertWorkflow` / `getWorkflow` / `listWorkflowsByEdition` / `insertWorkflowTask` / `getWorkflowTask` / `listWorkflowTasksByWorkflow` / `updateWorkflowTaskStatus` / `completeWorkflowTask` / `insertTaskClaim` / `getActiveClaim` / `releaseTaskClaim` / `countActiveClaims` / `hasActiveMembership` / `listMemberTeams` / `insertPoolProject` / `updatePoolProject` / `deletePoolProject` / `listPoolProjectRows` / `insertPoolTalent` / `updatePoolTalent` / `deletePoolTalent` / `listPoolTalentRows` / `insertPoolResource` / `updatePoolResource` / `deletePoolResource` / `listPoolResourceRows` / 派生源读取 / `insertPublicToken` / `findPublicToken` / `deletePublicToken`

> **⚠️ 本 Task 的灵魂（并发安全）**
> **「同一任务不能被两人同时领取」必须由数据库保证，不能由应用层保证。**
> 依据：设计文档 §6.4「加时陈述用独立表 + 唯一约束……**为什么用唯一约束而不是应用层判断**：一人一票必须由数据库保证。应用层的"先查再插"在并发下会插出两票」。
> → 落法：`CREATE UNIQUE INDEX ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL;`
> → **部分唯一索引**的好处：列清单与契约逐字一致（不新增 `status` 列），且"释放后可以再领"天然成立（释放 = 写 `released_at`，旧行退出索引，新行入索引）。

- [ ] **Step 1: 写失败的测试**

`platform/test/pools-migration.test.js`：

```javascript
// test/pools-migration.test.js —— P5 Task 1：迁移 006 + 工作流/三池仓储层
// 依据：INTERFACES.md §6（P5 产出）；设计文档 §5.4
// ⛔ 本 Task 的灵魂：「同一任务不能被两人同时领取」必须由**数据库**保证 ——
//    部分唯一索引 ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL。
//    ⛔ 不接受「应用层先查再插」作为并发保证 —— 下面「真并发」用例用两个
//    **独立连接 + 两个 worker 线程 + 屏障同步**同时插入，验证放行权在数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import * as workflowsRepo from '../src/db/repo/workflows.js';
import * as taskClaimsRepo from '../src/db/repo/task-claims.js';
import * as poolsRepo from '../src/db/repo/pools.js';
import * as poolSourcesRepo from '../src/db/repo/pool-sources.js';
import * as publicTokensRepo from '../src/db/repo/public-tokens.js';
import { hasActiveMembership, listMemberTeams } from '../src/db/repo/teamMembers.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5mig-'));
  const { db, close } = openDatabase({ dataDir });
  const result = applyMigrations(db, migrationsDir);
  return { db, close, dataDir, result };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

/**
 * 上游种子：P1 的 editions / task_packages / teams，P0 的 users。
 * ⚠️ task_packages.status = 'approved'、teams.status = 'active' 这两个取值
 *    若 P1 落地时用了不同的 CHECK 枚举，改这两处种子值即可（不涉及本阶段逻辑）。
 */
function seedBase(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_cap', '队长甲', '13900000011', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_other', '组员乙', '13900000012', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型',
      '能跑起来就行', 'A', 'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_cap',
      '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_cap', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_cap', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_1', 'u_other', 'member', '2026-10-01T00:00:00.000Z', NULL);
  `);
}

/**
 * 仓储层与派生源用的**多届期 / 多状态 / 含软删**种子。
 * ⚠️ 数据必须**判别性**：两个算法的结果不同时，用例才区分得开。
 *    例如 listEditionPackages 的 status 过滤，只有同时存在 approved 与 submitted
 *    两种包时，漏掉过滤条件才会被发现。
 */
function seedRepo(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000021', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_b', '乙', '13900000022', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_c', '丙', '13900000023', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_off', '停用丁', '13900000024', 'x', 'other', '学堂', 0, 0, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z'),
           ('ed_2', '第二届', '上海', '2027-10-01', '2027-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_ok', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑起来就行',
      'A', 'approved', 11, 'A', '试点承诺', '承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_wait', 'ed_1', 'ent_2', '某券商', '智能投顾', '风控缺失', '原型', '能跑', 'B', 'submitted',
      9, 'B', NULL, NULL, 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_free', 'ed_1', 'ent_3', NULL, '自由命题', '自主', '原型', '能跑', 'C', 'approved',
      8, 'C', NULL, NULL, 1, 'u_b', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_gone', 'ed_1', 'ent_4', '某已撤企业', '已撤题', 'x', 'x', 'x', NULL, 'approved',
      NULL, NULL, NULL, NULL, 0, 'u_a', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_ok', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_c', 'tp_wait', 'D', 'active', '2026-10-02T00:00:00.000Z', NULL),
           ('tm_gone', 'ed_1', '已撤队', 'u_a', 'tp_ok', 'D', 'active', '2026-10-03T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z'),
           ('tm_9', 'ed_2', '九队', 'u_b', 'tp_ok', 'B', 'active', '2026-10-05T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_1', 'u_b', 'member', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'u_c', 'captain', '2026-10-02T00:00:00.000Z', NULL),
           ('tm_9', 'u_a', 'member', '2026-10-05T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '决赛', 'final', '2026-10-11', '2026-10-20', NULL, 'final', 'computed'),
           ('st_9', 'ed_2', 's1', '调研二', 'initial', '2027-10-01', '2027-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90, 45, 45, 0, 10, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80, 40, 40, 0, 6, '2026-10-10T00:00:00.000Z'),
           ('sr_3', 'st_2', 'tm_1', 1, 95, 48, 47, 0, 12, '2026-10-20T00:00:00.000Z'),
           ('sr_9', 'st_9', 'tm_9', 1, 70, 35, 35, 0, 4, '2027-10-10T00:00:00.000Z');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z'),
           ('pl_2', 'ed_1', 'st_1', 'tm_1', 'u_b', 'stage_rank', 6, '2026-10-10T00:00:00.000Z'),
           ('pl_3', 'ed_1', 'st_2', 'tm_1', 'u_b', 'mvp', 4, '2026-10-20T00:00:00.000Z'),
           ('pl_9', 'ed_2', 'st_9', 'tm_9', 'u_a', 'stage_rank', 4, '2027-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 1, 0, '[]', '2026-10-10T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-10T00:00:00.000Z', NULL),
           ('tr_9', 'tm_9', 'B', 2, 1, '[]', '2027-10-10T00:00:00.000Z', NULL);
    INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json, raw_score, level, created_at, deleted_at)
    VALUES ('rg_1', 'ed_1', 'u_a', '{}', '{"a":1}', 3.5, 'L2', '2026-10-01T00:00:00.000Z', NULL),
           ('rg_9', 'ed_2', 'u_b', '{}', '{"a":2}', 4.0, 'L3', '2026-10-01T00:00:00.000Z', NULL);
  `);
}

test('迁移到 006：七张表全部建出', () => {
  const { db, close, dataDir, result } = setup();
  assert.equal(result.version, 6, '迁移版本必须是 6（P0=1, P1=2, P2=3, P3=4, P4=5, P5=6）');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['workflows', 'workflow_tasks', 'task_claims', 'pool_projects', 'pool_talents', 'pool_resources', 'public_tokens']) {
    assert.ok(names.includes(t), `缺表 ${t}`);
  }
  cleanup(db, close, dataDir);
});

test('task_claims 的部分唯一索引挡住重复有效领取（并发的最后一道防线）', () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  db.prepare('INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?,?,?,?,?)')
    .run('wf_1', 'ed_1', 'tp_1', '风控助手工作流', '2026-10-02T00:00:00.000Z');
  db.prepare('INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('tk_1', 'wf_1', '跑通风控模型', '需要一个可演示的 demo', 'tm_1', 'todo', null, '2026-10-02T00:00:00.000Z');

  const ins = db.prepare(
    'INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES (?,?,?,?,?,NULL)',
  );
  ins.run('tc_1', 'tk_1', 'tm_1', 'u_cap', '2026-10-03T00:00:00.000Z');

  // ⛔ 绕过应用层"先查再插"，直接插第二条 → 数据库必须拒绝
  assert.throws(
    () => ins.run('tc_2', 'tk_1', 'tm_1', 'u_other', '2026-10-03T00:00:01.000Z'),
    /UNIQUE constraint failed/,
    '同一 task_id 不能有两个有效领取',
  );

  // 释放后旧行退出索引 → 可以再领
  db.prepare('UPDATE task_claims SET released_at = ? WHERE id = ?').run('2026-10-03T01:00:00.000Z', 'tc_1');
  ins.run('tc_3', 'tk_1', 'tm_1', 'u_other', '2026-10-03T02:00:00.000Z');

  const n = db
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get('tk_1').n;
  assert.equal(n, 1, '有效领取永远只有一条');
  cleanup(db, close, dataDir);
});

test('workflow_tasks 的 status 只允许四种取值', () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  db.prepare('INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?,?,?,?,?)')
    .run('wf_1', 'ed_1', 'tp_1', '风控助手工作流', '2026-10-02T00:00:00.000Z');
  const ins = db.prepare(
    'INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  ins.run('tk_1', 'wf_1', '任务一', null, 'tm_1', 'todo', null, '2026-10-02T00:00:00.000Z');
  ins.run('tk_2', 'wf_1', '任务二', null, 'tm_1', 'in_progress', null, '2026-10-02T00:00:00.000Z');
  ins.run('tk_3', 'wf_1', '任务三', null, 'tm_1', 'done', null, '2026-10-02T00:00:00.000Z');
  ins.run('tk_4', 'wf_1', '任务四', null, 'tm_1', 'blocked', null, '2026-10-02T00:00:00.000Z');
  assert.throws(
    () => ins.run('tk_5', 'wf_1', '任务五', null, 'tm_1', 'assigned_to_dev', null, '2026-10-02T00:00:00.000Z'),
    /CHECK constraint failed|constraint/i,
    '非法状态必须被数据库拒绝',
  );
  cleanup(db, close, dataDir);
});

test('三池表的自然键唯一约束生效', () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  const insProject = db.prepare(
    `INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insProject.run('pp_1', 'ed_1', 'tm_1', '零售风控助手', null, 'S3', 'C', 1, '摘要', '2026-10-05T00:00:00.000Z');
  assert.throws(
    () => insProject.run('pp_2', 'ed_1', 'tm_1', '重复队', null, null, null, null, null, '2026-10-05T00:00:00.000Z'),
    /UNIQUE constraint failed/,
    '同一届同一队只能有一条项目池记录',
  );

  const insTalent = db.prepare(
    `INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insTalent.run('pt_1', 'u_cap', 'ed_1', '队长甲', '学堂', 18, 'mba', 3, '[]', '2026-10-05T00:00:00.000Z');
  assert.throws(
    () => insTalent.run('pt_2', 'u_cap', 'ed_1', '队长甲', '学堂', 20, 'mba', 3, '[]', '2026-10-05T00:00:00.000Z'),
    /UNIQUE constraint failed/,
    '同一届同一人只能有一条人才池记录',
  );

  const insResource = db.prepare(
    `INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  insResource.run('pr_1', 'ed_1', 'ent_1', '某银行', 'enterprise_brief', '零售风控助手', '2026-10-05T00:00:00.000Z');
  assert.throws(
    () => insResource.run('pr_2', 'ed_1', 'ent_1', '某银行', 'enterprise_brief', '重复', '2026-10-05T00:00:00.000Z'),
    /UNIQUE constraint failed/,
    '同一届同一企业的同一类资源只能有一条',
  );
  cleanup(db, close, dataDir);
});

test('public_tokens 表可存可查，且 token 是主键', () => {
  const { db, close, dataDir } = setup();
  db.prepare('INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run('hash_abc', 'leaderboard', 'ed_1', '2026-11-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
  const row = db.prepare('SELECT * FROM public_tokens WHERE token = ?').get('hash_abc');
  assert.equal(row.scope, 'leaderboard');
  assert.equal(row.edition_id, 'ed_1');
  assert.throws(
    () => db.prepare('INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (?,?,?,?,?)')
      .run('hash_abc', 'calendar', 'ed_1', '2026-11-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
    /UNIQUE constraint failed/,
  );
  cleanup(db, close, dataDir);
});

/**
 * ★ 真并发用例（本 Task 灵魂的正面验证）。
 *
 * 为什么不能只串行跑一次：串行跑两次 insert，第一次提交后第二次必然撞唯一索引 ——
 * 这证明不了「并发下数据库会仲裁」，只证明「索引存在」。
 * 本用例用**两个 worker 线程 + 两条独立数据库连接 + 屏障同步**，
 * 让两次 INSERT **真正同时**发起（用插入起止时间区间是否重叠来证明确实重叠），
 * 然后断言：**恰好一条成功，另一条被数据库以 UNIQUE 约束拒绝**，
 * 且库里的有效领取永远只有一条。
 *
 * ⚠️ 屏障必须**两个 worker 都到达**才放行：worker 在连上库之后、
 *    真正发起 INSERT 之前才递增屏障计数 —— 因此「同时」的是 INSERT 本身，
 *    不是连接建立。
 * ⚠️ 两个连接必须**错开建立**：这是本 Task 落地时（2026-10-21）的**临时变通** ——
 *    当时 openDatabase() 的第一条语句是 PRAGMA journal_mode = WAL，而 busy_timeout 在它之后才设，
 *    两个连接同时执行这条 PRAGMA 会有一方立刻 "database is locked"（实测，见缺陷台账 **C-3**）。
 *    ⚠️ **该缺陷已在上游修掉**（main `a6fd2db`：切 WAL 改成带退避重试，不再裸执行该 PRAGMA），
 *    所以这个「错开建立」**已不再必要** —— 保留它只是为了让本用例专注于「并发领取」的仲裁语义。
 */
const CLAIM_WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from ${JSON.stringify(pathToFileURL(join(here, '..', 'src', 'db', 'sqlite.js')).href)};

const { db, close } = openDatabase({ dataDir: workerData.dataDir });
const ins = db.prepare(
  'INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)',
);

/**
 * 共享屏障（Int32Array，三个槽位）：
 *   [0] 已建立连接的 worker 数
 *   [1] holder 已持有写锁并完成 INSERT
 *   [2] waiter 已准备发起 INSERT（此刻它必然阻塞在写锁上）
 */
const barrier = new Int32Array(workerData.barrier);

/** 等某个槽位变成 want；超时返回 false（用于把「卡住」变成可诊断的失败而不是挂死）。 */
function waitUntil(idx, want, timeoutMs) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
  for (;;) {
    if (Atomics.load(barrier, idx) === want) return true;
    if (process.hrtime.bigint() > deadline) return false;
    Atomics.wait(barrier, idx, Atomics.load(barrier, idx), 5);
  }
}

parentPort.postMessage({ ready: true });
Atomics.add(barrier, 0, 1);
if (!waitUntil(0, 2, 10000)) {
  parentPort.postMessage({ ok: false, message: '屏障超时：两个连接未能在 10s 内就绪', t0: 0, t1: 0 });
  close();
} else {
  let outcome;
  const t0 = Number(process.hrtime.bigint());
  try {
    if (workerData.role === 'holder') {
      // holder：取写锁 → 插入 → 告诉 waiter「我持锁了」→ 等 waiter 准备发起 INSERT → 才提交
      db.exec('BEGIN IMMEDIATE');
      try {
        ins.run(workerData.claimId, workerData.taskId, workerData.teamId, workerData.userId, workerData.claimedAt);
        Atomics.store(barrier, 1, 1);
        waitUntil(2, 1, 10000);
        db.exec('COMMIT');
        outcome = { ok: true };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
        outcome = { ok: false, message: String(err && err.message) };
      }
    } else {
      // waiter：等 holder 持锁 → 宣告「我要发起了」（下一个语句必然阻塞在写锁上）→ 发起 INSERT
      waitUntil(1, 1, 10000);
      Atomics.store(barrier, 2, 1);
      ins.run(workerData.claimId, workerData.taskId, workerData.teamId, workerData.userId, workerData.claimedAt);
      outcome = { ok: true };
    }
  } catch (err) {
    outcome = { ok: false, message: String(err && err.message) };
  }
  const t1 = Number(process.hrtime.bigint());
  close();
  parentPort.postMessage({ ...outcome, t0, t1 });
}
`;

function spawnClaimWorker(workerData) {
  const worker = new Worker(CLAIM_WORKER_SRC, { eval: true, workerData });
  let resolveReady;
  let resolveDone;
  const ready = new Promise((r) => { resolveReady = r; });
  const done = new Promise((r) => { resolveDone = r; });
  worker.on('message', (m) => { if (m.ready) resolveReady(); else resolveDone(m); });
  worker.on('error', (err) => { resolveReady(); resolveDone({ ok: false, message: String(err && err.message) }); });
  return { ready, done };
}

test('真并发：两个连接同时领取同一任务，数据库只放行一个（放行权在数据库，不在应用层）', async () => {
  const { db, close, dataDir } = setup();
  seedBase(db);
  db.prepare('INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?,?,?,?,?)')
    .run('wf_1', 'ed_1', 'tp_1', '风控助手工作流', '2026-10-02T00:00:00.000Z');
  db.prepare('INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('tk_1', 'wf_1', '跑通风控模型', '需要一个可演示的 demo', 'tm_1', 'todo', null, '2026-10-02T00:00:00.000Z');
  // 先把主连接关掉：下面的并发由 worker 自己持有的两条连接完成
  close();

  // 三个 Int32 槽位：[0] 已连接数 / [1] holder 持锁 / [2] waiter 准备发起 INSERT
  const barrier = new SharedArrayBuffer(12);
  const base = { dataDir, barrier, taskId: 'tk_1', teamId: 'tm_1', claimedAt: '2026-10-03T00:00:00.000Z' };
  const a = spawnClaimWorker({ ...base, role: 'holder', claimId: 'tc_a', userId: 'u_cap' });
  await a.ready;                       // 连接 A 已建立
  const b = spawnClaimWorker({ ...base, role: 'waiter', claimId: 'tc_b', userId: 'u_other' });
  await b.ready;                       // 连接 B 已建立（错开建立，避开 WAL PRAGMA 抢锁）
  const [ra, rb] = await Promise.all([a.done, b.done]);

  const winners = [ra, rb].filter((r) => r.ok);
  const losers = [ra, rb].filter((r) => !r.ok);
  assert.equal(winners.length, 1, `恰好一条领取成功，实际 ${JSON.stringify([ra, rb])}`);
  assert.equal(losers.length, 1, `恰好一条被拒，实际 ${JSON.stringify([ra, rb])}`);
  assert.match(losers[0].message, /UNIQUE constraint failed/, '被拒的一方必须由数据库的唯一索引拒绝');

  // 证明这**确实是并发**而不是被测试串行化：两次 INSERT 的时间区间必须**真正重叠**。
  //
  // ⚠️⚠️ 谓词**不能**写成 `min(t0) < max(t1)`：
  //   ① 那个写法在「A 完全在 B 之前」（串行）时也成立 ⇒ 会把**根本不是并发**的两次 INSERT 放过；
  //   ② 而时间戳若截断到**毫秒**，两次 INSERT 全程落在同一毫秒时会得到 `min == max`
  //      ⇒ 把**真并发**判成不并发（本机实测约 20% 概率偶发失败，见台账 PC-1）。
  //  ⇒ 正确写法：时间戳保留**纳秒**（process.hrtime.bigint() 是 CLOCK_MONOTONIC，
  //    同一进程内的多个 worker 线程**基点相同** ⇒ 可直接跨线程比较），
  //    谓词用**区间真实重叠** `a0 < b1 && b0 < a1`。
  //
  // ⚠️ 仅有高精度时间戳**还不够**：两个 worker 从屏障放行到真正跑起来之间有**唤醒延迟**
  //    （实测可达数毫秒）⇒ 两次 INSERT 可能**整体错开**、根本不重叠。
  //    ⇒ 上面 worker 用**共享标志位**把顺序**结构化**：
  //      holder 取写锁并插入 → 置标志 [1] → 等标志 [2] → 才提交；
  //      waiter 等标志 [1] → 置标志 [2] → 才发起 INSERT（此刻必然阻塞在 holder 的写锁上）。
  //    于是必然有 holder.t0 < waiter.t0 < holder.t1 且 waiter.t1 > holder.t1 ⇒ **重叠恒成立**。
  const overlap = ra.t0 < rb.t1 && rb.t0 < ra.t1;
  assert.ok(
    overlap,
    `两次 INSERT 的区间必须重叠才叫并发，实际 [${ra.t0},${ra.t1}] 与 [${rb.t0},${rb.t1}]`,
  );

  // 库里的有效领取永远只有一条
  const { db: db2, close: close2 } = openDatabase({ dataDir });
  const n = db2
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get('tk_1').n;
  assert.equal(n, 1, '有效领取永远只有一条');
  close2();
  rmSync(dataDir, { recursive: true, force: true });
});

test('workflows / workflow_tasks 仓储：建档、读档、改状态、完成留痕', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  const wf = workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_ok', name: '风控助手工作流', now: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(wf.id !== undefined, true);
  assert.equal(wf.edition_id, 'ed_1');
  assert.equal(wf.task_package_id, 'tp_ok');
  assert.equal(wf.name, '风控助手工作流');
  assert.equal(workflowsRepo.getWorkflow(db, wf.id).name, '风控助手工作流');
  assert.equal(workflowsRepo.getWorkflow(db, 'wf_none'), null, '不存在的 id 必须返回 null 而不是 undefined');

  const wf2 = workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_wait', name: '投顾工作流', now: '2026-10-03T00:00:00.000Z',
  });
  // 同一个任务包的**第二个**工作流（created_at 更晚）—— 用来判别 findWorkflowByPackage
  // 取的是「最早的那个」：只有一个工作流时排序不可判别。
  workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_ok', name: '风控助手工作流二', now: '2026-10-06T00:00:00.000Z',
  });
  workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_2', taskPackageId: 'tp_ok', name: '第二届工作流', now: '2026-10-01T00:00:00.000Z',
  });
  const listed = workflowsRepo.listWorkflowsByEdition(db, 'ed_1');
  assert.deepEqual(
    listed.map((r) => r.name),
    ['风控助手工作流', '投顾工作流', '风控助手工作流二'],
    '必须只返回本届且按 created_at 升序',
  );
  assert.equal(workflowsRepo.findWorkflowByPackage(db, 'ed_1', 'tp_ok').id, wf.id, '同一任务包取最早建立的工作流');
  assert.equal(workflowsRepo.findWorkflowByPackage(db, 'ed_1', 'tp_free'), null, '找不到时返回 null');

  // 任务默认值：detail / owner_team_id / due_at 为 NULL，status 为 'todo'
  const task = workflowsRepo.insertWorkflowTask(db, {
    workflowId: wf.id, title: '跑通风控模型', now: '2026-10-04T00:00:00.000Z',
  });
  assert.equal(task.status, 'todo');
  assert.equal(task.detail, null);
  assert.equal(task.owner_team_id, null);
  assert.equal(task.due_at, null);
  assert.equal(task.evidence_json, null);
  assert.equal(task.completed_at, null);
  assert.equal(task.completed_by, null);

  workflowsRepo.insertWorkflowTask(db, {
    workflowId: wf.id, title: '任务二', detail: '细节', ownerTeamId: 'tm_1', status: 'in_progress',
    dueAt: '2026-10-20', now: '2026-10-05T00:00:00.000Z',
  });
  workflowsRepo.insertWorkflowTask(db, {
    workflowId: wf2.id, title: '另一工作流的任务', now: '2026-10-04T00:00:00.000Z',
  });
  const tasks = workflowsRepo.listWorkflowTasksByWorkflow(db, wf.id);
  assert.deepEqual(tasks.map((r) => r.title), ['跑通风控模型', '任务二'], '只返回本工作流的任务且按 created_at 升序');
  assert.equal(workflowsRepo.getWorkflowTask(db, task.id).title, '跑通风控模型');

  assert.equal(workflowsRepo.updateWorkflowTaskStatus(db, task.id, 'in_progress'), 1);
  assert.equal(workflowsRepo.getWorkflowTask(db, task.id).status, 'in_progress');
  assert.equal(workflowsRepo.updateWorkflowTaskStatus(db, 'tk_none', 'done'), 0, '改不存在的任务返回 0');

  // 完成留痕：状态 + 证据 + 完成时间 + 完成人
  assert.equal(workflowsRepo.completeWorkflowTask(db, task.id, {
    status: 'done', evidenceJson: '{"repo":"https://example.com/x","version":"v1"}',
    completedAt: '2026-10-06T00:00:00.000Z', completedBy: 'u_a',
  }), 1);
  const done = workflowsRepo.getWorkflowTask(db, task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.evidence_json, '{"repo":"https://example.com/x","version":"v1"}');
  assert.equal(done.completed_at, '2026-10-06T00:00:00.000Z');
  assert.equal(done.completed_by, 'u_a');
  cleanup(db, close, dataDir);
});

test('task-claims 仓储：有效领取、释放后退出索引、可再领、重复领取被数据库拒绝', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);
  workflowsRepo.insertWorkflow(db, {
    editionId: 'ed_1', taskPackageId: 'tp_ok', name: '风控助手工作流', now: '2026-10-02T00:00:00.000Z',
  });
  const task = workflowsRepo.insertWorkflowTask(db, {
    workflowId: db.prepare('SELECT id FROM workflows LIMIT 1').get().id,
    title: '跑通风控模型', now: '2026-10-04T00:00:00.000Z',
  });
  const task2 = workflowsRepo.insertWorkflowTask(db, {
    workflowId: db.prepare('SELECT id FROM workflows LIMIT 1').get().id,
    title: '第二个任务', now: '2026-10-04T01:00:00.000Z',
  });

  const claim = taskClaimsRepo.insertTaskClaim(db, {
    taskId: task.id, teamId: 'tm_1', userId: 'u_a', now: '2026-10-03T00:00:00.000Z',
  });
  assert.equal(claim.task_id, task.id);
  assert.equal(claim.user_id, 'u_a');
  assert.equal(claim.released_at, null);
  assert.equal(taskClaimsRepo.getActiveClaim(db, task.id).id, claim.id);
  assert.equal(taskClaimsRepo.countActiveClaims(db, task.id), 1);

  // 已被占用时再领 → 数据库拒绝（不是应用层判断）
  assert.throws(
    () => taskClaimsRepo.insertTaskClaim(db, {
      taskId: task.id, teamId: 'tm_1', userId: 'u_b', now: '2026-10-03T00:00:01.000Z',
    }),
    /UNIQUE constraint failed/,
  );

  // 释放：第一次改 1 行，第二次（已释放）改 0 行
  assert.equal(taskClaimsRepo.releaseTaskClaim(db, claim.id, '2026-10-03T01:00:00.000Z'), 1);
  assert.equal(taskClaimsRepo.releaseTaskClaim(db, claim.id, '2026-10-03T02:00:00.000Z'), 0, '已释放的不能再改');
  assert.equal(taskClaimsRepo.getActiveClaim(db, task.id), null, '释放后没有有效领取');
  assert.equal(taskClaimsRepo.countActiveClaims(db, task.id), 0);

  // 释放后可以再领
  const again = taskClaimsRepo.insertTaskClaim(db, {
    taskId: task.id, teamId: 'tm_1', userId: 'u_b', now: '2026-10-03T03:00:00.000Z',
  });
  assert.equal(again.user_id, 'u_b');
  assert.equal(taskClaimsRepo.countActiveClaims(db, task.id), 1);

  // u_a 的第二笔领取 —— 用来判别 listClaimsByUser 的排序（只有一笔时排序不可判别）
  const claim2 = taskClaimsRepo.insertTaskClaim(db, {
    taskId: task2.id, teamId: 'tm_1', userId: 'u_a', now: '2026-10-03T04:00:00.000Z',
  });

  const byUser = taskClaimsRepo.listClaimsByUser(db, 'u_a');
  assert.deepEqual(byUser.map((r) => r.id), [claim.id, claim2.id], '按 claimed_at 升序列出该人的全部领取（含已释放的）');
  assert.equal(taskClaimsRepo.listClaimsByUser(db, 'u_nobody').length, 0);
  cleanup(db, close, dataDir);
});

test('teamMembers 追加的两个函数：只认「这个人是不是这支队的在队成员」', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  assert.equal(hasActiveMembership(db, 'tm_1', 'u_a'), true, 'u_a 是 tm_1 的在队队长');
  assert.equal(hasActiveMembership(db, 'tm_1', 'u_b'), true, 'u_b 是 tm_1 的在队成员');
  assert.equal(hasActiveMembership(db, 'tm_1', 'u_c'), false, 'u_c 不是 tm_1 的成员');
  assert.equal(hasActiveMembership(db, 'tm_9', 'u_a'), false, 'u_a 已从 tm_9 离队（left_at 非空）');

  const teams = listMemberTeams(db, 'u_a');
  assert.deepEqual(teams.map((r) => r.id), ['tm_1'], '已离队的 tm_9 不算在队');
  assert.deepEqual(listMemberTeams(db, 'u_a', { editionId: 'ed_1' }).map((r) => r.id), ['tm_1']);
  assert.deepEqual(listMemberTeams(db, 'u_a', { editionId: 'ed_2' }).map((r) => r.id), [], 'tm_9 已离队，不算 ed_2 的在队队');
  assert.deepEqual(listMemberTeams(db, 'u_c').map((r) => r.id), ['tm_2']);
  cleanup(db, close, dataDir);
});

test('三池仓储：写、覆盖、删、按届期读，且人才池按积分倒序', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  // 项目池
  const ppId = poolsRepo.insertPoolProject(db, {
    editionId: 'ed_1', teamId: 'tm_1', title: '零售风控助手', stageReached: 'S3', tier: 'C',
    businessValue: 1, summary: '摘要', now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolProject(db, {
    editionId: 'ed_1', teamId: 'tm_2', title: '智能投顾', now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolProject(db, {
    editionId: 'ed_2', teamId: 'tm_9', title: '第二届项目', now: '2026-10-05T00:00:00.000Z',
  });
  assert.equal(poolsRepo.listPoolProjectRows(db, 'ed_1').length, 2, '按届期过滤');
  assert.equal(poolsRepo.listPoolProjectRows(db).length, 3, '不传届期返回全部');
  assert.deepEqual(poolsRepo.listPoolProjectRows(db, 'ed_1').map((r) => r.team_id), ['tm_1', 'tm_2']);
  assert.equal(poolsRepo.updatePoolProject(db, ppId, {
    title: '零售风控助手 v2', industry: '金融', stageReached: 'S4', tier: 'B', businessValue: 2, summary: '新摘要',
  }), 1);
  const pp = poolsRepo.listPoolProjectRows(db, 'ed_1')[0];
  assert.equal(pp.title, '零售风控助手 v2');
  assert.equal(pp.industry, '金融');
  assert.equal(pp.stage_reached, 'S4');
  assert.equal(pp.tier, 'B');
  assert.equal(pp.business_value, 2);
  assert.equal(pp.summary, '新摘要');
  assert.equal(poolsRepo.deletePoolProject(db, ppId), 1);
  assert.equal(poolsRepo.deletePoolProject(db, ppId), 0, '删不存在的返回 0');
  assert.equal(poolsRepo.listPoolProjectRows(db, 'ed_1').length, 1);

  // 人才池（积分顺序与 user_id 顺序**故意相反** → 排序可判别）
  poolsRepo.insertPoolTalent(db, {
    editionId: 'ed_1', userId: 'u_a', name: '甲', org: '学堂', totalPoints: 5, mbaStatus: 'mba',
    stagesJoined: 3, now: '2026-10-05T00:00:00.000Z',
  });
  const ptId = poolsRepo.insertPoolTalent(db, {
    editionId: 'ed_1', userId: 'u_b', name: '乙', org: '学堂', totalPoints: 18, now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolTalent(db, {
    editionId: 'ed_2', userId: 'u_c', name: '丙', totalPoints: 99, now: '2026-10-05T00:00:00.000Z',
  });
  const talents = poolsRepo.listPoolTalentRows(db, 'ed_1');
  assert.deepEqual(talents.map((r) => r.user_id), ['u_b', 'u_a'], '人才池按 total_points 倒序（不是按 user_id）');
  // 不传届期：先按 edition_id 分组，组内再按 total_points 倒序
  assert.deepEqual(poolsRepo.listPoolTalentRows(db).map((r) => r.user_id), ['u_b', 'u_a', 'u_c']);
  assert.equal(poolsRepo.updatePoolTalent(db, ptId, {
    name: '乙改', org: '新学堂', totalPoints: 7, mbaStatus: 'member', stagesJoined: 2, skillsJson: '["风控"]',
  }), 1);
  const pt = poolsRepo.listPoolTalentRows(db, 'ed_1').find((r) => r.id === ptId);
  assert.equal(pt.name, '乙改');
  assert.equal(pt.org, '新学堂');
  assert.equal(pt.total_points, 7);
  assert.equal(pt.mba_status, 'member');
  assert.equal(pt.stages_joined, 2);
  assert.equal(pt.skills_json, '["风控"]');
  assert.equal(poolsRepo.deletePoolTalent(db, ptId), 1);
  assert.equal(poolsRepo.listPoolTalentRows(db, 'ed_1').length, 1);

  // 资源池
  const prId = poolsRepo.insertPoolResource(db, {
    editionId: 'ed_1', enterpriseId: 'ent_1', enterpriseName: '某银行', kind: 'enterprise_brief',
    detail: '零售风控助手', now: '2026-10-05T00:00:00.000Z',
  });
  poolsRepo.insertPoolResource(db, {
    editionId: 'ed_1', enterpriseId: 'ent_2', enterpriseName: '某券商', kind: 'free_brief',
    now: '2026-10-05T00:00:00.000Z',
  });
  assert.equal(poolsRepo.listPoolResourceRows(db, 'ed_1').length, 2);
  assert.deepEqual(poolsRepo.listPoolResourceRows(db, 'ed_1').map((r) => r.enterprise_id), ['ent_1', 'ent_2']);
  assert.equal(poolsRepo.updatePoolResource(db, prId, {
    enterpriseName: '某银行科技部', kind: 'enterprise_brief', detail: '新详情',
  }), 1);
  const pr = poolsRepo.listPoolResourceRows(db, 'ed_1')[0];
  assert.equal(pr.enterprise_name, '某银行科技部');
  assert.equal(pr.detail, '新详情');
  assert.equal(poolsRepo.deletePoolResource(db, prId), 1);
  assert.equal(poolsRepo.listPoolResourceRows(db, 'ed_1').length, 1);
  cleanup(db, close, dataDir);
});

test('pool-sources 只读派生源：按届期过滤、软删过滤、status 过滤、跨届期积分', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  assert.equal(poolSourcesRepo.getEdition(db, 'ed_1').name, '第一届');
  assert.equal(poolSourcesRepo.getEdition(db, 'ed_none'), null);

  // 软删的队不算
  assert.deepEqual(poolSourcesRepo.listEditionTeams(db, 'ed_1').map((r) => r.id), ['tm_1', 'tm_2']);

  // 软删的题不算；status 过滤要真的起作用（种子同时有 approved 与 submitted）
  const allPkgs = poolSourcesRepo.listEditionPackages(db, 'ed_1');
  assert.deepEqual(allPkgs.map((r) => r.id), ['tp_free', 'tp_ok', 'tp_wait'], '软删的 tp_gone 被过滤');
  const approved = poolSourcesRepo.listEditionPackages(db, 'ed_1', { statuses: ['approved'] });
  assert.deepEqual(approved.map((r) => r.id), ['tp_free', 'tp_ok'], '只留 approved');
  const two = poolSourcesRepo.listEditionPackages(db, 'ed_1', { statuses: ['approved', 'submitted'] });
  assert.deepEqual(two.map((r) => r.id), ['tp_free', 'tp_ok', 'tp_wait']);

  // stages."key" 是带引号的标识符 → 必须映射成 stage_key
  const stages = poolSourcesRepo.listEditionStages(db, 'ed_1');
  assert.deepEqual(stages.map((r) => r.stage_key), ['s1', 's2']);
  assert.equal(stages[0].stage_key, 's1');

  // stage_results 通过 stages 关联到届期：ed_2 的结果不混进来
  const results = poolSourcesRepo.listEditionStageResults(db, 'ed_1');
  assert.deepEqual(results.map((r) => r.team_id), ['tm_1', 'tm_2', 'tm_1']);
  const withTeams = poolSourcesRepo.listStageResultsWithTeams(db, 'st_1');
  assert.deepEqual(withTeams.map((r) => r.team_name), ['一队', '二队']);

  // tier_records 没有 edition_id → 通过 teams 关联
  assert.deepEqual(poolSourcesRepo.listEditionTierRecords(db, 'ed_1').map((r) => r.team_id), ['tm_1', 'tm_2']);

  // 积分流水按届期；个人积分跨届期累加（R-RNK-10）
  assert.equal(poolSourcesRepo.listEditionLedger(db, 'ed_1').length, 3);
  assert.equal(poolSourcesRepo.listUserLedger(db, 'u_a').length, 2, 'u_a 的积分跨两届');
  assert.deepEqual(poolSourcesRepo.listUserLedger(db, 'u_a').map((r) => r.edition_id), ['ed_1', 'ed_2']);

  // 本届有积分流水的人 / 全部在册用户
  assert.deepEqual(poolSourcesRepo.listEditionUsers(db, 'ed_1').map((r) => r.id), ['u_a', 'u_b']);
  assert.deepEqual(poolSourcesRepo.listAllUsers(db).map((r) => r.id), ['u_a', 'u_b', 'u_c'], '停用用户不算在册');

  // 报名
  assert.deepEqual(poolSourcesRepo.listEditionRegistrations(db, 'ed_1').map((r) => r.id), ['rg_1']);
  cleanup(db, close, dataDir);
});

test('public-tokens 仓储：签发、查、吊销、按届期列', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  const issued = publicTokensRepo.insertPublicToken(db, {
    token: 'hash_a', scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2026-11-01T00:00:00.000Z',
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.deepEqual(issued, {
    token: 'hash_a', scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2026-11-01T00:00:00.000Z',
  });
  publicTokensRepo.insertPublicToken(db, {
    token: 'hash_b', scope: 'calendar', editionId: 'ed_2', expiresAt: '2026-11-01T00:00:00.000Z',
    now: '2026-10-21T00:00:00.000Z',
  });

  const found = publicTokensRepo.findPublicToken(db, 'hash_a');
  assert.equal(found.scope, 'leaderboard');
  assert.equal(found.edition_id, 'ed_1');
  assert.equal(found.created_at, '2026-10-20T00:00:00.000Z');
  assert.equal(publicTokensRepo.findPublicToken(db, 'hash_none'), null);

  assert.deepEqual(publicTokensRepo.listPublicTokens(db).map((r) => r.token), ['hash_a', 'hash_b']);
  assert.deepEqual(publicTokensRepo.listPublicTokens(db, { editionId: 'ed_1' }).map((r) => r.token), ['hash_a']);

  assert.equal(publicTokensRepo.deletePublicToken(db, 'hash_a'), 1);
  assert.equal(publicTokensRepo.deletePublicToken(db, 'hash_a'), 0, '删不存在的返回 0');
  assert.equal(publicTokensRepo.findPublicToken(db, 'hash_a'), null);
  cleanup(db, close, dataDir);
});

test('必填列与外键真的由数据库挡住（不是应用层自觉）', () => {
  const { db, close, dataDir } = setup();
  seedRepo(db);

  // 先造出**真实存在**的父行：否则「NOT NULL 用例」会先撞外键，
  // 报错信息就不是 NOT NULL，断言就测错了东西。
  db.prepare("INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('wf','ed_1','tp_ok','风控助手工作流','2026-10-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('tk','wf','跑通风控模型',NULL,'tm_1','todo',NULL,'2026-10-02T00:00:00.000Z')").run();

  const NOT_NULL_CASES = [
    ['workflows.name', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x1','ed_1','tp_ok',NULL,'t')"],
    ['workflows.edition_id', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x2',NULL,'tp_ok','n','t')"],
    ['workflows.task_package_id', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x3','ed_1',NULL,'n','t')"],
    ['workflows.created_at', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('x4','ed_1','tp_ok','n',NULL)"],
    ['workflow_tasks.title', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('y1','wf',NULL,NULL,NULL,'todo',NULL,'t')"],
    ['workflow_tasks.status', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('y2','wf','t',NULL,NULL,NULL,NULL,'t')"],
    ['workflow_tasks.workflow_id', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('y3',NULL,'t',NULL,NULL,'todo',NULL,'t')"],
    ['task_claims.task_id', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('z1',NULL,NULL,'u_a','t',NULL)"],
    ['task_claims.user_id', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('z2','tk',NULL,NULL,'t',NULL)"],
    ['task_claims.claimed_at', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('z3','tk',NULL,'u_a',NULL,NULL)"],
    ['pool_projects.edition_id', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('p1',NULL,'tm_1','t',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_projects.team_id', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('p2','ed_1',NULL,'t',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_talents.user_id', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t1',NULL,'ed_1','n',NULL,0,NULL,0,'[]','t')"],
    ['pool_talents.edition_id', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t0','u_a',NULL,'n',NULL,0,NULL,0,'[]','t')"],
    ['pool_talents.total_points', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t2','u_a','ed_1','n',NULL,NULL,NULL,0,'[]','t')"],
    ['pool_talents.stages_joined', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t3','u_a','ed_1','n',NULL,0,NULL,NULL,'[]','t')"],
    ['pool_talents.skills_json', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('t4','u_a','ed_1','n',NULL,0,NULL,0,NULL,'t')"],
    ['pool_resources.edition_id', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('r1',NULL,'ent_1','n','enterprise_brief','d','t')"],
    ['pool_resources.enterprise_id', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('r2','ed_1',NULL,'n','enterprise_brief','d','t')"],
    ['pool_resources.kind', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('r3','ed_1','ent_1','n',NULL,'d','t')"],
    ['public_tokens.scope', "INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('h9',NULL,'ed_1','e','c')"],
    ['public_tokens.expires_at', "INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('h10','leaderboard','ed_1',NULL,'c')"],
  ];
  for (const [label, sql] of NOT_NULL_CASES) {
    assert.throws(() => db.prepare(sql).run(), /NOT NULL constraint failed/, `${label} 必须为 NOT NULL`);
  }

  // ⚠️ public_tokens.token **不在**上面的名单里 —— 这不是漏写，是 SQLite 的历史行为：
  //    TEXT PRIMARY KEY（只有 INTEGER PRIMARY KEY 才是 rowid 别名）允许 NULL。
  //    P0–P4 的所有 id 列都是这个写法（users.id / teams.id / task_packages.id / …），
  //    本迁移沿用同一约定（不单点偏离）。
  //    → 这里把它**钉住**：将来若给主键补 NOT NULL，这条会红，提示同步补仓储层的空值防线。
  //    实际影响：无 —— 公开令牌的查找键恒为 SHA-256 十六进制串，永远匹配不到 NULL 行。
  assert.doesNotThrow(
    () => db.prepare("INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (NULL,'leaderboard','ed_1','e','c')").run(),
    'SQLite 的 TEXT PRIMARY KEY 允许 NULL（P0–P4 既有约定）',
  );

  const FK_CASES = [
    ['workflows.task_package_id → task_packages(id)', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('f1','ed_1','tp_none','n','t')"],
    ['workflow_tasks.workflow_id → workflows(id)', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('f2','wf_none','t',NULL,NULL,'todo',NULL,'t')"],
    ['workflow_tasks.owner_team_id → teams(id)', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('f3','wf','t',NULL,'tm_none','todo',NULL,'t')"],
    ['task_claims.task_id → workflow_tasks(id)', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('f4','tk_none',NULL,'u_a','t',NULL)"],
    ['task_claims.team_id → teams(id)', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('f5','tk','tm_none','u_a','t',NULL)"],
    ['task_claims.user_id → users(id)', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('f6','tk',NULL,'u_none','t',NULL)"],
    ['pool_projects.team_id → teams(id)', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('f7','ed_1','tm_none','t',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_talents.user_id → users(id)', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('f8','u_none','ed_1','n',NULL,0,NULL,0,'[]','t')"],
  ];
  for (const [label, sql] of FK_CASES) {
    assert.throws(() => db.prepare(sql).run(), /FOREIGN KEY constraint failed/, `${label} 必须有外键`);
  }

  // 主键重复必须被拒绝
  db.prepare("INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('dup','leaderboard','ed_1','e','c')").run();
  assert.throws(
    () => db.prepare("INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('dup','calendar','ed_1','e','c')").run(),
    /UNIQUE constraint failed/,
  );

  // 七张表的主键都要真的挡住重复 id
  // ⚠️ 重复行必须**只撞主键**：自然键 / 部分唯一索引要用不同的值，
  //    否则报错信息指向的是自然键，这条断言就测错了东西。
  db.prepare("INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('tk2','wf','第二个任务',NULL,'tm_1','todo',NULL,'t')").run();
  db.prepare("INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('ck1','tk','tm_1','u_a','2026-10-03T00:00:00.000Z',NULL)").run();
  db.prepare("INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('pk1','ed_2','tm_9','t',NULL,NULL,NULL,NULL,NULL,'t')").run();
  db.prepare("INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('pt1','u_a','ed_1','n',NULL,0,NULL,0,'[]','t')").run();
  db.prepare("INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('pr1','ed_1','ent_1','n','enterprise_brief','d','t')").run();
  const PK_DUP_CASES = [
    ['workflows', "INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES ('wf','ed_1','tp_ok','n2','t')"],
    ['workflow_tasks', "INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at) VALUES ('tk','wf','t2',NULL,'tm_1','todo',NULL,'t')"],
    ['task_claims', "INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES ('ck1','tk2','tm_1','u_b','t',NULL)"],
    ['pool_projects', "INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at) VALUES ('pk1','ed_2','tm_1','t2',NULL,NULL,NULL,NULL,NULL,'t')"],
    ['pool_talents', "INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at) VALUES ('pt1','u_b','ed_1','n2',NULL,0,NULL,0,'[]','t')"],
    ['pool_resources', "INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at) VALUES ('pr1','ed_1','ent_2','n2','free_brief','d','t')"],
    ['public_tokens', "INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES ('dup','calendar','ed_1','e','c')"],
  ];
  for (const [label, sql] of PK_DUP_CASES) {
    assert.throws(() => db.prepare(sql).run(), /UNIQUE constraint failed/, `${label} 的主键必须挡住重复 id`);
  }

  // 同一届的**两支不同队**各自都能有项目池记录（唯一键是 (edition_id, team_id)，不是 edition_id）
  const insProject = db.prepare(
    `INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insProject.run('pp_a', 'ed_1', 'tm_1', '一队项目', null, null, null, null, null, 't');
  insProject.run('pp_b', 'ed_1', 'tm_2', '二队项目', null, null, null, null, null, 't');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pool_projects WHERE edition_id = ?').get('ed_1').n, 2);

  cleanup(db, close, dataDir);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/pools-migration.test.js`
Expected: FAIL —— `assert.equal(result.version, 6)` 失败（当前迁移版本是 5，`006_pools.sql` 不存在，七张表一张都没建出来）。**实测补充**：另外 4 个用例也红，报 `no such table: workflows` / `no such table: public_tokens` —— 因为建表本身就不存在，测的不是「版本号对不对」而是「表在不在」。

- [ ] **Step 3: 创建 `db/migrations/006_pools.sql`**

```sql
-- 006_pools.sql — 工作流与三池底座
-- 依据：INTERFACES.md §6（P5 产出）+ 设计文档 §5.4
-- 边界（三条，都写在表结构里，免得后来人忘了）：
--   ① 三池一期只做底座，不做前台页面（设计文档 §1.2 / §5.4）
--   ② 派生值不做冗余存储：pool_talents.total_points 只由 syncPoolTalents 的
--      单一计算点产出（src/domain/pool-derive.js），不手工维护、不增量累加
--   ③ 任务清单 ≠ 里程碑：workflow_tasks 与 milestones 不共享表、不共享规则
--      （同「两种企业签字必须分表」的同构纪律，设计文档 §5.3）

-- ── 工作流：任务包 → 工作流 → 任务清单（R-OPS-13）────────────────
CREATE TABLE workflows (
  id              TEXT PRIMARY KEY,
  edition_id      TEXT NOT NULL,
  task_package_id TEXT NOT NULL REFERENCES task_packages(id),
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_workflows_edition ON workflows(edition_id);
CREATE INDEX idx_workflows_package ON workflows(task_package_id);

CREATE TABLE workflow_tasks (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  title         TEXT NOT NULL,
  detail        TEXT,
  owner_team_id TEXT REFERENCES teams(id),
  status        TEXT NOT NULL DEFAULT 'todo',   -- todo | in_progress | done | blocked
  due_at        TEXT,
  created_at    TEXT NOT NULL,
  -- ⚠️ 契约里 workflow_tasks 只有 8 列；这 3 列是为了让「完成」这件事留痕
  --    （R-STG-04：提交内容为可运行状态或明确阻塞点）。见偏差章节 D-2。
  evidence_json TEXT,                           -- 完成证据（可运行产物链接+版本 / 明确阻塞点）
  completed_at  TEXT,
  completed_by  TEXT,
  CHECK (status IN ('todo', 'in_progress', 'done', 'blocked'))
);
CREATE INDEX idx_workflow_tasks_workflow ON workflow_tasks(workflow_id);
CREATE INDEX idx_workflow_tasks_team ON workflow_tasks(owner_team_id);

-- ── 领取记录：追加式（只增不改），"有效领取" = released_at IS NULL ──
CREATE TABLE task_claims (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES workflow_tasks(id),
  team_id     TEXT REFERENCES teams(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  claimed_at  TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX idx_task_claims_task ON task_claims(task_id);
CREATE INDEX idx_task_claims_user ON task_claims(user_id);
-- ⛔ 防重复领取：同一 task_id 同时只能有一个有效领取。
--    依据：设计文档 §6.4「一人一票必须由数据库保证。应用层的'先查再插'在并发下会插出两票」。
--    部分唯一索引：不新增 status 列（列清单与契约逐字一致），释放后旧行自动退出索引。
CREATE UNIQUE INDEX ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL;

-- ── 三池（R-POOL-01 / 02 / 03）：一期只有底座，没有前台 ─────────────
-- ⚠️ 三池三张表都带 edition_id（届期维度）：
--    依据：顶层文档 §3.1 S2（届期 × 城市多期租户维度）——"数据模型必须带 edition 维度，
--    否则复制到第 2 城时要改表结构，那就不是『平台统一』了"。
CREATE TABLE pool_projects (
  id             TEXT PRIMARY KEY,
  edition_id     TEXT NOT NULL,
  team_id        TEXT NOT NULL REFERENCES teams(id),
  title          TEXT NOT NULL,
  industry       TEXT,          -- 一期无行业字段来源 → 显式 NULL（不臆造，见偏差章节 D-7）
  stage_reached  TEXT,          -- stages.key（该队到达的最远赛段）
  tier           TEXT,          -- tier_records.tier（D/C/B/A/S）
  business_value REAL,          -- 企业业务部门签字数（商业事实代理；首届不验收入，R-ENT-05）
  summary        TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_pool_projects_edition_team ON pool_projects(edition_id, team_id);

CREATE TABLE pool_talents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  edition_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  org           TEXT,
  total_points  REAL NOT NULL DEFAULT 0,   -- ⛔ 只由 syncPoolTalents 的单一计算点写入，不手工维护
  mba_status    TEXT,
  stages_joined INTEGER NOT NULL DEFAULT 0,
  skills_json   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_pool_talents_edition_user ON pool_talents(edition_id, user_id);
CREATE INDEX idx_pool_talents_user ON pool_talents(user_id);

CREATE TABLE pool_resources (
  id             TEXT PRIMARY KEY,
  edition_id     TEXT NOT NULL,
  enterprise_id  TEXT NOT NULL,
  enterprise_name TEXT,
  kind           TEXT NOT NULL,   -- enterprise_brief | free_brief
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_pool_resources_edition_enterprise ON pool_resources(edition_id, enterprise_id, kind);

-- ── 公开访问令牌（公开榜单 / iCal 用，无需登录）────────────────────
CREATE TABLE public_tokens (
  token      TEXT PRIMARY KEY,   -- 存 SHA-256 十六进制（与 sessions.token_hash 同一纪律）
  scope      TEXT NOT NULL,      -- leaderboard | calendar | all
  edition_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_public_tokens_edition ON public_tokens(edition_id);
```

- [ ] **Step 4: 创建 `src/db/repo/workflows.js`**

```javascript
// src/db/repo/workflows.js — 工作流与任务清单仓储
// 依据：INTERFACES.md §6（P5 产出）；R-OPS-13 任务清单工作流拆解
// ⛔ 所有 SQL 收在本文件（全局约束「SQL 边界」）
import { randomUUID } from 'node:crypto';

export function insertWorkflow(db, { id = randomUUID(), editionId, taskPackageId, name, now }) {
  db.prepare(
    'INSERT INTO workflows (id, edition_id, task_package_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, editionId, taskPackageId, name, now);
  return getWorkflow(db, id);
}

export function getWorkflow(db, id) {
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) ?? null;
}

export function listWorkflowsByEdition(db, editionId) {
  return db
    .prepare('SELECT * FROM workflows WHERE edition_id = ? ORDER BY created_at, id')
    .all(editionId);
}

export function findWorkflowByPackage(db, editionId, taskPackageId) {
  return db
    .prepare('SELECT * FROM workflows WHERE edition_id = ? AND task_package_id = ? ORDER BY created_at, id')
    .get(editionId, taskPackageId) ?? null;
}

export function insertWorkflowTask(
  db,
  { id = randomUUID(), workflowId, title, detail = null, ownerTeamId = null, status = 'todo', dueAt = null, now },
) {
  db.prepare(
    `INSERT INTO workflow_tasks (id, workflow_id, title, detail, owner_team_id, status, due_at, created_at,
       evidence_json, completed_at, completed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, workflowId, title, detail, ownerTeamId, status, dueAt, now);
  return getWorkflowTask(db, id);
}

export function getWorkflowTask(db, id) {
  return db.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(id) ?? null;
}

export function listWorkflowTasksByWorkflow(db, workflowId) {
  return db
    .prepare('SELECT * FROM workflow_tasks WHERE workflow_id = ? ORDER BY created_at, id')
    .all(workflowId);
}

export function updateWorkflowTaskStatus(db, id, status) {
  return db.prepare('UPDATE workflow_tasks SET status = ? WHERE id = ?').run(status, id).changes;
}

export function completeWorkflowTask(db, id, { status, evidenceJson, completedAt, completedBy }) {
  return db
    .prepare(
      `UPDATE workflow_tasks SET status = ?, evidence_json = ?, completed_at = ?, completed_by = ?
        WHERE id = ?`,
    )
    .run(status, evidenceJson, completedAt, completedBy, id).changes;
}
```

- [ ] **Step 5: 创建 `src/db/repo/task-claims.js`**

```javascript
// src/db/repo/task-claims.js — 任务领取记录仓储
// 依据：R-OPS-13 / R-OPS-14（任务只能自主领取）
// ⛔ 「同一任务同时只能有一个有效领取」由 006_pools.sql 里的
//    部分唯一索引 ux_task_claims_active 保证，本文件不做"先查再插"的判断。
import { randomUUID } from 'node:crypto';

export function insertTaskClaim(db, { id = randomUUID(), taskId, teamId = null, userId, now }) {
  db.prepare(
    'INSERT INTO task_claims (id, task_id, team_id, user_id, claimed_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(id, taskId, teamId, userId, now);
  return getActiveClaim(db, taskId);
}

export function getActiveClaim(db, taskId) {
  return db.prepare('SELECT * FROM task_claims WHERE task_id = ? AND released_at IS NULL').get(taskId) ?? null;
}

export function releaseTaskClaim(db, claimId, now) {
  return db
    .prepare('UPDATE task_claims SET released_at = ? WHERE id = ? AND released_at IS NULL')
    .run(now, claimId).changes;
}

export function listClaimsByUser(db, userId) {
  return db.prepare('SELECT * FROM task_claims WHERE user_id = ? ORDER BY claimed_at, id').all(userId);
}

export function countActiveClaims(db, taskId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get(taskId).n;
}
```

- [ ] **Step 6: 追加 `src/db/repo/teamMembers.js` 的两个只读函数（**P1 已建的文件**）**

⚠️ **本阶段不新建 `src/db/repo/team-membership.js`**（原写法）—— 见下方 I-3 修正记录。
`platform/src/db/repo/teamMembers.js` 由 **P1 建立**（`insertTeamMember` / `listActiveMembers` /
`listMemberHistory` / `findActiveMembershipByUser` / `markMemberLeft` / `countActiveMembers` /
`lastLeaveAt`）。本阶段**只追加**下面两个函数，**不重建文件**、**不改 P1 已有的函数签名**：

```javascript
// src/db/repo/teamMembers.js —— 【追加】到 P1 已建的文件里
// 依据：R-OPS-13 / R-OPS-14（自主领取的人必须是某个队的成员）
// ⚠️ 本文件由 P1 建立。本阶段【追加】下面两个函数，P1 已有的函数保持不动
//    （签名一个字都不改）。
//
// hasActiveMembership：这个人**是不是这支队的**在队成员。
// ⛔ 不能用 P1 的 countActiveMembers(db, teamId) > 0 代替 ——
//    那问的是「这支队还有没有在队成员」，不是「这个人是不是在队成员」。
//    两者在「队里只剩别人」时结论完全相反（前者 true、后者 false）。
export function hasActiveMembership(db, teamId, userId) {
  const row = db
    .prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL')
    .get(teamId, userId);
  return row !== undefined;
}

// listMemberTeams：这个人在哪些队（可选按届期过滤）。
// 依据：R-REG-03「赛程中成员可持续招募汰换」→ 只要 left_at IS NULL 就算在队。
export function listMemberTeams(db, userId, { editionId = null } = {}) {
  const sql = editionId
    ? `SELECT t.* FROM teams t
        JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? AND m.left_at IS NULL AND t.edition_id = ?
       ORDER BY t.id`
    : `SELECT t.* FROM teams t
        JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? AND m.left_at IS NULL
       ORDER BY t.id`;
  const rows = editionId ? db.prepare(sql).all(userId, editionId) : db.prepare(sql).all(userId);
  return rows;
}
```

> **【2026-10-21 漂移审计修正 I-3】**
> **原来错在哪**：本阶段原来**新建** `platform/src/db/repo/team-membership.js`，
> 里面放 `isActiveMember` / `listMemberTeams` / `listTeamsByPackage`，
> 后面 Task 2 又**追加** `getTeamById`。
> **为什么错**：
> ① **同一张 `team_members` 表出现两个仓储文件、两套函数** ——
> `teamMembers.js`（P1，camelCase）与 `team-membership.js`（P5，kebab-case）。
> P5 的 `isActiveMember` 与 P1 的 `findActiveMembershipByUser` 语义重叠。
> ② **更糟的是同一个函数体有两份拷贝**：P5 的
> ```javascript
> export function getTeamById(db, id) {
>   return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
> }
> ```
> 与 P1 终态 `platform/src/db/repo/teams.js:32-34` 的 `getTeam` **逐字相同**（含 SQL 与 `?? null`）。
> 将来修一处忘一处，就会出现「P5 认为在队、P1 认为已离队」的数据分歧 ——
> 这正是「`src/db/repo/*` 文件归属冲突」要找的那类问题。
> ③ 原写法的前提「契约未规定 P1 仓储层的导出名，自建只读入口可避免跨阶段撞名」
> **已经不成立** —— P1 终态的仓储导出名是**既成事实**，照着那个名字写只会撞名。
> **改成什么**：**删除** `src/db/repo/team-membership.js`，改为复用 P1 的两个仓储：
> | 原 P5 函数 | 改成 | 理由 |
> |---|---|---|
> | `getTeamById(db, id)` | **P1 的 `getTeam(db, id)`**（`src/db/repo/teams.js`） | 与 P1 逐字相同，不重复实现 |
> | `isActiveMember(db, teamId, userId)` | **追加** `hasActiveMembership(db, teamId, userId)` 到 P1 的 `src/db/repo/teamMembers.js` | 查「这个人是不是这支队的成员」；⚠️ **不能用** P1 的 `countActiveMembers(db, teamId) > 0` 代替 —— 那问的是「这支队还有没有在队成员」，在「队里只剩别人」时结论相反 |
> | `listMemberTeams(db, userId, { editionId })` | **追加**到 P1 的 `src/db/repo/teamMembers.js` | P1 没有等价物（`findActiveMembershipByUser` 用 `LIMIT 1` 只返回一支队），确属新增 |
> | `listTeamsByPackage(db, editionId, taskPackageId)` | **P1 的 `listTeamRows(db, { editionId, taskPackageId })`**（`src/db/repo/teams.js`） | 过滤条件等价（都排除 `deleted_at IS NULL`），不必再写一份 |
> 文件归属由此单一：`team_members` → `teamMembers.js`；`teams` → `teams.js`。
> **依据**：P1 终态 `platform/src/db/repo/teams.js`（`getTeam` / `listTeamRows`）
> 与 `platform/src/db/repo/teamMembers.js`（7 个导出）+ 漂移审计报告 I-3。

- [ ] **Step 7: 创建 `src/db/repo/pools.js`**

```javascript
// src/db/repo/pools.js — 三池仓储（写 + 读）
// 依据：设计文档 §5.4；R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池
// ⛔ 写入只允许经由 src/services/pools.js 的同步服务（单一计算点）；
//    本文件不提供任何"手工加一行"的对外函数。
import { randomUUID } from 'node:crypto';

// ── 项目池 ──────────────────────────────────────────────────────────
export function insertPoolProject(
  db,
  { id = randomUUID(), editionId, teamId, title, industry = null, stageReached = null,
    tier = null, businessValue = null, summary = null, now },
) {
  db.prepare(
    `INSERT INTO pool_projects (id, edition_id, team_id, title, industry, stage_reached, tier,
       business_value, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, teamId, title, industry, stageReached, tier, businessValue, summary, now);
  return id;
}

export function updatePoolProject(
  db,
  id,
  { title, industry = null, stageReached = null, tier = null, businessValue = null, summary = null },
) {
  return db
    .prepare(
      `UPDATE pool_projects
          SET title = ?, industry = ?, stage_reached = ?, tier = ?, business_value = ?, summary = ?
        WHERE id = ?`,
    )
    .run(title, industry, stageReached, tier, businessValue, summary, id).changes;
}

export function deletePoolProject(db, id) {
  return db.prepare('DELETE FROM pool_projects WHERE id = ?').run(id).changes;
}

export function listPoolProjectRows(db, editionId = null) {
  return editionId
    ? db.prepare('SELECT * FROM pool_projects WHERE edition_id = ? ORDER BY team_id').all(editionId)
    : db.prepare('SELECT * FROM pool_projects ORDER BY edition_id, team_id').all();
}

// ── 人才池 ──────────────────────────────────────────────────────────
export function insertPoolTalent(
  db,
  { id = randomUUID(), editionId, userId, name, org = null, totalPoints = 0, mbaStatus = null,
    stagesJoined = 0, skillsJson = '[]', now },
) {
  db.prepare(
    `INSERT INTO pool_talents (id, user_id, edition_id, name, org, total_points, mba_status,
       stages_joined, skills_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, editionId, name, org, totalPoints, mbaStatus, stagesJoined, skillsJson, now);
  return id;
}

export function updatePoolTalent(
  db,
  id,
  { name, org = null, totalPoints = 0, mbaStatus = null, stagesJoined = 0, skillsJson = '[]' },
) {
  return db
    .prepare(
      `UPDATE pool_talents
          SET name = ?, org = ?, total_points = ?, mba_status = ?, stages_joined = ?, skills_json = ?
        WHERE id = ?`,
    )
    .run(name, org, totalPoints, mbaStatus, stagesJoined, skillsJson, id).changes;
}

export function deletePoolTalent(db, id) {
  return db.prepare('DELETE FROM pool_talents WHERE id = ?').run(id).changes;
}

export function listPoolTalentRows(db, editionId = null) {
  return editionId
    ? db.prepare('SELECT * FROM pool_talents WHERE edition_id = ? ORDER BY total_points DESC, user_id').all(editionId)
    : db.prepare('SELECT * FROM pool_talents ORDER BY edition_id, total_points DESC, user_id').all();
}

// ── 资源池 ──────────────────────────────────────────────────────────
export function insertPoolResource(
  db,
  { id = randomUUID(), editionId, enterpriseId, enterpriseName = null, kind, detail = null, now },
) {
  db.prepare(
    `INSERT INTO pool_resources (id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, editionId, enterpriseId, enterpriseName, kind, detail, now);
  return id;
}

export function updatePoolResource(db, id, { enterpriseName = null, kind, detail = null }) {
  return db
    .prepare('UPDATE pool_resources SET enterprise_name = ?, kind = ?, detail = ? WHERE id = ?')
    .run(enterpriseName, kind, detail, id).changes;
}

export function deletePoolResource(db, id) {
  return db.prepare('DELETE FROM pool_resources WHERE id = ?').run(id).changes;
}

export function listPoolResourceRows(db, editionId = null) {
  return editionId
    ? db.prepare('SELECT * FROM pool_resources WHERE edition_id = ? ORDER BY enterprise_id, kind').all(editionId)
    : db.prepare('SELECT * FROM pool_resources ORDER BY edition_id, enterprise_id, kind').all();
}
```

- [ ] **Step 8: 创建 `src/db/repo/pool-sources.js`**

```javascript
// src/db/repo/pool-sources.js — 三池的【派生源】读取
// 依据：INTERFACES.md §6
//   pool_projects  ← teams + stage_results + tier_records（+ task_packages 取标题）
//   pool_talents   ← points_ledger 聚合（+ users / registrations 取档案）
//   pool_resources ← task_packages（企业侧资源）
// ⛔ 只读。本文件不写任何表 —— 派生源是上游阶段的事实，本阶段只能读。
//
// ⚠️ 排序兜底键一律用 **SQLite 隐式 rowid**（写入次序），⛔ 不用 `id` 列：
//    这几张表的 id 全是 randomUUID()（src/db/repo/points.js、tiers.js、registrations.js
//    的头部注释都写明了同一条纪律）—— 拿随机 UUID 当排序键 ⇒ 同一批写入的记录
//    顺序逐次运行都不同 ⇒ 榜单不可复算。
//    依据：硬约束「任何排序兜底键不得用随机 UUID」+ src/db/repo/points.js 的
//    `ORDER BY created_at ASC, rowid ASC` 同款口径。
//    ⛔ rowid 必须**同时**出现在 SELECT 里：域函数要靠它做同刻记录的显式比较，
//    这样「同一份数据无论以什么顺序喂进纯函数，结果都一样」。
export function getEdition(db, editionId) {
  return db.prepare('SELECT * FROM editions WHERE id = ?').get(editionId) ?? null;
}

export function listEditionTeams(db, editionId) {
  return db
    .prepare('SELECT id, name, task_package_id, tier FROM teams WHERE edition_id = ? AND deleted_at IS NULL ORDER BY id')
    .all(editionId);
}

export function listEditionPackages(db, editionId, { statuses = [] } = {}) {
  const base = `SELECT id, edition_id, enterprise_id, enterprise_name, title, pain_point, expected_delivery,
                       grade, status, is_free_brief, deleted_at
                  FROM task_packages WHERE edition_id = ? AND deleted_at IS NULL`;
  if (!statuses.length) {
    return db.prepare(`${base} ORDER BY id`).all(editionId);
  }
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`${base} AND status IN (${placeholders}) ORDER BY id`).all(editionId, ...statuses);
}

export function listEditionStages(db, editionId) {
  // ⚠️ P2 的 DDL 里 "key" 是带引号的标识符（SQLite 关键字），必须写成 "key" AS stage_key
  return db
    .prepare('SELECT id, "key" AS stage_key, name, kind, starts_at, ends_at, status FROM stages WHERE edition_id = ? ORDER BY starts_at, id')
    .all(editionId);
}

export function listEditionStageResults(db, editionId) {
  return db
    .prepare(
      `SELECT sr.stage_id, sr.team_id, sr.rank, sr.total, sr.points, sr.tied_with
         FROM stage_results sr
         JOIN stages s ON s.id = sr.stage_id
        WHERE s.edition_id = ?
        ORDER BY sr.stage_id, sr.rank, sr.team_id`,
    )
    .all(editionId);
}

export function listStageResultsWithTeams(db, stageId) {
  return db
    .prepare(
      `SELECT sr.team_id, sr.rank, sr.total, sr.points, sr.tied_with, t.name AS team_name
         FROM stage_results sr
         LEFT JOIN teams t ON t.id = sr.team_id
        WHERE sr.stage_id = ?
        ORDER BY sr.rank, sr.team_id`,
    )
    .all(stageId);
}

// tier_records 没有 edition_id → 通过 teams 关联到届期
// ⚠️ ORDER BY 必须带**兜底键**：同一支队的两条段位记录可能 computed_at 完全相同
//    （tier_records 没有 (team_id, computed_at) 唯一约束，重算日志天然允许同刻）。
//    排序键相等时 SQLite **不保证**返回顺序 ⇒ 「取哪条」本来是不确定的。
//    兜底键用 rowid（写入次序）⇒ 与 src/db/repo/tiers.js 的
//    `ORDER BY computed_at DESC, rowid DESC` 同一口径（同刻时后写入的那条算数）。
export function listEditionTierRecords(db, editionId) {
  return db
    .prepare(
      `SELECT tr.team_id, tr.tier, tr.milestone_count, tr.business_signoff_count, tr.computed_at, tr.deleted_at,
              tr.rowid AS rowid
         FROM tier_records tr
         JOIN teams t ON t.id = tr.team_id
        WHERE t.edition_id = ?
        ORDER BY tr.team_id, tr.computed_at, tr.rowid`,
    )
    .all(editionId);
}

export function listEditionLedger(db, editionId) {
  return db
    .prepare(
      `SELECT id, edition_id, stage_id, team_id, user_id, kind, points, created_at
         FROM points_ledger WHERE edition_id = ? ORDER BY user_id, created_at, rowid`,
    )
    .all(editionId);
}

// 终生累计（R-RNK-10）：个人积分跨届期累加
export function listUserLedger(db, userId) {
  return db
    .prepare(
      `SELECT id, edition_id, stage_id, team_id, user_id, kind, points, created_at
         FROM points_ledger WHERE user_id = ? ORDER BY created_at, rowid`,
    )
    .all(userId);
}

export function listEditionUsers(db, editionId) {
  return db
    .prepare('SELECT id, name, org, mba_status FROM users WHERE id IN (SELECT DISTINCT user_id FROM points_ledger WHERE edition_id = ?) ORDER BY id')
    .all(editionId);
}

export function listAllUsers(db) {
  return db.prepare('SELECT id, name, org, mba_status FROM users WHERE active = 1 ORDER BY id').all();
}

export function listEditionRegistrations(db, editionId) {
  return db
    .prepare(
      `SELECT id, user_id, dimension_scores_json, level, created_at, deleted_at,
              rowid AS rowid
         FROM registrations WHERE edition_id = ? ORDER BY user_id, created_at, rowid`,
    )
    .all(editionId);
}
```

- [ ] **Step 9: 创建 `src/db/repo/public-tokens.js`**

```javascript
// src/db/repo/public-tokens.js — 公开访问令牌仓储
// 依据：INTERFACES.md §6 `public_tokens(token, scope, edition_id, expires_at, created_at)`
// ⛔ token 列存 SHA-256 十六进制（与 P0 的 sessions.token_hash 同一纪律）：
//    库被拖走也拿不到可用的公开令牌。明文只在签发时返回一次。
export function insertPublicToken(db, { token, scope, editionId, expiresAt, now }) {
  db.prepare(
    'INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(token, scope, editionId, expiresAt, now);
  return { token, scope, editionId, expiresAt };
}

export function findPublicToken(db, tokenHash) {
  return db.prepare('SELECT * FROM public_tokens WHERE token = ?').get(tokenHash) ?? null;
}

export function deletePublicToken(db, tokenHash) {
  return db.prepare('DELETE FROM public_tokens WHERE token = ?').run(tokenHash).changes;
}

export function listPublicTokens(db, { editionId = null } = {}) {
  return editionId
    ? db.prepare('SELECT * FROM public_tokens WHERE edition_id = ? ORDER BY created_at, token').all(editionId)
    : db.prepare('SELECT * FROM public_tokens ORDER BY created_at, token').all();
}
```

- [ ] **Step 10: 运行测试确认通过**

Run: `cd platform && node --test test/pools-migration.test.js`
Expected: PASS —— `pools-migration.test.js` **13 例全过**。（原规格写「5 个测试」，是**只覆盖迁移层**的版本；本 Task 实跑后补了「真并发」与「仓储层」用例，见文末台账 T1-1 C-1 / C-2。）

- [ ] **Step 11: 实跑迁移**

Run: `cd platform && node scripts/migrate.js`
Expected: 输出 `迁移完成，当前版本 6`，本次应用包含 `006_pools.sql`

- [ ] **Step 12: 提交**

```bash
cd platform && git add db/migrations/006_pools.sql src/db/repo/workflows.js src/db/repo/task-claims.js \
  src/db/repo/pools.js src/db/repo/pool-sources.js src/db/repo/public-tokens.js src/db/repo/teamMembers.js \
  test/pools-migration.test.js
git commit -m "feat(P5): 工作流与三池数据模型（006_pools.sql）+ 领取唯一约束 + 仓储层

对应 R-OPS-13 / R-OPS-14 / R-POOL-01 / R-POOL-02 / R-POOL-03：
- task_claims 用部分唯一索引保证同一任务同时只有一个人领取
- 三池表只提供仓储，不提供手工写入口（派生值单一来源）
- 任务清单与里程碑不共享表" -- \
  db/migrations/006_pools.sql src/db/repo/workflows.js src/db/repo/task-claims.js \
  src/db/repo/pools.js src/db/repo/pool-sources.js src/db/repo/public-tokens.js src/db/repo/teamMembers.js \
  test/pools-migration.test.js
```

> ⚠️ **【2026-10-21 父代理预审修正 T1-9】提交写法**
> 原写法：`git add …` 后 `git commit -m "…" `（**没有 `-- <paths…>`**）。
> 问题：`-m` 与 `--` 的顺序、以及**必须显式路径**是本项目的提交纪律 ——
> 显式路径让「这次提交到底动了哪些文件」在命令里就写死，不依赖暂存区的残留状态。
> 改成：`git add <paths…>` → `git commit -m "…" -- <paths…>`（`-m` 在 `--` 之前）。

---

### Task 2: 任务清单与自主领取（禁止岗位制）

**Files:**
- Create: `platform/src/domain/task-evidence.js`
- Create: `platform/src/services/workflow.js`
- Modify: ~~`platform/src/db/repo/teamMembers.js`~~ → **本阶段不需改**：`hasActiveMembership` / `listMemberTeams` **已由 Task 1 追加到位**（见台账 T2-1 C-1），重复实现会造成两个真相源
- Test: `platform/test/workflow-service.test.js`

**Interfaces:**
- Consumes: Task 1 的 `workflows` / `workflow_tasks` / `task_claims` 与仓储；P0 的 `getUserById`（`src/db/repo/users.js`）与 `appError`（`src/errors.js`，**status-first**）
- Produces（与 `INTERFACES.md` §6 逐字一致，另**追加**两个建对象，见偏差章节 D-3）：
  - `listWorkflowTasks({ db, workflowId, viewer })` → `task[]`
  - `claimTask({ db, taskId, userId, teamId, now })` → `{ task, claim }`
  - `releaseTask({ db, taskId, userId, now })` → `{ task }`
  - `completeTask({ db, taskId, userId, now, evidence })` → `{ task }`
  - **追加**：`createWorkflow({ db, editionId, taskPackageId, name, actorId, now })` → workflow
  - **追加**：`createWorkflowTask({ db, workflowId, title, detail, ownerTeamId, dueAt, actorId, now })` → task
  - 领域纯函数：`validateTaskEvidence(evidence, { maxSummaryLength })` → `{ ok, errors[] }`

> **⚠️ 本 Task 的灵魂（两条红线）**
> **① R-OPS-14 禁止岗位制 —— 这是【刻意的功能缺失】。**
> 本模块**不提供**任何"按岗位 / 身份分配任务"的函数、接口或数据列。任务只有一条获得路径：`claimTask`（自主领取）。
> 依据：任务书 §六 AI 原生组织红线「**严禁按岗位和身份分工**」；探月黑客松因岗位制失败——**忙的忙死、闲的闲死、最后一个人说了算**。
> 代码里必须留 `// R-OPS-14：禁止岗位制，任务只能自主领取` 这行注释（可被测试断言）。
>
> **② R-STG-04 的边界必须写清楚。**
> 「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」**是针对赛段交付物打分的**（P2/P3 的评审对象）。
> 本阶段负责的是**任务清单的完成记录**：`completeTask` 只写 `workflow_tasks` 的完成状态与证据，
> ⛔ **不写 `points_ledger`、不写 `behavior_events`、不产生任何分数**。任务完成 ≠ 赛段交付物得分。

- [ ] **Step 1: 写失败的测试**

`platform/test/workflow-service.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import * as workflow from '../src/services/workflow.js';
import { validateTaskEvidence } from '../src/domain/task-evidence.js';
// 「真实写入方」：新增用例的世界用仓储层的真实写入函数造数据
// （判别性 + 不让「手造 input」把一致变成假象 —— 本项目踩过的坑）
import { createUser, setSuperadmin } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage } from '../src/db/repo/stages.js';
import { insertLedgerEntry, insertBehaviorEvent } from '../src/db/repo/points.js';

const here = dirname(fileURLToPath(import.meta.url));

// 统一的注入时间戳（领域层无 Date.now()：所有时间都必须由调用方注入）
const NOW = '2026-10-02T00:00:00.000Z';
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5wf-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_cap', '队长甲', '13900000011', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_other', '组员乙', '13900000012', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_out', '路人丙', '13900000013', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型',
      '能跑起来就行', 'A', 'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_cap',
      '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_cap', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_cap', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_1', 'u_other', 'member', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_cap', 'stage_rank', 10, '2026-10-10T00:00:00.000Z');
  `);
  return { db, close, dataDir };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

function seedWorkflow(db) {
  const wf = workflow.createWorkflow({
    db, editionId: 'ed_1', taskPackageId: 'tp_1', name: '风控助手工作流', actorId: 'u_cap', now: '2026-10-02T00:00:00.000Z',
  });
  const task = workflow.createWorkflowTask({
    db, workflowId: wf.id, title: '跑通风控模型', detail: '需要一个可演示的 demo',
    ownerTeamId: 'tm_1', dueAt: '2026-10-12', actorId: 'u_cap', now: '2026-10-02T00:00:00.000Z',
  });
  return { wf, task };
}

test('队员可以自主领取任务，任务状态变 in_progress', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  const res = workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  assert.equal(res.task.status, 'in_progress');
  assert.equal(res.claim.user_id, 'u_cap');
  const n = db.prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL').get(task.id).n;
  assert.equal(n, 1);
  cleanup(db, close, dataDir);
});

test('同一任务不能被两人同时领取：第二个人拿到 409，库里有效领取仍然只有 1 条', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });

  assert.throws(
    () => workflow.claimTask({ db, taskId: task.id, userId: 'u_other', teamId: 'tm_1', now: '2026-10-03T00:00:01.000Z' }),
    (err) => err.status === 409 && err.code === 'TASK_ALREADY_CLAIMED',
    '第二个人领取必须被拒（409 TASK_ALREADY_CLAIMED）',
  );

  const n = db.prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL').get(task.id).n;
  assert.equal(n, 1, '有效领取永远只有一条');
  cleanup(db, close, dataDir);
});

test('释放后任务回到 todo，可以被别人领取', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const released = workflow.releaseTask({ db, taskId: task.id, userId: 'u_cap', now: '2026-10-03T02:00:00.000Z' });
  assert.equal(released.task.status, 'todo');

  const res = workflow.claimTask({ db, taskId: task.id, userId: 'u_other', teamId: 'tm_1', now: '2026-10-03T03:00:00.000Z' });
  assert.equal(res.claim.user_id, 'u_other');
  cleanup(db, close, dataDir);
});

test('不能释放别人领取的任务（403）', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  assert.throws(
    () => workflow.releaseTask({ db, taskId: task.id, userId: 'u_other', now: '2026-10-03T01:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'NOT_CLAIM_HOLDER',
  );
  cleanup(db, close, dataDir);
});

test('完成必须提交可运行状态或明确阻塞点：只给一段文字说明 → 400 EVIDENCE_REQUIRED', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });

  assert.throws(
    () => workflow.completeTask({
      db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
      evidence: { summary: '今天把模型跑通了，感觉还行，明天继续' },
    }),
    (err) => err.status === 400 && err.code === 'EVIDENCE_REQUIRED',
    '纯文字进度说明必须被拒绝（R-STG-04）',
  );
  const row = db.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get(task.id);
  assert.equal(row.status, 'in_progress', '被拒的提交不能改变任务状态');
  cleanup(db, close, dataDir);
});

test('kind=runnable 且带链接与版本 → 任务变 done，证据落库', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const res = workflow.completeTask({
    db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
    evidence: {
      kind: 'runnable',
      summary: '模型已跑通，给出可演示的 demo',
      artifactUrl: 'https://git.example.com/demo/risk-model',
      version: 'v0.3.1',
    },
  });
  assert.equal(res.task.status, 'done');
  assert.equal(res.task.completed_by, 'u_cap');
  assert.ok(res.task.evidence_json.includes('v0.3.1'), '证据必须落库');
  cleanup(db, close, dataDir);
});

test('kind=blocked 且写明阻塞点与解除条件 → 任务变 blocked（挂起等解除），不是完成', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const res = workflow.completeTask({
    db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
    evidence: {
      kind: 'blocked',
      summary: '拿不到风控数据，无法训练',
      blocker: { reason: '数据未授权', needed: '企业出具《数据授权说明》' },
    },
  });
  assert.equal(res.task.status, 'blocked');
  assert.notEqual(res.task.status, 'done');
  cleanup(db, close, dataDir);
});

test('完成任务不加分：points_ledger 行数不变（任务完成 ≠ 赛段交付物得分）', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const before = db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n;
  workflow.completeTask({
    db, taskId: task.id, userId: 'u_cap', now: '2026-10-04T00:00:00.000Z',
    evidence: { kind: 'runnable', summary: '跑通了', artifactUrl: 'https://git.example.com/demo/risk-model', version: 'v1' },
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n;
  assert.equal(after, before, '任务清单的完成记录不写积分');
  cleanup(db, close, dataDir);
});

test('非本队成员看不到任务清单（返回空数组，不是报错）', () => {
  const { db, close, dataDir } = setup();
  const { wf } = seedWorkflow(db);
  const rows = workflow.listWorkflowTasks({ db, workflowId: wf.id, viewer: { id: 'u_out' } });
  assert.deepEqual(rows, [], '列表不满足 → 200 + 空集（不暴露"有但不给看"）');
  cleanup(db, close, dataDir);
});

test('本队成员能看到全部任务与领取人', () => {
  const { db, close, dataDir } = setup();
  const { wf, task } = seedWorkflow(db);
  workflow.claimTask({ db, taskId: task.id, userId: 'u_cap', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' });
  const rows = workflow.listWorkflowTasks({ db, workflowId: wf.id, viewer: { id: 'u_other' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claim.userId, 'u_cap');
  assert.equal(rows[0].isMine, false);
  cleanup(db, close, dataDir);
});

test('禁止岗位制：服务层没有任何"按岗位/身份分配任务"的出口', () => {
  const exported = Object.keys(workflow);
  for (const forbidden of ['assignTask', 'assignByRole', 'assignTaskByPosition', 'dispatchTask', 'allocateTask']) {
    assert.equal(exported.includes(forbidden), false, `⛔ 不允许出现 ${forbidden}（R-OPS-14 禁止岗位制）`);
  }
  assert.ok(exported.includes('claimTask'), '唯一获得任务的入口是自主领取');
  const src = readFileSync(join(here, '..', 'src', 'services', 'workflow.js'), 'utf8');
  assert.ok(src.includes('R-OPS-14'), '代码注释必须标注 R-OPS-14：禁止岗位制，任务只能自主领取');
  // 判别性：`includes('R-OPS-14')` 会被**任何一处**出现满足 ——
  //   而规格要求的是「这行注释必须留着」，所以把整行逐字钉住。
  //   （否则「删掉溯源注释」是一个等价变异体，测试根本区分不出来。）
  assert.ok(
    src.includes('// R-OPS-14：禁止岗位制，任务只能自主领取'),
    '必须逐字保留这行注释：// R-OPS-14：禁止岗位制，任务只能自主领取',
  );
});

test('未登录领取 → 401', () => {
  const { db, close, dataDir } = setup();
  const { task } = seedWorkflow(db);
  assert.throws(
    () => workflow.claimTask({ db, taskId: task.id, userId: 'u_missing', teamId: 'tm_1', now: '2026-10-03T00:00:00.000Z' }),
    (err) => err.status === 401,
  );
  cleanup(db, close, dataDir);
});

// ════════════════════════════════════════════════════════════════════════════
// P5 Task 2 追加：规格缺陷补测（台账 T2-1 / T2-2）
//
// 计划原测试块 12 例覆盖了主链路（领取唯一性 / 释放 / 完成证据 / 禁止岗位制 /
// 完成不加分），但**判别力不足**：多处期望值「恰好相同」区分不出两种实现；
// 若干分支（403/404/409 的细分、并发兜底、behavior_events 边界、真实写入方形状）
// **零覆盖**。下面按三条纪律补：
//
//   ① 判别性：每个用例的期望值必须让「两种算法」产生**不同**结果，
//      否则「一致」只是巧合（例如「同届期不同任务包」与「同队不同届期」都不可见，
//      只测前者测不出「漏了 editionId 过滤」）。
//   ② 真实写入方：新增用例的世界用**仓储层的真实写入函数**造数据
//      （createUser / createEdition / createTaskPackage / insertTeam /
//      insertTeamMember / insertStage / insertLedgerEntry / insertBehaviorEvent），
//      不用手写 INSERT —— 免得「手造 input 让一致变成假象」（本项目踩过的坑）：
//      真实写入方产出 teams.status='forming'、task_packages.status='submitted'，
//      而计划原种子里手写成 'active' / 'approved' —— 一份偷偷按 status 过滤的
//      实现，在手造种子里照样绿。
//   ③ 溯源：每条断言写明依据的规则编号与出处。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 「真实写入方」世界。
 *
 * 拓扑（用来判别可见性必须**同时**按届期与任务包隔离）：
 *   ed1/tp1/tm1 —— 一队（captain + member）；本 Task 的主工作流挂在这里
 *   ed1/tp2/tm2 —— 二队：同届期、**不同任务包** → 对 tp1 的工作流不可见
 *   ed2/tp3/tm3 —— 三队：**下一届**、不同任务包   → 对 tp1 的工作流不可见
 *   ed2/tp1/tm4 —— 四队：⚠️ 刻意的「不一致数据」（下一届的队指向本届的任务包）→ 不可见
 *   admin        —— 组委会（超管），**不属于任何队** → 只能靠超管分支才看得见
 *   outsider     —— 外单位路人，**不属于任何队** → 不可见
 */
function setupWorld() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5wfw-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);

  const users = {
    captain: createUser(db, { name: '队长甲', phone: '13900000011', password: 'pw', mbaStatus: 'mba', org: '学堂' }),
    member: createUser(db, { name: '组员乙', phone: '13900000012', password: 'pw', org: '学堂' }),
    outsider: createUser(db, { name: '路人丙', phone: '13900000013', password: 'pw', org: '外单位' }),
    captain2: createUser(db, { name: '队长丁', phone: '13900000014', password: 'pw', org: '学堂' }),
    captain3: createUser(db, { name: '队长戊', phone: '13900000015', password: 'pw', org: '学堂' }),
    captain4: createUser(db, { name: '队长己', phone: '13900000017', password: 'pw', org: '学堂' }),
    admin: createUser(db, { name: '组委会', phone: '13900000016', password: 'pw', org: '组委会' }),
  };
  setSuperadmin(db, users.admin.id);

  const editions = {
    ed1: createEdition(db, { name: '第一届', city: '杭州', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW }),
    ed2: createEdition(db, { name: '第二届', city: '上海', startsAt: '2027-10-01', endsAt: '2027-10-31', now: NOW }),
  };

  const packages = {
    tp1: createTaskPackage(db, {
      editionId: editions.ed1.id, title: '零售风控助手', painPoint: '人工审批慢',
      expectedDelivery: '可演示原型', acceptanceCriteria: '能跑起来就行',
      submittedBy: users.captain.id, now: NOW,
    }),
    tp2: createTaskPackage(db, {
      editionId: editions.ed1.id, title: '招股书排版助手', painPoint: '排版太慢',
      expectedDelivery: '可演示原型', acceptanceCriteria: '能跑起来就行',
      submittedBy: users.captain2.id, now: NOW,
    }),
    tp3: createTaskPackage(db, {
      editionId: editions.ed2.id, title: '下一届的包', painPoint: '下一届的痛点',
      expectedDelivery: '可演示原型', acceptanceCriteria: '能跑起来就行',
      submittedBy: users.captain3.id, now: NOW,
    }),
  };

  const teams = {
    tm1: insertTeam(db, {
      editionId: editions.ed1.id, name: '一队', captainId: users.captain.id,
      taskPackageId: packages.tp1.id, tier: 'C', now: NOW,
    }),
    tm2: insertTeam(db, {
      editionId: editions.ed1.id, name: '二队', captainId: users.captain2.id,
      taskPackageId: packages.tp2.id, now: NOW,
    }),
    tm3: insertTeam(db, {
      editionId: editions.ed2.id, name: '三队', captainId: users.captain3.id,
      taskPackageId: packages.tp3.id, now: NOW,
    }),
    // ⚠️ tm4 是**刻意的「不一致数据」**：队伍挂在 ed_2，却指向 ed_1 的任务包 tp_1。
    //    为什么要造这条脏数据：可见性的 `editionId` 过滤**只有**在这种数据下才可观测 ——
    //    正常的「跨届期队」本来就带着别的 task_package_id，光靠 taskPackageId 就已经挡住了，
    //    于是「漏掉 editionId 过滤」这个变异体在干净数据上**完全等价**（测不出来）。
    //    这条脏数据是 DDL 允许的（teams.edition_id 与 task_packages.edition_id 之间没有一致性约束），
    //    真实写入方 insertTeam 也照样能写出来。
    tm4: insertTeam(db, {
      editionId: editions.ed2.id, name: '四队', captainId: users.captain4.id,
      taskPackageId: packages.tp1.id, now: NOW,
    }),
  };

  insertTeamMember(db, { teamId: teams.tm1.id, userId: users.captain.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teams.tm1.id, userId: users.member.id, role: 'member', now: NOW });
  insertTeamMember(db, { teamId: teams.tm2.id, userId: users.captain2.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teams.tm3.id, userId: users.captain3.id, role: 'captain', now: NOW });
  insertTeamMember(db, { teamId: teams.tm4.id, userId: users.captain4.id, role: 'captain', now: NOW });

  const stage = insertStage(db, {
    editionId: editions.ed1.id, key: 's1', name: '调研', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'computed',
  });

  return { db, close, dataDir, users, editions, packages, teams, stage };
}

/** 在真实写入方的世界里建一条工作流 + 一个任务。 */
function seedWorldWorkflow(w) {
  const wf = workflow.createWorkflow({
    db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
    name: '风控助手工作流', actorId: w.users.captain.id, now: NOW,
  });
  const task = workflow.createWorkflowTask({
    db: w.db, workflowId: wf.id, title: '跑通风控模型', detail: '需要一个可演示的 demo',
    ownerTeamId: w.teams.tm1.id, dueAt: '2026-10-12', actorId: w.users.captain.id, now: NOW,
  });
  return { wf, task };
}

/** 一份合法的 kind=runnable 证据。 */
function runnableEvidence() {
  return {
    kind: 'runnable', summary: '模型已跑通，给出可演示的 demo',
    artifactUrl: 'https://git.example.com/demo/risk-model', version: 'v0.3.1',
  };
}

// ── 领域纯函数层：R-STG-04 的证据校验 ─────────────────────────────────

test('证据校验：kind 不是 runnable/blocked（如 progress）→ 不通过（只认「可运行」或「明确阻塞点」）', () => {
  const r = validateTaskEvidence({ kind: 'progress', summary: '还在做' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'kind'), JSON.stringify(r.errors));
});

test('证据校验：summary 为空或全是空白 → 不通过（纯文字进度说明不给分）', () => {
  const missing = validateTaskEvidence({ kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.field === 'summary'), JSON.stringify(missing.errors));

  const blank = validateTaskEvidence({
    kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1', summary: '   \n\t ',
  });
  assert.equal(blank.ok, false, '纯空白等于没写');
  assert.ok(blank.errors.some((e) => e.field === 'summary'), JSON.stringify(blank.errors));
});

test('证据校验：summary 长度边界 500 通过 / 501 不通过（判别性：两个阈值口径结果不同）', () => {
  const atLimit = validateTaskEvidence({
    kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1', summary: 'a'.repeat(500),
  });
  assert.equal(atLimit.ok, true, JSON.stringify(atLimit.errors));

  const overLimit = validateTaskEvidence({
    kind: 'runnable', artifactUrl: 'https://x.dev/a', version: 'v1', summary: 'a'.repeat(501),
  });
  assert.equal(overLimit.ok, false);
  assert.ok(overLimit.errors.some((e) => e.field === 'summary'), JSON.stringify(overLimit.errors));
});

test('证据校验：kind=runnable 缺 artifactUrl → 不通过（必须给出可运行产物）', () => {
  const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', version: 'v1' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'artifactUrl'), JSON.stringify(r.errors));
  // 判别性：「**缺**产物」与「产物**形态不对**」是两条不同的错误 ——
  // 只断言 field 会把两者混为一谈（错误文案是用户能看见的，必须能区分）。
  assert.ok(
    r.errors.some((e) => e.message.includes('必须给出可运行产物')),
    `缺产物的提示语必须是「必须给出可运行产物」，实际 ${JSON.stringify(r.errors)}`,
  );
  assert.equal(r.errors.filter((e) => e.field === 'artifactUrl').length, 1, '只报一条 artifactUrl 错误');
});

test('证据校验：kind=runnable 的 artifactUrl 必须够格（判别性：四种合法形态 vs 两种非法形态）', () => {
  // 合法：http(s) / ssh / git@ / 裸仓库路径 —— 四种都得放行
  for (const url of [
    'https://git.example.com/demo/risk-model', 'http://x.dev/a',
    'git@github.com:owner/risk-model.git', 'owner/risk-model',
  ]) {
    const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', artifactUrl: url, version: 'v1' });
    assert.equal(r.ok, true, `${url} 必须被接受：${JSON.stringify(r.errors)}`);
  }
  // 非法：既不是 http(s)/ssh/git@，也不是 owner/repo
  for (const url of ['not-a-url', 'file:///etc/passwd']) {
    const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', artifactUrl: url, version: 'v1' });
    assert.equal(r.ok, false, `${url} 必须被拒绝`);
    assert.ok(r.errors.some((e) => e.field === 'artifactUrl'), JSON.stringify(r.errors));
    // 判别性：形态不对的提示语与「缺产物」不同（两条错误不能混）
    assert.ok(
      r.errors.some((e) => e.message.includes('必须是 http(s) 链接')),
      `${url} 的提示语必须是「artifactUrl 必须是 http(s) 链接或 git 仓库地址」，实际 ${JSON.stringify(r.errors)}`,
    );
  }
});

test('证据校验：kind=runnable 缺 version → 不通过（S10 §3.4：提交须带版本记录 + 代码仓）', () => {
  const r = validateTaskEvidence({ kind: 'runnable', summary: '跑通了', artifactUrl: 'https://x.dev/a' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'version'), JSON.stringify(r.errors));
});

test('证据校验：kind=blocked 必须写明阻塞点与解除条件（缺一不可）', () => {
  const noReason = validateTaskEvidence({
    kind: 'blocked', summary: '卡住了', blocker: { needed: '企业出具《数据授权说明》' },
  });
  assert.equal(noReason.ok, false);
  assert.ok(noReason.errors.some((e) => e.field === 'blocker.reason'), JSON.stringify(noReason.errors));

  const noNeeded = validateTaskEvidence({
    kind: 'blocked', summary: '卡住了', blocker: { reason: '数据未授权' },
  });
  assert.equal(noNeeded.ok, false);
  assert.ok(noNeeded.errors.some((e) => e.field === 'blocker.needed'), JSON.stringify(noNeeded.errors));

  const good = validateTaskEvidence({
    kind: 'blocked', summary: '卡住了', blocker: { reason: '数据未授权', needed: '企业出具《数据授权说明》' },
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('证据校验：evidence 为 null / 非对象 → 不通过且不抛异常', () => {
  for (const ev of [null, undefined, '跑通了', 42]) {
    const r = validateTaskEvidence(ev);
    assert.equal(r.ok, false, `${JSON.stringify(ev) ?? 'undefined'} 必须不通过`);
    assert.ok(r.errors.length > 0);
  }
});

// ── 服务层：建工作流 / 建任务的入参与权限 ───────────────────────────────

test('建工作流：非该任务包的队员 → 403（不能替别人拆解工作流）', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
      name: '越权工作流', actorId: w.users.outsider.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
    '外单位用户不能拆解别人任务包的工作流',
  );
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
      name: '越权工作流', actorId: w.users.captain2.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
    '同届期但认领了别的任务包的队员也不能拆这一包',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建工作流：缺 editionId / taskPackageId → 400 EDITION_AND_PACKAGE_REQUIRED', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: null, taskPackageId: w.packages.tp1.id,
      name: '缺届期', actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'EDITION_AND_PACKAGE_REQUIRED',
  );
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: null,
      name: '缺任务包', actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'EDITION_AND_PACKAGE_REQUIRED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建工作流：name 为空白 → 400 NAME_REQUIRED', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflow({
      db: w.db, editionId: w.editions.ed1.id, taskPackageId: w.packages.tp1.id,
      name: '   ', actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'NAME_REQUIRED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：工作流不存在 → 404 WORKFLOW_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: 'wf_none', title: '任务', ownerTeamId: w.teams.tm1.id,
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'WORKFLOW_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：title 为空白 → 400 TITLE_REQUIRED', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: wf.id, title: '  ', ownerTeamId: w.teams.tm1.id,
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'TITLE_REQUIRED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：ownerTeamId 不存在 → 404 TEAM_NOT_FOUND', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: wf.id, title: '任务', ownerTeamId: 'tm_none',
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('建任务：给别的队建任务 → 403（不能给别人派活——那正是岗位制的入口）', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.createWorkflowTask({
      db: w.db, workflowId: wf.id, title: '给二队的活', ownerTeamId: w.teams.tm2.id,
      actorId: w.users.captain.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
    '一队队长不能给二队建任务',
  );
  cleanup(w.db, w.close, w.dataDir);
});

// ── 服务层：列任务清单的三态与可见性 ───────────────────────────────────

test('列任务：工作流不存在 → 404（单条不满足 → 404，不是空集）', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.listWorkflowTasks({ db: w.db, workflowId: 'wf_none', viewer: { id: w.users.captain.id } }),
    (err) => err.status === 404 && err.code === 'WORKFLOW_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：没有 viewer → 401', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: null }),
    (err) => err.status === 401,
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：组委会（超管）全可见（viewer 形状 = { id, is_superadmin }，与 permissions.js 精简对象同款）', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  const rows = workflow.listWorkflowTasks({
    db: w.db, workflowId: wf.id, viewer: { id: w.users.admin.id, is_superadmin: 1 },
  });
  assert.equal(rows.length, 1, '超管不看队也能看到任务清单');
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：可见性必须同时按届期与任务包隔离（判别性：三种「不可见」互不等价）', () => {
  const w = setupWorld();
  const { wf } = seedWorldWorkflow(w);
  const view = (id) => workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id } });

  // 同届期、**不同任务包**的队员 → 不可见（漏掉 taskPackageId 过滤就会露馅）
  assert.deepEqual(view(w.users.captain2.id), [], '同届期不同任务包 → 200 + 空集');
  // **下一届**的队员 → 不可见（漏掉 editionId 过滤就会露馅）
  assert.deepEqual(view(w.users.captain3.id), [], '跨届期 → 200 + 空集');
  // 外单位 → 不可见
  assert.deepEqual(view(w.users.outsider.id), [], '非本队成员 → 200 + 空集');
  // ⚠️ 脏数据队（挂在 ed_2 却指向 ed_1 的任务包 tp_1）→ 仍然不可见：
  //    届期隔离**优先于**任务包 —— 漏掉 editionId 过滤就会把它放进来。
  assert.deepEqual(view(w.users.captain4.id), [], '跨届期的队（即使指向同一个任务包）→ 200 + 空集');
  // 本队 → 可见
  assert.equal(view(w.users.member.id).length, 1, '本队成员可见');
  cleanup(w.db, w.close, w.dataDir);
});

test('列任务：领取人就是自己时 isMine=true（判别性：与「别人领的」结果不同）', () => {
  const w = setupWorld();
  const { wf, task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  const mine = workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id: w.users.captain.id } });
  assert.equal(mine[0].isMine, true, '自己领的必须 isMine=true');
  assert.equal(mine[0].claim.userId, w.users.captain.id);
  assert.equal(mine[0].claim.teamId, w.teams.tm1.id, '领取记录要带队伍');
  assert.equal(mine[0].claim.claimedAt, NOW, '领取记录要带领取时间');
  // 列表的**整条字段映射**也要钉住（判别性：任一字段被改成常量/空都会被抓住）
  assert.equal(mine[0].id, task.id);
  assert.equal(mine[0].workflowId, wf.id);
  assert.equal(mine[0].title, '跑通风控模型');
  assert.equal(mine[0].detail, '需要一个可演示的 demo');
  assert.equal(mine[0].ownerTeamId, w.teams.tm1.id);
  assert.equal(mine[0].status, 'in_progress');
  assert.equal(mine[0].dueAt, '2026-10-12');
  assert.equal(mine[0].createdAt, NOW);
  assert.equal(mine[0].completedAt, null, '还没完成时 completedAt 必须是 null');
  assert.equal(mine[0].completedBy, null, '还没完成时 completedBy 必须是 null');

  const other = workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id: w.users.member.id } });
  assert.equal(other[0].isMine, false, '别人领的必须 isMine=false');
  cleanup(w.db, w.close, w.dataDir);
});

// ── 服务层：自主领取 ───────────────────────────────────────────────────

test('领取：任务不存在 → 404 TASK_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: 'tk_none', userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TASK_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：任务已完成 → 409 TASK_ALREADY_DONE（已完成的不能再被领走）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
  });
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.member.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 409 && err.code === 'TASK_ALREADY_DONE',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：不是该队成员 → 403 NOT_TEAM_MEMBER（不能替别人队领取）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.outsider.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 403 && err.code === 'NOT_TEAM_MEMBER',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：队伍不存在 → 404 TEAM_NOT_FOUND', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: 'tm_none', now: NOW,
    }),
    (err) => err.status === 404 && err.code === 'TEAM_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：本人不在任何队伍且未指定 teamId → 400 NO_TEAM', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.outsider.id, now: NOW,
    }),
    (err) => err.status === 400 && err.code === 'NO_TEAM',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：未指定 teamId → 自动落到本人所在队（判别性：不能只认显式传入的队）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  const res = workflow.claimTask({ db: w.db, taskId: task.id, userId: w.users.member.id, now: NOW });
  assert.equal(res.claim.team_id, w.teams.tm1.id, '未指定队伍时必须落到本人所在队');
  assert.equal(res.claim.user_id, w.users.member.id);
  cleanup(w.db, w.close, w.dataDir);
});

test('领取：数据库唯一约束兜底 —— 唯一冲突必须被翻译成 409，而不是漏出裸 SQLite 错误', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  // ⛔ 为什么用触发器：唯一索引 ux_task_claims_active 在库里，但服务层的**前置检查**
  //    会先命中，catch 那条「最后一道防线」在串行测试里永远走不到。
  //    这里用触发器精确制造同样的 SQLITE_CONSTRAINT 错误（错误文本与唯一索引一致），
  //    验证「数据库拒绝 → 409 TASK_ALREADY_CLAIMED」这条翻译链真的接上了。
  w.db.exec(`
    CREATE TRIGGER ux_task_claims_active_sim BEFORE INSERT ON task_claims
    BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: task_claims.task_id'); END;
  `);
  assert.throws(
    () => workflow.claimTask({
      db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
    }),
    (err) => err.status === 409 && err.code === 'TASK_ALREADY_CLAIMED',
    '数据库的唯一冲突必须被翻译成 409（不能漏出裸 SQLite 错误）',
  );
  const row = w.db.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get(task.id);
  assert.equal(row.status, 'todo', '插入失败时任务状态不能被改成 in_progress');
  cleanup(w.db, w.close, w.dataDir);
});

/**
 * ★ 真并发用例（服务层）。
 *
 * 为什么不能只串行跑：串行的第二次必然被前置检查拦下 —— 那证明不了
 * 「并发下由数据库仲裁」。本用例用**两个 worker 线程 + 两条独立连接 + 屏障同步**
 * 让两次 claimTask **真正同时**发起，然后断言：恰好一个成功、另一个拿到
 * 409 TASK_ALREADY_CLAIMED、库里的有效领取永远只有一条。
 */
const CLAIM_WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from ${JSON.stringify(pathToFileURL(join(here, '..', 'src', 'db', 'sqlite.js')).href)};
import * as workflow from ${JSON.stringify(pathToFileURL(join(here, '..', 'src', 'services', 'workflow.js')).href)};
const { db, close } = openDatabase({ dataDir: workerData.dataDir });
parentPort.postMessage({ ready: true });
const barrier = new Int32Array(workerData.barrier);
Atomics.add(barrier, 0, 1);
while (Atomics.load(barrier, 0) < 2) {
  Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 20);
}
const t0 = Number(process.hrtime.bigint() / 1000000n);
let outcome;
try {
  const res = workflow.claimTask({
    db, taskId: workerData.taskId, userId: workerData.userId, teamId: workerData.teamId, now: workerData.now,
  });
  outcome = { ok: true, userId: res.claim.user_id };
} catch (err) {
  outcome = { ok: false, status: err && err.status, code: err && err.code, message: String(err && err.message) };
}
const t1 = Number(process.hrtime.bigint() / 1000000n);
close();
parentPort.postMessage({ ...outcome, t0, t1 });
`;

function spawnClaimWorker(workerData) {
  const worker = new Worker(CLAIM_WORKER_SRC, { eval: true, workerData });
  let resolveReady;
  let resolveDone;
  const ready = new Promise((r) => { resolveReady = r; });
  const done = new Promise((r) => { resolveDone = r; });
  worker.on('message', (m) => { if (m.ready) resolveReady(); else resolveDone(m); });
  worker.on('error', (err) => { resolveReady(); resolveDone({ ok: false, message: String(err && err.message) }); });
  return { ready, done };
}

test('领取：两人真并发抢同一任务 → 恰好一个成功、另一个 409，库中有效领取只有一条', async () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  // 先把主连接关掉：并发由 worker 持有的两条连接完成
  w.close();

  const barrier = new SharedArrayBuffer(4);
  const base = {
    dataDir: w.dataDir, barrier, taskId: task.id, teamId: w.teams.tm1.id, now: NOW,
  };
  const a = spawnClaimWorker({ ...base, userId: w.users.captain.id });
  await a.ready;                        // 连接 A 已建立
  const b = spawnClaimWorker({ ...base, userId: w.users.member.id });
  await b.ready;                        // 连接 B 已建立（错开建立，避开 WAL PRAGMA 抢锁）
  const [ra, rb] = await Promise.all([a.done, b.done]);

  const winners = [ra, rb].filter((r) => r.ok);
  const losers = [ra, rb].filter((r) => !r.ok);
  assert.equal(winners.length, 1, `恰好一条领取成功，实际 ${JSON.stringify([ra, rb])}`);
  assert.equal(losers.length, 1, `恰好一条被拒，实际 ${JSON.stringify([ra, rb])}`);
  assert.equal(losers[0].status, 409, '被拒的一方必须拿到 409');
  assert.equal(losers[0].code, 'TASK_ALREADY_CLAIMED', '被拒的一方必须是 TASK_ALREADY_CLAIMED');

  // 证明这**确实是并发**而不是被测试串行化：两次调用的时间区间必须重叠
  const earliest = Math.min(ra.t0, rb.t0);
  const latest = Math.max(ra.t1, rb.t1);
  assert.ok(earliest < latest, `两次领取必须重叠才叫并发，实际区间 ${earliest}~${latest}`);

  const { db: db2, close: close2 } = openDatabase({ dataDir: w.dataDir });
  const n = db2
    .prepare('SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND released_at IS NULL')
    .get(task.id).n;
  assert.equal(n, 1, '有效领取永远只有一条');
  close2();
  rmSync(w.dataDir, { recursive: true, force: true });
});

// ── 服务层：释放 ───────────────────────────────────────────────────────

test('释放：任务不存在 → 404 TASK_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.releaseTask({ db: w.db, taskId: 'tk_none', userId: w.users.captain.id, now: NOW }),
    (err) => err.status === 404 && err.code === 'TASK_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('释放：任务当前无人领取 → 409 TASK_NOT_CLAIMED', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.releaseTask({ db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW }),
    (err) => err.status === 409 && err.code === 'TASK_NOT_CLAIMED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

// ── 服务层：提交完成状态 ───────────────────────────────────────────────

test('完成：任务不存在 → 404 TASK_NOT_FOUND', () => {
  const w = setupWorld();
  assert.throws(
    () => workflow.completeTask({
      db: w.db, taskId: 'tk_none', userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
    }),
    (err) => err.status === 404 && err.code === 'TASK_NOT_FOUND',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：任务当前无人领取 → 409 TASK_NOT_CLAIMED', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  assert.throws(
    () => workflow.completeTask({
      db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
    }),
    (err) => err.status === 409 && err.code === 'TASK_NOT_CLAIMED',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：不是领取人 → 403 NOT_CLAIM_HOLDER（谁领的谁交）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  assert.throws(
    () => workflow.completeTask({
      db: w.db, taskId: task.id, userId: w.users.member.id, now: NOW, evidence: runnableEvidence(),
    }),
    (err) => err.status === 403 && err.code === 'NOT_CLAIM_HOLDER',
  );
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：completed_at 落库 = 注入的 now（判别性：时间戳必须来自入参，不是 Date.now()）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  const at = '2026-10-04T08:30:00.000Z';
  const res = workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, now: at, evidence: runnableEvidence(),
  });
  assert.equal(res.task.completed_at, at, '完成时间必须落库为传入的 now');
  assert.equal(res.task.completed_by, w.users.captain.id);
  assert.equal(res.task.status, 'done');
  // 列表投影也必须带出完成信息（判别性：completedAt/completedBy 不是常量 null）
  const rows = workflow.listWorkflowTasks({ db: w.db, workflowId: task.workflow_id, viewer: { id: w.users.captain.id } });
  assert.equal(rows[0].completedAt, at, '列表必须投影完成时间');
  assert.equal(rows[0].completedBy, w.users.captain.id, '列表必须投影完成人');
  assert.equal(rows[0].status, 'done');
  cleanup(w.db, w.close, w.dataDir);
});

test('完成：不写 points_ledger、不写 behavior_events、不写 tier_records（红线 ②：任务完成 ≠ 赛段交付物得分）', () => {
  const w = setupWorld();
  const { task } = seedWorldWorkflow(w);
  // 先用**真实写入方**造出三类分数载体（没有既存行的话，「行数不变」是恒真断言）
  insertLedgerEntry(w.db, {
    id: 'pl_seed', editionId: w.editions.ed1.id, stageId: w.stage.id, teamId: w.teams.tm1.id,
    userId: w.users.captain.id, kind: 'stage_rank', points: 10, createdAt: NOW,
  });
  insertBehaviorEvent(w.db, {
    id: 'be_seed', teamId: w.teams.tm1.id, userId: w.users.captain.id,
    type: 'weekly_progress', points: 3, evidence: '{"repo":"https://x.dev/a"}', createdAt: NOW,
  });
  const before = {
    ledger: w.db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n,
    behavior: w.db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n,
    tiers: w.db.prepare('SELECT COUNT(*) AS n FROM tier_records').get().n,
  };
  assert.ok(before.ledger > 0 && before.behavior > 0, '前提：分数载体必须先有既存行，否则断言恒真');

  workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, teamId: w.teams.tm1.id, now: NOW,
  });
  workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.captain.id, now: NOW, evidence: runnableEvidence(),
  });

  const after = {
    ledger: w.db.prepare('SELECT COUNT(*) AS n FROM points_ledger').get().n,
    behavior: w.db.prepare('SELECT COUNT(*) AS n FROM behavior_events').get().n,
    tiers: w.db.prepare('SELECT COUNT(*) AS n FROM tier_records').get().n,
  };
  assert.deepEqual(after, before, '任务完成不得写任何分数载体（points_ledger / behavior_events / tier_records）');
  cleanup(w.db, w.close, w.dataDir);
});

// ── 两条红线 ───────────────────────────────────────────────────────────

test('禁止岗位制：数据列层面也没有「岗位 / 身份」列（PRAGMA table_info）', () => {
  const w = setupWorld();
  // ⛔ R-OPS-14：任务**只有** claimTask 一条获得路径。
  //    owner_team_id 是「任务清单归哪支队」（队维度），不是「谁担任什么岗位」（岗位维度）——
  //    它约束的是任务归属，不是领取资格；领取资格只由 claimTask 决定。
  const FORBIDDEN_COLUMNS = [
    'role', 'position', 'post', 'duty', 'job', 'seat',
    'assignee', 'assigned_to', 'assigned_user_id', 'owner_user_id', 'member_role',
  ];
  for (const table of ['workflow_tasks', 'task_claims']) {
    const cols = w.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const bad of FORBIDDEN_COLUMNS) {
      assert.equal(cols.includes(bad), false, `⛔ ${table} 不得有岗位/身份列 ${bad}（R-OPS-14 禁止岗位制）`);
    }
  }
  cleanup(w.db, w.close, w.dataDir);
});

test('真实写入方的数据照样跑通全链路（判别性：实现不得依赖手造种子的状态值）', () => {
  const w = setupWorld();
  // 真实写入方的 teams.status='forming'、task_packages.status='submitted'，
  // 而计划原种子里手写成 'active' / 'approved' ——
  // 一份偷偷按 status 过滤的实现，在手造种子里照样绿，在这里必红。
  const team = w.db.prepare('SELECT status FROM teams WHERE id = ?').get(w.teams.tm1.id);
  const pkg = w.db.prepare('SELECT status FROM task_packages WHERE id = ?').get(w.packages.tp1.id);
  assert.equal(team.status, 'forming', '前提：真实写入方产出的是 forming');
  assert.equal(pkg.status, 'submitted', '前提：真实写入方产出的是 submitted');

  const { wf, task } = seedWorldWorkflow(w);
  const rows = workflow.listWorkflowTasks({ db: w.db, workflowId: wf.id, viewer: { id: w.users.member.id } });
  assert.equal(rows.length, 1, '真实数据下任务清单照常可见');
  const claimed = workflow.claimTask({
    db: w.db, taskId: task.id, userId: w.users.member.id, teamId: w.teams.tm1.id, now: NOW,
  });
  assert.equal(claimed.task.status, 'in_progress');
  const done = workflow.completeTask({
    db: w.db, taskId: task.id, userId: w.users.member.id, now: NOW, evidence: runnableEvidence(),
  });
  assert.equal(done.task.status, 'done');
  cleanup(w.db, w.close, w.dataDir);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/workflow-service.test.js`
Expected: FAIL —— `Cannot find module '../src/services/workflow.js'`

- [ ] **Step 3: 创建 `src/domain/task-evidence.js`**

```javascript
// src/domain/task-evidence.js — 任务完成证据校验（纯函数）
//   ⚠️ 刻意【不叫 evidence.js】：P4 已占用 `src/domain/evidence.js`（R-AUD-04 证据三列去重，
//      是审计概念）。这里是 R-STG-04 的任务完成证据，是另一个东西。同名不同义会让
//      后写的阶段覆盖先写的模块 —— 这正是「同一动作在两份材料里被标成一手与二手」的同构风险。
// 依据：S10 §3.1「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」（R-STG-04）
//   + S10 §3.4 反作弊第 3 条「提交须带版本记录 + 代码仓」
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。
// ⚠️ 边界：这条规则原文是针对【赛段交付物打分】的。本阶段只用来约束
//    「任务清单的完成记录」，不产生任何分数（任务完成 ≠ 赛段交付物得分）。
export const EVIDENCE_KINDS = ['runnable', 'blocked'];

export function validateTaskEvidence(evidence, { maxSummaryLength = 500 } = {}) {
  const errors = [];
  const ev = evidence && typeof evidence === 'object' ? evidence : {};

  if (!EVIDENCE_KINDS.includes(ev.kind)) {
    errors.push({ field: 'kind', message: "kind 必须是 'runnable'（可运行）或 'blocked'（明确阻塞点）" });
  }

  const summary = typeof ev.summary === 'string' ? ev.summary.trim() : '';
  if (!summary) {
    errors.push({ field: 'summary', message: 'summary 不能为空（要说明这次提交了什么）' });
  } else if (summary.length > maxSummaryLength) {
    errors.push({ field: 'summary', message: `summary 不得超过 ${maxSummaryLength} 字` });
  }

  if (ev.kind === 'runnable') {
    const url = typeof ev.artifactUrl === 'string' ? ev.artifactUrl.trim() : '';
    if (!url) {
      errors.push({ field: 'artifactUrl', message: 'kind=runnable 必须给出可运行产物（链接或仓库地址）；纯文字进度说明不给分' });
    } else if (!isAcceptableArtifact(url)) {
      errors.push({ field: 'artifactUrl', message: 'artifactUrl 必须是 http(s) 链接或 git 仓库地址' });
    }
    const version = typeof ev.version === 'string' ? ev.version.trim() : '';
    if (!version) {
      errors.push({ field: 'version', message: 'kind=runnable 必须给出版本记录（S10 §3.4：提交须带版本记录 + 代码仓）' });
    }
  }

  if (ev.kind === 'blocked') {
    const blocker = ev.blocker && typeof ev.blocker === 'object' ? ev.blocker : {};
    const reason = typeof blocker.reason === 'string' ? blocker.reason.trim() : '';
    const needed = typeof blocker.needed === 'string' ? blocker.needed.trim() : '';
    if (!reason) errors.push({ field: 'blocker.reason', message: 'kind=blocked 必须写明阻塞点是什么' });
    if (!needed) errors.push({ field: 'blocker.needed', message: 'kind=blocked 必须写明解除阻塞需要什么' });
  }

  return { ok: errors.length === 0, errors };
}

function isAcceptableArtifact(url) {
  if (/^https?:\/\/\S+/i.test(url)) return true;
  if (/^(ssh:\/\/|git@)\S+/i.test(url)) return true;
  // 裸仓库路径：owner/repo
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url);
}
```

- [ ] **Step 4: 确认 `getTeam` 的来源（**P1 已建，本阶段不重复实现**）**

⚠️ 原写法是「追加 `getTeamById` 到 `src/db/repo/team-membership.js`」——
**该文件本阶段已不存在**（见 Task 1 Step 6 的 I-3 修正记录）。

`getTeam(db, id)` 由 **P1 的 `platform/src/db/repo/teams.js`** 提供，
与 P5 原来的 `getTeamById` **逐字相同**（含 SQL 与 `?? null`）：

```javascript
// src/db/repo/teams.js —— 由 P1 建立，本阶段【直接 import，不追加、不重建】
//   export function getTeam(db, id) {
//     return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
//   }
```

本阶段的 `src/services/workflow.js` 相应改为：

```javascript
import { getTeam, listTeamRows } from '../db/repo/teams.js';
import { hasActiveMembership, listMemberTeams } from '../db/repo/teamMembers.js';
```

（原来那行 `import { … } from '../db/repo/team-membership.js';` **整行删掉**。）

- [ ] **Step 5: 创建 `src/services/workflow.js`**

```javascript
// src/services/workflow.js — 工作流与任务清单服务
// 依据：INTERFACES.md §6（P5 产出）
//   R-OPS-13 任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成
//   R-OPS-14 禁止岗位制
//   R-STG-03 里程碑清单报名时固定 —— 里程碑与工作流任务【不共享表、不共享规则】
//   R-STG-04 提交须为可运行状态或明确阻塞点（边界：任务完成 ≠ 赛段交付物得分）
//
// R-OPS-14：禁止岗位制，任务只能自主领取。
// ⛔ 本模块刻意不提供任何「按岗位 / 身份分配任务」的函数或接口——那是【功能缺失】，不是遗漏。
//    依据：任务书 §六 AI 原生组织红线「严禁按岗位和身份分工」；
//          探月黑客松因岗位制失败：忙的忙死、闲的闲死、最后一个人说了算。
//    唯一能拿到任务的路径：claimTask（自主领取）。
import { randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { validateTaskEvidence } from '../domain/task-evidence.js';
import { getUserById } from '../db/repo/users.js';
import * as wfRepo from '../db/repo/workflows.js';
import * as claimRepo from '../db/repo/task-claims.js';
import { hasActiveMembership, listMemberTeams } from '../db/repo/teamMembers.js';
import { getTeam, listTeamRows } from '../db/repo/teams.js';

function nowIso(now) {
  return now ?? new Date().toISOString();
}

function requireUser(db, userId) {
  const user = getUserById(db, userId);
  if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录或账号已停用');
  return user;
}

/** 工作流可见性：认领了该任务包的队（及其成员）可见；管理员全可见。 */
function canViewWorkflow(db, viewer, workflow) {
  if (!viewer) return false;
  if (viewer.is_superadmin === 1) return true;
  const teams = listTeamRows(db, { editionId: workflow.edition_id, taskPackageId: workflow.task_package_id });
  return teams.some((t) => hasActiveMembership(db, t.id, viewer.id));
}

/**
 * 建工作流：把任务包拆成工作流。
 * 权限：认领了该任务包的队员（或组委会）才能拆解。
 */
export function createWorkflow({ db, editionId, taskPackageId, name, actorId, now }) {
  const at = nowIso(now);
  const actor = requireUser(db, actorId);
  if (!editionId || !taskPackageId) {
    throw appError(400, 'EDITION_AND_PACKAGE_REQUIRED', 'editionId 与 taskPackageId 必填');
  }
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title) throw appError(400, 'NAME_REQUIRED', '工作流名称必填');
  const teams = listTeamRows(db, { editionId, taskPackageId });
  const allowed = actor.is_superadmin === 1 || teams.some((t) => hasActiveMembership(db, t.id, actorId));
  if (!allowed) {
    throw appError(403, 'FORBIDDEN', '只有认领该任务包的队员（或组委会）才能拆解工作流');
  }
  return wfRepo.insertWorkflow(db, {
    id: randomUUID(), editionId, taskPackageId, name: title, now: at,
  });
}

/**
 * 建任务：工作流 → 任务清单。
 * 权限：只能给自己所在队建任务（避免"给别人派活"——那正是岗位制的入口）。
 */
export function createWorkflowTask({ db, workflowId, title, detail, ownerTeamId, dueAt, actorId, now }) {
  const at = nowIso(now);
  const actor = requireUser(db, actorId);
  const workflow = wfRepo.getWorkflow(db, workflowId);
  if (!workflow) throw appError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在');
  const taskTitle = typeof title === 'string' ? title.trim() : '';
  if (!taskTitle) throw appError(400, 'TITLE_REQUIRED', '任务标题必填');
  if (ownerTeamId) {
    const team = getTeam(db, ownerTeamId);
    if (!team) throw appError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    if (actor.is_superadmin !== 1 && !hasActiveMembership(db, ownerTeamId, actorId)) {
      throw appError(403, 'FORBIDDEN', '只能给自己所在的队建任务');
    }
  }
  return wfRepo.insertWorkflowTask(db, {
    id: randomUUID(),
    workflowId,
    title: taskTitle,
    detail: typeof detail === 'string' && detail.trim() ? detail.trim() : null,
    ownerTeamId: ownerTeamId ?? null,
    status: 'todo',
    dueAt: dueAt ?? null,
    now: at,
  });
}

/**
 * 列任务清单。
 * ⛔ 列表不满足 → 返回空数组（200 + 空集），不暴露"有但不给看"（三态状态码）。
 */
export function listWorkflowTasks({ db, workflowId, viewer }) {
  const workflow = wfRepo.getWorkflow(db, workflowId);
  if (!workflow) throw appError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在');
  if (!viewer) throw appError(401, 'UNAUTHENTICATED', '未登录');
  if (!canViewWorkflow(db, viewer, workflow)) return [];

  return wfRepo.listWorkflowTasksByWorkflow(db, workflowId).map((t) => {
    const claim = claimRepo.getActiveClaim(db, t.id);
    return {
      id: t.id,
      workflowId: t.workflow_id,
      title: t.title,
      detail: t.detail,
      ownerTeamId: t.owner_team_id,
      status: t.status,
      dueAt: t.due_at,
      createdAt: t.created_at,
      claim: claim
        ? { userId: claim.user_id, teamId: claim.team_id, claimedAt: claim.claimed_at }
        : null,
      isMine: Boolean(claim && claim.user_id === viewer.id),
      completedAt: t.completed_at,
      completedBy: t.completed_by,
    };
  });
}

/**
 * 自主领取任务（R-OPS-13 / R-OPS-14 的核心动作）。
 * ⛔ 并发安全靠数据库的部分唯一索引兜底：这里的前置检查只是"友好提示"，
 *    真正的保证在 ux_task_claims_active。
 */
export function claimTask({ db, taskId, userId, teamId, now }) {
  const at = nowIso(now);
  const user = requireUser(db, userId);
  const task = wfRepo.getWorkflowTask(db, taskId);
  if (!task) throw appError(404, 'TASK_NOT_FOUND', '任务不存在');
  if (task.status === 'done') throw appError(409, 'TASK_ALREADY_DONE', '任务已完成，不能再领取');

  const team = resolveTeam(db, userId, teamId);
  if (claimRepo.getActiveClaim(db, taskId)) {
    throw appError(409, 'TASK_ALREADY_CLAIMED', '任务已被他人领取');
  }

  let claim;
  try {
    claim = claimRepo.insertTaskClaim(db, {
      id: randomUUID(), taskId, teamId: team.id, userId, now: at,
    });
  } catch (err) {
    // ⛔ 最后一道防线：并发下两个请求都通过了上面的检查时，数据库会拒绝第二条
    if (String(err?.message ?? '').includes('UNIQUE constraint failed')) {
      throw appError(409, 'TASK_ALREADY_CLAIMED', '任务已被他人领取');
    }
    throw err;
  }
  wfRepo.updateWorkflowTaskStatus(db, taskId, 'in_progress');
  return { task: wfRepo.getWorkflowTask(db, taskId), claim };
}

/** 释放任务：把任务放回可领取池（R-OPS-14：谁领的谁放，不存在"上级指派"）。 */
export function releaseTask({ db, taskId, userId, now }) {
  const at = nowIso(now);
  requireUser(db, userId);
  const task = wfRepo.getWorkflowTask(db, taskId);
  if (!task) throw appError(404, 'TASK_NOT_FOUND', '任务不存在');
  const claim = claimRepo.getActiveClaim(db, taskId);
  if (!claim) throw appError(409, 'TASK_NOT_CLAIMED', '任务当前无人领取');
  if (claim.user_id !== userId) throw appError(403, 'NOT_CLAIM_HOLDER', '只能释放自己领取的任务');
  claimRepo.releaseTaskClaim(db, claim.id, at);
  wfRepo.updateWorkflowTaskStatus(db, taskId, 'todo');
  return { task: wfRepo.getWorkflowTask(db, taskId) };
}

/**
 * 提交完成状态（R-STG-04）。
 * ⚠️ 边界：只写任务清单的完成状态与证据，⛔ 不写 points_ledger / behavior_events，不产生任何分数。
 *    kind='runnable' → 任务 done；kind='blocked' → 任务 blocked（挂起等解除，不是完成）。
 */
export function completeTask({ db, taskId, userId, now, evidence }) {
  const at = nowIso(now);
  requireUser(db, userId);
  const task = wfRepo.getWorkflowTask(db, taskId);
  if (!task) throw appError(404, 'TASK_NOT_FOUND', '任务不存在');
  const claim = claimRepo.getActiveClaim(db, taskId);
  if (!claim) throw appError(409, 'TASK_NOT_CLAIMED', '任务当前无人领取，无法提交完成状态');
  if (claim.user_id !== userId) throw appError(403, 'NOT_CLAIM_HOLDER', '只能提交自己领取的任务');

  const check = validateTaskEvidence(evidence);
  if (!check.ok) {
    throw appError(
      400,
      'EVIDENCE_REQUIRED',
      '完成必须提交可运行状态或明确阻塞点（纯文字进度说明不给分）',
      { errors: check.errors },
    );
  }

  const status = evidence.kind === 'runnable' ? 'done' : 'blocked';
  wfRepo.completeWorkflowTask(db, taskId, {
    status,
    evidenceJson: JSON.stringify(evidence),
    completedAt: at,
    completedBy: userId,
  });
  return { task: wfRepo.getWorkflowTask(db, taskId) };
}

/** 领取人所在队：显式指定则校验成员身份；未指定则在本人所在队中选唯一的一支。 */
function resolveTeam(db, userId, teamId) {
  if (teamId) {
    const team = getTeam(db, teamId);
    if (!team) throw appError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    if (!hasActiveMembership(db, teamId, userId)) {
      throw appError(403, 'NOT_TEAM_MEMBER', '你不是该队成员，不能替该队领取任务');
    }
    return team;
  }
  const teams = listMemberTeams(db, userId);
  if (teams.length === 0) throw appError(400, 'NO_TEAM', '你还没有加入任何队伍');
  // ⚠️ P1 的部分唯一索引保证「同一人只能同时在一个战队」（idx_team_members_active），
  //    所以这里正常只会命中 1 支；>1 是防御性分支（上游若放开该约束，这里不会悄悄选错队）。
  if (teams.length > 1) throw appError(400, 'TEAM_AMBIGUOUS', '你在多支队伍里，请显式指定 teamId');
  return teams[0];
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/workflow-service.test.js`
Expected: PASS（49 个测试全过：workflow-service.test.js 49）

> **【2026-10-21 漂移审计修正 M-1】** **原来错在哪**：本计划两处「Expected: PASS」的条数声明
> 与代码块里实际的 `test(` 数量不符 —— `workflow-service.test.js` 声明 **11** 实为 **12**、
> `pools-sync.test.js` 声明 **8** 实为 **7**。
> **为什么错**：条数是**实施时的验收闸**。实施者跑出 12 个而计划写 11 个，会误判「测试缺失」
> 而去改测试代码迁就声明，或者干脆失去对闸的信任。
> **注意方向相反**：一处多 1、一处少 1 —— 说明是**手工维护漂移**，不是有意为之。
> **改成什么**：① 两个数字改成实测值；② 把本计划**全部 5 处** `Expected: PASS` 统一成
> `Expected: PASS（N 个测试全过：file N）` 的格式。
> **依据**：按「就近 `Run:` 行指向的测试文件 → 该文件的 fenced code block 内 `^test(` 出现次数」
> 逐个统计（与审计报告 M-1 同一口径），并在本次改动后**对五份计划全量复算**：
> 每一条 `Expected: PASS（N …）` 现已与代码块实测条数**逐条相等**。

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/domain/task-evidence.js src/services/workflow.js test/workflow-service.test.js
git commit -m "feat(P5): 任务清单与自主领取（禁止岗位制，R-OPS-14）

对应 R-OPS-13 / R-OPS-14 / R-STG-04：
- 唯一获得任务的路径是 claimTask；不提供任何按岗位分配任务的出口
- 完成必须给可运行状态或明确阻塞点，纯文字进度说明被拒
- 完成任务不写积分（任务完成 ≠ 赛段交付物得分）

测试 49 例（领域纯函数 / 权限与三态分支 / 真并发 / 两条红线断言 / 真实写入方形状）" \
  -- src/domain/task-evidence.js src/services/workflow.js test/workflow-service.test.js \
     ../docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md
```

---

### Task 3: 三池派生同步（幂等重建，不是增量累加）

**Files:**
- Create: `platform/rules/pools.json`
- Create: `platform/src/domain/pool-derive.js`
- Create: `platform/src/services/pools.js`
- Modify: `platform/src/config.js`（新增 `rules.pools` 命名空间 + fail-fast 校验）
- Test: `platform/test/pools-sync.test.js`

**Interfaces:**
- Consumes: Task 1 的仓储；P1 的 `teams` / `task_packages` / `registrations`；P2 的 `stages` / `stage_results`（只读）；P3 的 `points_ledger` / `tier_records`
- Produces（与 `INTERFACES.md` §6 逐字一致）：
  - `syncPoolProjects({ db, editionId, now })` → `{ editionId, inserted, updated, removed, total, at }`
  - `syncPoolTalents({ db, editionId, now })` → 同上
  - `syncPoolResources({ db, editionId, now })` → 同上
  - `listPoolProjects({ db, filter, viewer })` → `project[]`
  - `listPoolTalents({ db, filter, viewer })` → `talent[]`
  - `listPoolResources({ db, filter, viewer })` → `resource[]`
  - 领域纯函数：`derivePoolProjects(...)` / `derivePoolTalents(...)` / `derivePoolResources(...)` / `aggregatePersonalPoints(...)`

> **⚠️ 本 Task 的灵魂（派生值不冗余存储）**
> `pool_talents.total_points` 天然可从 `points_ledger` 派生（设计文档 §5.4：「不做冗余存储」）。
> 落法三条：
> ① **只有一个计算点**：`src/domain/pool-derive.js` 的 `aggregatePersonalPoints`，服务层不再自己求和；
> ② **同步是幂等重建**：按派生源全量重算并覆盖，⛔ 不是 `UPDATE ... SET points = points + x`；
> ③ **写完自检**：写入后用**同一个**纯函数重算比对，不一致即抛错（`POOL_TALENT_POINTS_MISMATCH`）。
> → 这样就杜绝了"两处算出不同结果"（本项目"同一动作在两份材料里被标成一手与二手"的同构风险）。

- [ ] **Step 1: 写失败的测试**

`platform/test/pools-sync.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  syncPoolProjects, syncPoolTalents, syncPoolResources,
  listPoolProjects, listPoolTalents, listPoolResources,
} from '../src/services/pools.js';
import {
  aggregatePersonalPoints, derivePoolProjects, derivePoolTalents, derivePoolResources,
} from '../src/domain/pool-derive.js';
import { computePersonalPoints } from '../src/domain/points.js';
import * as poolSourcesRepo from '../src/db/repo/pool-sources.js';
import { loadRules, validateRules } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

// 统一的注入时间：所有断言都基于它，时间口径才可复算
const NOW = '2026-10-20T00:00:00.000Z';
// 超管：读三池时不需要任何授权记录
const SUPER = { id: 'u_a', is_superadmin: 1, active: 1 };

function setup(extraSql = '') {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5pool-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000021', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_b', '乙', '13900000022', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_c', '丙', '13900000023', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z'),
           ('ed_2', '第二届', '杭州', '2027-10-01', '2027-10-31', '2027-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_2', 'ed_1', 'ent_2', '某零售', '门店补货助手', '人工盘点慢', '可演示原型', '能跑', 'B',
      'approved', 8, 'B', '对标试点', '对标试点协议', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_3', 'ed_1', 'ent_1', '某银行', '反欺诈评分', '欺诈识别难', '可演示原型', '能跑', 'B',
      'approved', 8, 'B', '对标试点', '对标试点协议', 1, 'u_a', '2026-10-01T00:00:00.000Z', NULL),
           ('tp_4', 'ed_2', 'ent_1', '某银行', '风控助手二代', '审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2027-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_b', 'tp_2', 'D', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_3', 'ed_2', '三队', 'u_a', 'tp_4', 'C', 'active', '2027-10-01T00:00:00.000Z', NULL);
    -- ⚠️ P1 建了部分唯一索引 idx_team_members_active(user_id) WHERE left_at IS NULL：
    --    「同一人只能同时在一个战队」。所以 u_a 离开第一届的队之后，才能进第二届的队。
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
           ('tm_2', 'u_b', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_3', 'u_a', 'captain', '2027-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '任务', 'initial', '2026-10-10', '2026-10-13', NULL, 'initial', 'computed'),
           ('st_3', 'ed_2', 's1', '调研', 'initial', '2027-10-01', '2027-10-10', NULL, 'initial', 'draft');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_3', 'st_2', 'tm_1', 1, 88.0, 86.0, 92.0, 0, 10, NULL, '2026-10-13T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL);
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z'),
           ('pl_2', 'ed_1', 'st_2', 'tm_1', 'u_a', 'mvp', 5, '2026-10-13T00:00:00.000Z'),
           ('pl_3', 'ed_2', 'st_3', 'tm_3', 'u_a', 'stage_rank', 8, '2027-10-10T00:00:00.000Z');
    INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
      level, level_final, decided_by, decided_at, decision_note, status, created_at, deleted_at)
    VALUES ('rg_1', 'ed_1', 'u_a', '{}', '{"direction":5,"capability":4,"collaboration":5}', 80,
      'S', 'S', 'u_c', '2026-10-01T00:00:00.000Z', NULL, 'registered', '2026-10-01T00:00:00.000Z', NULL);
  `);
  if (extraSql) db.exec(extraSql);
  return { db, close, dataDir };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

function snapshot(db) {
  return {
    projects: db.prepare('SELECT * FROM pool_projects ORDER BY edition_id, team_id').all(),
    talents: db.prepare('SELECT * FROM pool_talents ORDER BY edition_id, user_id').all(),
    resources: db.prepare('SELECT * FROM pool_resources ORDER BY edition_id, enterprise_id, kind').all(),
  };
}

function syncAll(db, now = NOW) {
  syncPoolProjects({ db, editionId: 'ed_1', now });
  syncPoolTalents({ db, editionId: 'ed_1', now });
  syncPoolResources({ db, editionId: 'ed_1', now });
}

function counts(result) {
  return {
    inserted: result.inserted, updated: result.updated, removed: result.removed, total: result.total,
  };
}

test('项目池从 teams + stage_results + tier_records 派生', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const rows = listPoolProjects({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 2);
  const t1 = rows.find((r) => r.teamId === 'tm_1');
  assert.equal(t1.title, '零售风控助手', '项目名来自任务包标题');
  assert.equal(t1.stageReached, 's2', 'stage_reached 取该队到达的最远赛段');
  assert.equal(t1.tier, 'C', 'tier 取段位记录');
  assert.equal(t1.businessValue, 1, 'business_value 取企业业务签字数');
  assert.ok(String(t1.summary).includes('一队'));
  assert.ok(String(t1.summary).includes('人工审批慢'), '摘要里带任务包痛点');
  const t2 = rows.find((r) => r.teamId === 'tm_2');
  assert.equal(t2.stageReached, 's1');
  assert.equal(t2.tier, 'D');
  assert.equal(t2.businessValue, 0, 'business_value 原样取企业业务签字数（不是恒为 1）');
  cleanup(db, close, dataDir);
});

test('人才池从 points_ledger 聚合，且积分是终生累计（R-RNK-10）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const rows = listPoolTalents({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 1, '没有积分记录的人不进人才池');
  const t = rows[0];
  assert.equal(t.userId, 'u_a');
  assert.equal(t.totalPoints, 23, '10 + 5 + 8（含第二届）= 终生累计 23');
  assert.equal(t.stagesJoined, 3, '参与过的赛段数按 distinct stage 算');
  assert.equal(t.skills.length, 3, '技能来自报名画像维度分');
  assert.deepEqual(
    t.skills.map((s) => s.key),
    ['capability', 'collaboration', 'direction'],
    '技能键按字典序（确定性排序）',
  );
  assert.equal(t.name, '甲', '档案名来自 users');
  assert.equal(t.org, '学堂', '所属单位来自 users');
  assert.equal(t.mbaStatus, 'mba');
  cleanup(db, close, dataDir);
});

test('资源池从 task_packages 按（企业 × 类型）分组', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  const rows = listPoolResources({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 3, '某银行的企业题 + 某银行的自由题 + 某零售的企业题');
  const bank = rows.filter((r) => r.enterpriseId === 'ent_1');
  assert.equal(bank.length, 2);
  assert.deepEqual(bank.map((r) => r.kind).sort(), ['enterprise_brief', 'free_brief']);
  cleanup(db, close, dataDir);
});

test('同步是幂等重建：连跑两次，三池内容完全一致', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const first = snapshot(db);
  syncAll(db);
  const second = snapshot(db);
  assert.deepEqual(second, first, '连跑两次同步结果必须一致');
  cleanup(db, close, dataDir);
});

test('同步是重建不是累加：改了积分流水，重跑同步后积分按新值重算', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const before = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a').p;
  assert.equal(before, 23);

  db.prepare('UPDATE points_ledger SET points = 3 WHERE id = ?').run('pl_1');
  syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-21T00:00:00.000Z' });

  const after = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a').p;
  assert.equal(after, 16, '3 + 5 + 8 = 16（重算）；若实现成累加会是 23');
  cleanup(db, close, dataDir);
});

test('派生值唯一真源：库里的 total_points 与积分流水聚合一致', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  const sum = db
    .prepare('SELECT COALESCE(SUM(points), 0) AS s FROM points_ledger WHERE user_id = ?')
    .get('u_a').s;
  assert.equal(row.p, sum, '人才池积分必须等于积分流水之和（唯一计算点）');
  cleanup(db, close, dataDir);
});

test('没有 pool:read 能力的用户读到空数组（列表不满足 → 200 + 空集）', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const rows = listPoolProjects({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_c', is_superadmin: 0, active: 1 },
  });
  assert.deepEqual(rows, []);
  cleanup(db, close, dataDir);
});

// ── 幂等重建的【判别性】用例 ────────────────────────────────────────
// 期望值「恰好相同」区分不出两种算法 ⇒ 这里比的是**第二次同步的计数**与**行身份**：
//   · 累加实现：第二次 inserted=0/updated=0，库里积分翻倍
//   · 删了重建：内容相同但 inserted=2、行 id 全变
//   · 真正的幂等重建：第二次 inserted=0/updated=N，行 id 不变，值不变

test('幂等判别性：第二次同步是覆盖（inserted=0, updated=N），第三次与第二次完全一致', () => {
  const { db, close, dataDir } = setup();
  const first = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(first), { inserted: 2, updated: 0, removed: 0, total: 2 });
  const second = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(
    counts(second),
    { inserted: 0, updated: 2, removed: 0, total: 2 },
    '第二次必须覆盖既有行，而不是再插一批',
  );
  const third = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(third), counts(second), '稳态：第三次与第二次的计数必须一致');
  cleanup(db, close, dataDir);
});

test('幂等判别性：重复同步后行 id 不变（是覆盖同一行，不是删了重建）', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const before = snapshot(db);
  syncAll(db);
  const after = snapshot(db);
  assert.equal(after.projects.length, before.projects.length);
  assert.deepEqual(
    after.projects.map((r) => r.id),
    before.projects.map((r) => r.id),
    '项目池行 id 必须稳定',
  );
  assert.deepEqual(
    after.talents.map((r) => r.id),
    before.talents.map((r) => r.id),
    '人才池行 id 必须稳定',
  );
  assert.deepEqual(
    after.resources.map((r) => r.id),
    before.resources.map((r) => r.id),
    '资源池行 id 必须稳定',
  );
  cleanup(db, close, dataDir);
});

test('幂等判别性：重复同步后积分不变（重建不是累加，不会变成 23+23=46）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  assert.equal(row.p, 23, '跑三次仍是 23：增量累加会得到 69');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_talents').get().n,
    1,
    '跑三次仍只有一行',
  );
  cleanup(db, close, dataDir);
});

test('人才池幂等判别性：第二次同步 inserted=0 / updated=1，行数不增', () => {
  const { db, close, dataDir } = setup();
  const first = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(first), { inserted: 1, updated: 0, removed: 0, total: 1 });
  const second = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(second), { inserted: 0, updated: 1, removed: 0, total: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pool_talents').get().n, 1);
  cleanup(db, close, dataDir);
});

test('同步结果回显注入的 now 与 editionId（时间口径可复算）', () => {
  const { db, close, dataDir } = setup();
  const r = syncPoolProjects({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(r.at, '2026-10-20T00:00:00.000Z');
  assert.equal(r.editionId, 'ed_1');
  const t = syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(t.at, '2026-10-20T00:00:00.000Z');
  const res = syncPoolResources({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(res.at, '2026-10-20T00:00:00.000Z');
  cleanup(db, close, dataDir);
});

// ── 移除路径（派生源变了就重跑同步，不做增量修补）──────────────────

test('派生源消失后重跑同步：该项目从项目池移除（removed 计数准确）', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  db.prepare('UPDATE teams SET deleted_at = ? WHERE id = ?').run('2026-10-19T00:00:00.000Z', 'tm_2');
  const second = syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  assert.deepEqual(counts(second), { inserted: 0, updated: 1, removed: 1, total: 1 });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_projects').get().n,
    1,
    '被软删的队伍对应的项目行必须消失',
  );
  cleanup(db, close, dataDir);
});

test('任务包被软删后重跑同步：资源池对应行被移除', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  db.prepare('UPDATE task_packages SET deleted_at = ? WHERE id = ?').run('2026-10-19T00:00:00.000Z', 'tp_3');
  const second = syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  assert.equal(second.removed, 1);
  assert.equal(second.total, 2);
  const rows = listPoolResources({ db, filter: { editionId: 'ed_1' }, viewer: SUPER });
  assert.equal(rows.filter((r) => r.kind === 'free_brief').length, 0, '自由题资源行必须消失');
  cleanup(db, close, dataDir);
});

test('积分流水被撤回后重跑同步：本人从本届人才池移除', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  db.prepare('DELETE FROM points_ledger WHERE id = ?').run('pl_1');
  db.prepare('DELETE FROM points_ledger WHERE id = ?').run('pl_2');
  const second = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.equal(second.removed, 1);
  assert.equal(second.total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pool_talents').get().n, 0);
  cleanup(db, close, dataDir);
});

test('段位记录有多条时，取 computed_at 最新的一条', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_3', 'tm_2', 'C', 3, 2, '[]', '2026-10-15T00:00:00.000Z', NULL);
  `);
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT tier, business_value FROM pool_projects WHERE team_id = ?').get('tm_2');
  assert.equal(row.tier, 'C', '后算的段位记录覆盖先算的');
  assert.equal(row.business_value, 2);
  cleanup(db, close, dataDir);
});

test('报名记录被软删后重跑同步：技能仍取有效的那一条', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json, raw_score,
      level, level_final, decided_by, decided_at, decision_note, status, created_at, deleted_at)
    VALUES ('rg_2', 'ed_1', 'u_a', '{}', '{"zzz":1}', 10, 'S', 'S', 'u_c',
      '2026-10-02T00:00:00.000Z', NULL, 'registered', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
  `);
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT skills_json FROM pool_talents WHERE user_id = ?').get('u_a');
  const skills = JSON.parse(row.skills_json);
  assert.deepEqual(
    skills.map((s) => s.key),
    ['capability', 'collaboration', 'direction'],
    '软删的报名画像不进技能',
  );
  cleanup(db, close, dataDir);
});

test('段位记录被软删后重跑同步：项目池回落到队伍自身的 tier', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  db.prepare('UPDATE tier_records SET deleted_at = ? WHERE id = ?').run('2026-10-19T00:00:00.000Z', 'tr_1');
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT tier, business_value FROM pool_projects WHERE team_id = ?').get('tm_1');
  assert.equal(row.tier, 'C', '软删段位记录后回落到 teams.tier');
  assert.equal(row.business_value, null, '没有段位记录就没有商业签字数（不臆造）');
  cleanup(db, close, dataDir);
});

// ── 届期隔离与终生口径 ──────────────────────────────────────────────

test('同一人在两届都有行时，积分在两行上完全相同（终生累计，不做两份算法）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_2', now: NOW });
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const rows = db.prepare('SELECT edition_id, total_points FROM pool_talents ORDER BY edition_id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.edition_id), ['ed_1', 'ed_2']);
  assert.deepEqual(
    rows.map((r) => r.total_points),
    [23, 23],
    '两届都是终生口径 23（若按届期算则是 15 与 8）',
  );
  cleanup(db, close, dataDir);
});

test('跨届期刷新：改了流水后只同步一届，同一人的另一届那行也必须跟着变', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_2', now: NOW });
  db.prepare('UPDATE points_ledger SET points = 20 WHERE id = ?').run('pl_3');
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const rows = db.prepare('SELECT edition_id, total_points FROM pool_talents ORDER BY edition_id').all();
  assert.deepEqual(
    rows.map((r) => r.total_points),
    [35, 35],
    '同一人在任何一行里的积分都必须相同（不做两份算法：10+5+20=35）',
  );
  cleanup(db, close, dataDir);
});

test('届期隔离：同步一届不会动到另一届的资源池', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  syncPoolResources({ db, editionId: 'ed_2', now: NOW });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_resources WHERE edition_id = ?').get('ed_1').n,
    3,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_resources WHERE edition_id = ?').get('ed_2').n,
    1,
  );
  // 再同步 ed_1：ed_2 的资源行一个都不能少
  syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_resources WHERE edition_id = ?').get('ed_2').n,
    1,
    '同步一届不能把另一届的资源行当成陈旧行删掉',
  );
  cleanup(db, close, dataDir);
});

test('届期隔离：同步一届不会动到另一届的项目池', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const ed1Before = db.prepare('SELECT id, title FROM pool_projects WHERE edition_id = ?').all('ed_1');
  syncPoolProjects({ db, editionId: 'ed_2', now: NOW });
  const ed1After = db.prepare('SELECT id, title FROM pool_projects WHERE edition_id = ?').all('ed_1');
  assert.deepEqual(ed1After, ed1Before, 'ed_1 的行一个都不该被 ed_2 的同步改到');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM pool_projects WHERE edition_id = ?').get('ed_2').n,
    1,
    'ed_2 只有三队一个项目',
  );
  cleanup(db, close, dataDir);
});

// ── 可见性 / 过滤 ────────────────────────────────────────────────────

test('有 edition 作用域授权的用户读得到本届时，读不到别届', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO capabilities (key, description) VALUES ('pool:read', '读取三池');
    INSERT INTO assignments (id, user_id, capability, scope_type, scope_id, granted_by, created_at)
    VALUES ('as_1', 'u_c', 'pool:read', 'edition', 'ed_1', 'u_a', '2026-10-01T00:00:00.000Z');
  `);
  syncAll(db);
  const viewer = { id: 'u_c', is_superadmin: 0, active: 1 };
  assert.equal(listPoolProjects({ db, filter: { editionId: 'ed_1' }, viewer }).length, 2);
  assert.deepEqual(listPoolProjects({ db, filter: { editionId: 'ed_2' }, viewer }), []);
  cleanup(db, close, dataDir);
});

test('被停用的用户读到空数组（列表不满足 → 空集，不给半截数据）', () => {
  const { db, close, dataDir } = setup();
  syncAll(db);
  const rows = listPoolTalents({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 0 },
  });
  assert.deepEqual(rows, []);
  cleanup(db, close, dataDir);
});

test('列表过滤：limit / userId / minPoints / enterpriseId / kind 生效', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_d', '丁', '13900000024', 'x', 'other', '外单位', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_4', 'ed_1', 'st_1', 'tm_2', 'u_d', 'stage_rank', 4, '2026-10-10T00:00:00.000Z');
  `);
  syncAll(db);
  const all = listPoolTalents({ db, filter: { editionId: 'ed_1' }, viewer: SUPER });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.userId), ['u_a', 'u_d'], '积分倒序');
  assert.equal(listPoolTalents({ db, filter: { editionId: 'ed_1', limit: 1 }, viewer: SUPER }).length, 1);
  assert.equal(listPoolProjects({ db, filter: { editionId: 'ed_1', limit: 1 }, viewer: SUPER }).length, 1);
  assert.equal(listPoolResources({ db, filter: { editionId: 'ed_1', limit: 2 }, viewer: SUPER }).length, 2);
  assert.deepEqual(
    listPoolTalents({ db, filter: { editionId: 'ed_1', userId: 'u_d' }, viewer: SUPER }).map((r) => r.userId),
    ['u_d'],
  );
  assert.deepEqual(
    listPoolTalents({ db, filter: { editionId: 'ed_1', minPoints: 10 }, viewer: SUPER }).map((r) => r.userId),
    ['u_a'],
  );
  assert.equal(
    listPoolResources({ db, filter: { editionId: 'ed_1', enterpriseId: 'ent_1' }, viewer: SUPER }).length,
    2,
  );
  assert.deepEqual(
    listPoolResources({ db, filter: { editionId: 'ed_1', kind: 'free_brief' }, viewer: SUPER })
      .map((r) => r.enterpriseId),
    ['ent_1'],
  );
  cleanup(db, close, dataDir);
});

// ── 规则口径（rules/pools.json 才是口径的唯一来源）───────────────────

test('规则口径：packageStatusFilter 只让白名单状态的任务包进资源池', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_5', 'ed_1', 'ent_3', '某保险', '理赔助手', '理赔慢', '可演示原型', '能跑', 'B',
      'submitted', 8, 'B', '对标试点', '对标试点协议', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL);
  `);
  const unfiltered = syncPoolResources({ db, editionId: 'ed_1', now: NOW });
  assert.equal(unfiltered.total, 4, '默认不过滤状态');
  const filtered = syncPoolResources({
    db, editionId: 'ed_1', now: NOW, rules: { pools: { packageStatusFilter: ['approved'] } },
  });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.removed, 1, '口径变了，被排除的行要移出去');
  const rows = listPoolResources({ db, filter: { editionId: 'ed_1' }, viewer: SUPER });
  assert.ok(!rows.some((r) => r.enterpriseId === 'ent_3'), '未审批的任务包不进资源池');
  cleanup(db, close, dataDir);
});

test('规则口径：rules.points.personal.atomicKinds 决定哪些 kind 计入积分', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({
    db,
    editionId: 'ed_1',
    now: NOW,
    // ⚠️ 口径的唯一规则来源是 rules.points.personal（不再是 rules.pools.talentPointKinds）
    rules: { points: { personal: { atomicKinds: ['stage_rank'], rollupKind: 'personal_rollup' } } },
  });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  assert.equal(row.p, 18, '口径外只剩 stage_rank：10 + 8 = 18（默认口径是 23）');
  cleanup(db, close, dataDir);
});

// ── 错误与写后自检 ───────────────────────────────────────────────────

test('editionId 缺失 → AppError 400（EDITION_REQUIRED）', () => {
  const { db, close, dataDir } = setup();
  const check = (e) => e?.status === 400 && e?.code === 'EDITION_REQUIRED';
  assert.throws(() => syncPoolProjects({ db, now: NOW }), check);
  assert.throws(() => syncPoolTalents({ db, now: NOW }), check);
  assert.throws(() => syncPoolResources({ db, now: NOW }), check);
  cleanup(db, close, dataDir);
});

test('写后自检：库里的积分被改坏时，同步必须抛错（派生值只能有一个计算点）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  // 用触发器模拟「写入路径与重算路径算出不同结果」——正常实现走不到这一步，
  // 这里钉住的是：写完之后**确实**会用同一个纯函数重算比对，不一致就报错。
  db.exec(`
    CREATE TRIGGER trg_corrupt AFTER UPDATE ON pool_talents
    BEGIN
      UPDATE pool_talents SET total_points = total_points + 1 WHERE rowid = NEW.rowid;
    END;
  `);
  assert.throws(
    () => syncPoolTalents({ db, editionId: 'ed_1', now: NOW }),
    (e) => e?.status === 500 && e?.code === 'POOL_TALENT_POINTS_MISMATCH',
  );
  cleanup(db, close, dataDir);
});

// ── 领域纯函数（唯一计算点本身）────────────────────────────────────

test('领域纯函数：aggregatePersonalPoints 以 rollup 为准，并与 atomic 冲突时显式告警', () => {
  const { byUser, warnings } = aggregatePersonalPoints({
    ledger: [
      { user_id: 'u_x', kind: 'stage_rank', points: 10, stage_id: 'st_1' },
      { user_id: 'u_x', kind: 'personal_rollup', points: 12, stage_id: 'st_2' },
    ],
  });
  assert.equal(byUser.u_x.total, 12, '有 rollup 行时以 rollup 为准');
  assert.equal(byUser.u_x.breakdown.atomic, 10);
  assert.equal(byUser.u_x.breakdown.rollup, 12);
  assert.equal(byUser.u_x.stagesJoined, 2);
  assert.ok(
    warnings.some((w) => w.code === 'points_ledger_kind_conflict' && w.userId === 'u_x'),
    '两种口径不一致必须显式告警，不能静默',
  );
});

test('领域纯函数：未知 kind 被忽略并显式告警', () => {
  const { byUser, warnings } = aggregatePersonalPoints({
    ledger: [{ user_id: 'u_x', kind: 'weird_kind', points: 99 }],
  });
  assert.equal(byUser.u_x.total, 0, '口径外的 kind 不计入');
  assert.ok(warnings.some((w) => w.code === 'points_kind_ignored' && w.kind === 'weird_kind'));
});

test('领域纯函数：没有赛段的流水不计入赛段数；数组型画像不算技能', () => {
  const agg = aggregatePersonalPoints({
    ledger: [
      { user_id: 'u_x', kind: 'stage_rank', points: 5, stage_id: 'st_1' },
      { user_id: 'u_x', kind: 'stage_rank', points: 3 },
    ],
  });
  assert.equal(agg.byUser.u_x.stagesJoined, 1, '没有赛段的流水不占赛段数');
  assert.equal(agg.byUser.u_x.total, 8, '积分照算');

  const { rows } = derivePoolTalents({
    users: [{ id: 'u_x', name: '甲', org: null, mba_status: 'other' }],
    ledger: [{ user_id: 'u_x', kind: 'stage_rank', points: 5 }],
    registrations: [{ user_id: 'u_x', dimension_scores_json: '[1,2]', created_at: '2026-10-01' }],
  });
  assert.deepEqual(rows[0].skills, [], '画像不是对象就没有技能');
});

test('领域纯函数：derivePoolTalents 对缺失用户与坏技能 JSON 显式告警', () => {
  const { rows, warnings } = derivePoolTalents({
    users: [{ id: 'u_y', name: '乙', org: null, mba_status: 'other' }],
    ledger: [
      { user_id: 'u_x', kind: 'stage_rank', points: 3 },
      { user_id: 'u_y', kind: 'stage_rank', points: 4 },
    ],
    registrations: [
      { user_id: 'u_y', dimension_scores_json: '{不是 JSON', created_at: '2026-10-01' },
    ],
  });
  assert.equal(rows.length, 1, '查不到档案的人不进人才池');
  assert.equal(rows[0].userId, 'u_y');
  assert.deepEqual(rows[0].skills, [], '坏 JSON 不炸，技能为空');
  assert.ok(warnings.some((w) => w.code === 'talent_user_missing' && w.userId === 'u_x'));
  assert.ok(warnings.some((w) => w.code === 'skills_parse_failed' && w.userId === 'u_y'));
});

test('领域纯函数：derivePoolProjects 在任务包缺失时用队名兜底，最远赛段按 starts_at 定', () => {
  const rows = derivePoolProjects({
    teams: [{ id: 'tm_9', name: '九队', task_package_id: 'tp_missing', tier: 'C' }],
    packages: [],
    stageResults: [{ team_id: 'tm_9', stage_id: 'st_b' }, { team_id: 'tm_9', stage_id: 'st_a' }],
    stages: [
      { id: 'st_a', stage_key: 's1', starts_at: '2026-10-01' },
      { id: 'st_b', stage_key: 's2', starts_at: '2026-10-10' },
    ],
    tierRecords: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '九队', '任务包缺失时用队名兜底');
  assert.equal(rows[0].stageReached, 's2', '最远赛段按 starts_at 排序后取最远');
  assert.equal(rows[0].tier, 'C', '没有段位记录时用队伍自身的 tier');
  assert.equal(rows[0].businessValue, null);
});

test('领域纯函数：三个派生的排序都是确定性的（同一输入必得同一顺序）', () => {
  const projects = derivePoolProjects({
    teams: [
      { id: 'tm_2', name: '二队', task_package_id: 'tp_2', tier: 'D' },
      { id: 'tm_1', name: '一队', task_package_id: 'tp_1', tier: 'C' },
    ],
    packages: [],
    stageResults: [],
    stages: [],
    tierRecords: [],
  });
  assert.deepEqual(projects.map((r) => r.teamId), ['tm_1', 'tm_2'], '项目池按 teamId 升序');

  const talents = derivePoolTalents({
    users: [
      { id: 'u_b', name: '乙', org: null, mba_status: 'other' },
      { id: 'u_a', name: '甲', org: null, mba_status: 'mba' },
      { id: 'u_c', name: '丙', org: null, mba_status: 'other' },
    ],
    ledger: [
      { user_id: 'u_b', kind: 'stage_rank', points: 5 },
      { user_id: 'u_a', kind: 'stage_rank', points: 3 },
      { user_id: 'u_c', kind: 'stage_rank', points: 5 },
    ],
    registrations: [],
  });
  assert.deepEqual(
    talents.rows.map((r) => r.userId),
    ['u_b', 'u_c', 'u_a'],
    '先按积分倒序；积分相同时按 userId 升序（并列也必须可复算）',
  );

  const resources = derivePoolResources({
    packages: [
      { id: 'tp_9', enterprise_id: 'ent_2', enterprise_name: '某零售', title: 'B', pain_point: 'p', is_free_brief: 1 },
      { id: 'tp_8', enterprise_id: 'ent_2', enterprise_name: '某零售', title: 'A', pain_point: 'p', is_free_brief: 0 },
    ],
  });
  assert.deepEqual(
    resources.map((r) => r.kind),
    ['enterprise_brief', 'free_brief'],
    '同一企业的两种类型按 kind 升序（与输入顺序无关）',
  );
});

// ── 规则配置的 fail-fast（rules/pools.json 是口径的唯一来源）─────────

test('仓库自带的 rules/pools.json 能通过 fail-fast 校验（配置本身是对的）', () => {
  const { rules } = loadRules(rulesDir);
  assert.equal(rules.pools.id, 'pools');
  assert.equal(rules.pools.workflow.claimMode, 'self_claim_only');
});

test('规则校验：claimMode 不是 self_claim_only 会被拒绝启动（R-OPS-14 禁止岗位制）', () => {
  const { rules } = loadRules(rulesDir);
  const errors = validateRules({
    ...rules,
    pools: { ...rules.pools, workflow: { claimMode: 'by_role' } },
  });
  assert.ok(
    errors.some((e) => e.includes('claimMode')),
    `必须报错（实际 ${JSON.stringify(errors)}）`,
  );
});

test('规则校验：publicTokenTtlDays / publicScopes / talentTotalScope / taskEvidence 不合规都拒绝启动', () => {
  const { rules } = loadRules(rulesDir);
  const bad = [
    [{ ...rules.pools, publicTokenTtlDays: 0 }, 'publicTokenTtlDays'],
    [{ ...rules.pools, publicScopes: ['leaderboard'] }, 'publicScopes'],
    [{ ...rules.pools, talentTotalScope: 'edition' }, 'talentTotalScope'],
    [{ ...rules.pools, taskEvidence: { ...rules.pools.taskEvidence, requireRunnableOrBlocker: false } }, 'requireRunnableOrBlocker'],
  ];
  for (const [pools, keyword] of bad) {
    const errors = validateRules({ ...rules, pools });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `${keyword} 不合规必须报错（实际 ${JSON.stringify(errors)}）`,
    );
  }
});

test('★ 规则校验：交叉引用必须真实存在（引用不存在的取值一律拒绝启动）', () => {
  const { rules } = loadRules(rulesDir);
  // packageStatusFilter 写错一个拼写 ⇒ 过滤掉**全部**任务包 ⇒ 资源池空掉且不报任何错
  const badPools = [
    [{ ...rules.pools, packageStatusFilter: ['apprved'] }, 'packageStatusFilter 含不存在的任务包状态'],
    [{ ...rules.pools, packageStatusFilter: 'approved' }, 'packageStatusFilter 必须是数组'],
    [{ ...rules.pools, resourceKinds: ['nope'] }, 'resourceKinds 含不存在的资源类型'],
    [{ ...rules.pools, resourceKinds: [] }, 'resourceKinds 必须是非空数组'],
  ];
  for (const [pools, keyword] of badPools) {
    const errors = validateRules({ ...rules, pools });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `必须报「${keyword}」（实际 ${JSON.stringify(errors)}）`,
    );
  }
  // 个人积分口径的规则来源（atomicKinds / rollupKind）必须指向真实的 kind
  const badPoints = [
    [{ ...rules.points, personal: { ...rules.points.personal, atomicKinds: [] } }, 'atomicKinds 必须是非空数组'],
    [{ ...rules.points, personal: { ...rules.points.personal, atomicKinds: ['nope'] } }, 'atomicKinds 含不存在的积分 kind'],
    [{ ...rules.points, personal: { ...rules.points.personal, rollupKind: '' } }, 'rollupKind 必须是非空字符串'],
    [{ ...rules.points, personal: { ...rules.points.personal, rollupKind: 'nope' } }, 'rollupKind 引用了不存在的积分 kind'],
  ];
  for (const [points, keyword] of badPoints) {
    const errors = validateRules({ ...rules, points });
    assert.ok(
      errors.some((e) => e.includes(keyword)),
      `必须报「${keyword}」（实际 ${JSON.stringify(errors)}）`,
    );
  }
});

test('领域纯函数：起始时间相同的赛段按 id 兜底定先后（与输入顺序无关）', () => {
  const rows = derivePoolProjects({
    teams: [{ id: 'tm_1', name: '一队', task_package_id: null, tier: 'C' }],
    packages: [],
    stageResults: [{ team_id: 'tm_1', stage_id: 'st_y' }, { team_id: 'tm_1', stage_id: 'st_x' }],
    stages: [
      { id: 'st_y', stage_key: 's9', starts_at: '2026-11-01' },
      { id: 'st_x', stage_key: 's8', starts_at: '2026-11-01' },
    ],
    tierRecords: [],
  });
  assert.equal(rows[0].stageReached, 's9', '同起始时间时按赛段 id 定先后（st_x < st_y）');
});

test('领域纯函数：derivePoolResources 跳过软删的任务包', () => {
  const rows = derivePoolResources({
    packages: [
      {
        id: 'tp_1', enterprise_id: 'ent_1', enterprise_name: '某银行', title: 'A', pain_point: 'p1', is_free_brief: 0,
      },
      {
        id: 'tp_2', enterprise_id: 'ent_1', enterprise_name: '某银行', title: 'B', pain_point: 'p2', is_free_brief: 0, deleted_at: '2026-10-02',
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, 'A：p1', '软删的任务包不计入资源池（明细里只剩没软删的那条）');
  assert.equal('packageCount' in rows[0], false, '契约的 pool_resources 没有这一列 ⇒ 不再产出算了就丢的字段');
});

// ═══════════════════════════════════════════════════════════════════
// P5 Task 3 修复轮（verifier 审查修复）新增用例
//   · I-2：同刻并列的确定性（段位记录 / 报名记录）
//   · I-1：变异口径的判别性用例（探针固定装置里原本缺的判别输入）
//   · I-3：个人积分口径唯一化后的跨模块一致性
//   · M-1：写后自检必须在事务内（不一致 ⇒ 回滚，脏值不落地）
//   · M-2：跨届期连带写入要单独计数
// ═══════════════════════════════════════════════════════════════════

// ── I-2：同刻并列的确定性 ───────────────────────────────────────────

test('★ 同刻的段位记录：按 rowid（写入次序）定先后，结果唯一且可复算', () => {
  // ⚠️ 两条 computed_at **完全相同**的段位记录，且 id 的字典序与插入次序**故意相反**：
  //    先插 'z-first-inserted'（字典序最大），后插 'a-second-inserted'（字典序最小）。
  //    ⇒ 「按 id 排」会选中 z-first，「按插入次序排」会选中 a-second，两种实现结果不同
  //    ⇒ 断言有判别力（不是「恰好相同」的无效断言）。
  const { db, close, dataDir } = setup(`
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count,
                              reasons_json, computed_at, deleted_at)
    VALUES ('z-first-inserted', 'tm_1', 'A', 9, 9, '[]', '2026-10-20T00:00:00.000Z', NULL),
           ('a-second-inserted', 'tm_1', 'B', 5, 5, '[]', '2026-10-20T00:00:00.000Z', NULL);
  `);
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const row = db.prepare('SELECT tier, business_value FROM pool_projects WHERE team_id = ?').get('tm_1');
  assert.equal(row.tier, 'B', '同刻时取**后写入**的那条（rowid 兜底，与 repo/tiers.js 同口径）');
  assert.equal(row.business_value, 5, '商业签字数跟着同一条走');
  assert.notEqual(row.tier, 'A', '不能按 id 字典序选（那是随机 UUID 排出来的顺序，不可复算）');
  // 再同步一次：结果必须稳定（幂等重建，不是「碰巧这次对了」）
  syncPoolProjects({ db, editionId: 'ed_1', now: NOW });
  const again = db.prepare('SELECT tier FROM pool_projects WHERE team_id = ?').get('tm_1');
  assert.equal(again.tier, 'B', '重跑一次结果不变');
  cleanup(db, close, dataDir);
});

test('★ 同刻的段位记录：结果与入参顺序无关（兜底键由行内 rowid 决定）', () => {
  const tierRecords = [
    { team_id: 'tm_1', tier: 'A', business_signoff_count: 9, computed_at: '2026-10-20T00:00:00.000Z', rowid: 11 },
    { team_id: 'tm_1', tier: 'B', business_signoff_count: 5, computed_at: '2026-10-20T00:00:00.000Z', rowid: 12 },
  ];
  const teams = [{ id: 'tm_1', name: '一队', task_package_id: null, tier: 'C' }];
  const forward = derivePoolProjects({ teams, tierRecords });
  const backward = derivePoolProjects({ teams, tierRecords: [...tierRecords].reverse() });
  assert.equal(forward[0].tier, 'B', 'rowid 大的那条算数');
  assert.equal(backward[0].tier, 'B', '同一份数据换个顺序喂进来，结果必须一样');
  assert.deepEqual(forward[0], backward[0], '整个派生行都必须一样（不只是 tier）');
});

test('★ 同刻的报名记录：结果与入参顺序无关（兜底键由行内 rowid 决定）', () => {
  const registrations = [
    { user_id: 'u_x', dimension_scores_json: '{"b":2}', created_at: '2026-10-20T00:00:00.000Z', rowid: 21 },
    { user_id: 'u_x', dimension_scores_json: '{"a":1}', created_at: '2026-10-20T00:00:00.000Z', rowid: 22 },
  ];
  const base = {
    users: [{ id: 'u_x', name: '甲', org: null, mba_status: 'other' }],
    ledger: [{ user_id: 'u_x', kind: 'stage_rank', points: 5 }],
  };
  const forward = derivePoolTalents({ ...base, registrations });
  const backward = derivePoolTalents({ ...base, registrations: [...registrations].reverse() });
  assert.deepEqual(forward.rows[0].skills, [{ key: 'a', score: 1 }], 'rowid 大的那条算数');
  assert.deepEqual(forward.rows[0].skills, backward.rows[0].skills, '同一份数据换个顺序喂进来，技能画像必须一样');
});

test('同一人同一届最多一条有效报名（部分唯一索引）—— 同刻并列在真实数据上不可能出现', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => db.prepare(`
      INSERT INTO registrations (id, edition_id, user_id, answers_json, dimension_scores_json,
                                raw_score, level, level_final, decided_by, decided_at, decision_note,
                                status, created_at, deleted_at)
      VALUES ('rg_dup', 'ed_1', 'u_a', '{}', '{"a":1}', 10, 'S', 'S', 'u_c', '2026-10-01T00:00:00.000Z',
              NULL, 'registered', '2026-10-01T00:00:00.000Z', NULL)
    `).run(),
    /UNIQUE constraint failed/,
    '同一人同一届的有效报名只能有一条（这条约束是「同刻并列不可能出现」的根据）',
  );
  cleanup(db, close, dataDir);
});

// ── I-1：变异探针固定装置里原本缺的判别输入 ─────────────────────────

test('★ user_id 为空的流水行被跳过（不产出 null 键）', () => {
  // 真实写入方 src/db/repo/points.js 的 insertLedgerEntry 写的是 `userId ?? null`
  // ⇒ points_ledger.user_id 是**可空**列（schema 里没有 NOT NULL），这条流水真实存在。
  // 一旦不跳过，榜单上会多出一个 userId=null 的幽灵用户。
  const { byUser } = aggregatePersonalPoints({
    ledger: [
      { user_id: null, kind: 'stage_rank', points: 7 },
      { user_id: 'u_x', kind: 'stage_rank', points: 5 },
    ],
  });
  assert.deepEqual(Object.keys(byUser), ['u_x'], '空 user_id 的行不能造出一个 null 键');
  assert.equal(byUser.u_x.total, 5, '其余人的积分不受影响');
});

test('★ 画像分不是数字时按 0 计（不产生 NaN）', () => {
  const { rows } = derivePoolTalents({
    users: [{ id: 'u_x', name: '甲', org: null, mba_status: 'other' }],
    ledger: [{ user_id: 'u_x', kind: 'stage_rank', points: 5 }],
    registrations: [{ user_id: 'u_x', dimension_scores_json: '{"direction":"N/A"}', created_at: '2026-10-01' }],
  });
  assert.deepEqual(rows[0].skills, [{ key: 'direction', score: 0 }], '非数值画像分兜底 0，不是 NaN');
});

// ── I-3：个人积分口径唯一化后的跨模块一致性 ─────────────────────────

test('★ 跨模块一致性：榜单与人才池对同一份流水给出的每人 total 完全相同', () => {
  const { rules } = loadRules(rulesDir);
  const ledger = [
    { userId: 'u_x', kind: 'stage_rank', points: 10, stageId: 'st_1' },
    { userId: 'u_x', kind: 'personal_rollup', points: 12, stageId: 'st_2' },
    { userId: 'u_y', kind: 'weird', points: 99 },
  ];
  const agg = aggregatePersonalPoints({ ledger, pointsConfig: rules.points });
  const board = computePersonalPoints({ ledger, pointsConfig: rules.points });
  for (const row of board.rows) {
    const same = agg.byUser[row.userId];
    assert.ok(same, `人才池也必须有 ${row.userId}`);
    assert.equal(row.total, same.total, `${row.userId} 的 total 两边必须完全相同`);
  }
  assert.equal(agg.byUser.u_x.total, 12, '有 rollup 行时以 rollup 为准（12，不是 10+12）');
  assert.equal(agg.byUser.u_y.total, 0, '未知 kind 不计入');
  assert.equal(board.rows.find((r) => r.userId === 'u_y')?.total, 0, '未知 kind 在榜单上也不计入');
  assert.ok(!('null' in agg.byUser), '不产出 null 键');
  assert.deepEqual(
    board.rows.find((r) => r.userId === 'u_x').byKind,
    { stage_rank: 10, personal_rollup: 12 },
    '分项来源（byKind）必须真的给出来 —— 榜单要能看出分从哪来',
  );
  assert.equal(board.excludedEntries, 1, '口径外的那一行计入排除条数（不静默）');
});

test('★ 口径真的来自规则文件本身（rules/points.json 的 personal 组）', () => {
  const { rules } = loadRules(rulesDir);
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW, rules: { points: rules.points } });
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  // u_a 的流水：stage_rank 10 + mvp 5 + 另一届的 stage_rank 8 = 23
  assert.equal(row.p, 23, '按仓库自带的规则文件算，u_a 是 23（mvp 与 roadshow 都在白名单里）');
  cleanup(db, close, dataDir);
});

test('★ rollupKind 是配置项：真的被读到了（换成另一个合法 kind，口径就变）', () => {
  const { db, close, dataDir } = setup(`
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_ub_rank', 'ed_1', 'st_1', 'tm_2', 'u_b', 'stage_rank', 4, '2026-10-10T00:00:00.000Z'),
           ('pl_roll', 'ed_1', 'st_1', 'tm_2', 'u_b', 'mvp', 7, '2026-10-14T00:00:00.000Z');
  `);
  syncPoolTalents({
    db,
    editionId: 'ed_1',
    now: NOW,
    rules: { points: { personal: { atomicKinds: ['stage_rank', 'mvp'], rollupKind: 'mvp' } } },
  });
  // u_b 的流水：stage_rank 4 + mvp 7 —— rollupKind 指向 mvp ⇒ 以 mvp 之和（7）为准，不是 4+7
  const row = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_b');
  assert.equal(row.p, 7, 'rollupKind=mvp ⇒ 以 mvp 之和为准（rollupKind 必须真的被读到）');
  cleanup(db, close, dataDir);
});

test('★ 派生源读取必须把 rowid 带出来（域函数同刻并列的兜底键）', () => {
  const { db, close, dataDir } = setup();
  const tiers = poolSourcesRepo.listEditionTierRecords(db, 'ed_1');
  assert.equal(tiers.length, 2);
  for (const r of tiers) {
    assert.ok(Number.isFinite(r.rowid), '段位记录必须带 rowid —— 域函数靠它做同刻并列的显式比较');
  }
  const regs = poolSourcesRepo.listEditionRegistrations(db, 'ed_1');
  assert.equal(regs.length, 1);
  for (const r of regs) {
    assert.ok(Number.isFinite(r.rowid), '报名记录必须带 rowid');
  }
  cleanup(db, close, dataDir);
});

test('★ 派生源读取的排序：同刻并列必须有确定性兜底键（⛔ 不得用随机 UUID 的 id 列）', () => {
  // ⚠️ 这是**源码扫描**测试（不是行为测试）：排序键相等时 SQLite **不保证**返回顺序，
  //    而「不保证」的东西没法用行为断言钉住 —— 只能把「必须带兜底键」这条纪律本身钉住。
  //    背景：points_ledger / tier_records / registrations 的 id 列全是 randomUUID()
  //    （src/db/repo/points.js、tiers.js、registrations.js 的头部注释同款纪律），
  //    拿它当排序兜底键 ⇒ 同一批写入的记录顺序逐次运行都不同 ⇒ 不可复算。
  const src = readFileSync(join(here, '..', 'src', 'db', 'repo', 'pool-sources.js'), 'utf8');
  const orders = [...src.matchAll(/ORDER BY ([^\n`]+)/g)].map((m) => m[1].trim());
  assert.ok(orders.length >= 4, `扫描器必须真的扫到 ORDER BY（防「一条都不判违规」的假绿）：${JSON.stringify(orders)}`);
  for (const o of orders) {
    assert.ok(
      !/(computed_at|created_at)[^,]*,\s*id\s*$/.test(o),
      `ORDER BY ${o} 用了 id 列当兜底键 —— 那三张表的 id 是 randomUUID（顺序逐次运行都不同）`,
    );
  }
  for (const needle of [
    'ORDER BY tr.team_id, tr.computed_at, tr.rowid',
    'FROM registrations WHERE edition_id = ? ORDER BY user_id, created_at, rowid',
    'FROM points_ledger WHERE user_id = ? ORDER BY created_at, rowid',
  ]) {
    assert.ok(src.includes(needle), `pool-sources.js 必须保留确定性兜底键：${needle}`);
  }
});

// ── M-1：写后自检必须在事务内 ───────────────────────────────────────

test('★ 写后自检不一致时：脏值必须被回滚（自检在 withTransaction 内）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  const before = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  db.exec(`
    CREATE TRIGGER trg_corrupt AFTER UPDATE ON pool_talents
    BEGIN
      UPDATE pool_talents SET total_points = total_points + 1 WHERE rowid = NEW.rowid;
    END;
  `);
  assert.throws(
    () => syncPoolTalents({ db, editionId: 'ed_1', now: NOW }),
    (e) => e?.status === 500 && e?.code === 'POOL_TALENT_POINTS_MISMATCH',
  );
  const after = db.prepare('SELECT total_points AS p FROM pool_talents WHERE user_id = ?').get('u_a');
  assert.equal(
    after.p, before.p,
    '不一致时整批写入必须回滚 —— 自检在事务外的话，脏值已经提交了',
  );
  cleanup(db, close, dataDir);
});

// ── M-2：跨届期连带写入要单独计数 ───────────────────────────────────

test('同步计数：跨届期连带写入单独计数（updatedOtherEditions）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  // u_a 的积分流水跨 ed_1 / ed_2 两届 ⇒ 同步任一届都会把两届的行都刷新
  const second = syncPoolTalents({ db, editionId: 'ed_2', now: NOW });
  assert.equal(second.inserted, 1, '本届时新建一行');
  assert.equal(second.updated, 0, '本届时没有可更新的行');
  assert.equal(second.updatedOtherEditions, 1, '别届期被连带刷新的那一行单独计数（原来完全不计数）');
  const third = syncPoolTalents({ db, editionId: 'ed_1', now: NOW });
  assert.equal(third.updated, 1, '本届时那一行算 updated');
  assert.equal(third.updatedOtherEditions, 1, '别届期那一行算 updatedOtherEditions（不混进 updated）');
  cleanup(db, close, dataDir);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/pools-sync.test.js`
Expected: FAIL —— `Cannot find module '../src/services/pools.js'`

- [ ] **Step 3: 创建 `rules/pools.json`**

```javascript
{
  "id": "pools",
  "version": "2026-10-24",
  "source": "任务书 §九 三池沉淀 + §二 增长飞轮闭环 + S10 §3.3 个人积分终生上榜（R-RNK-10）+ S10 §3.4 反作弊第 3 条",
  "packageStatusFilter": [],
  "talentTotalScope": "lifetime",
  "resourceKinds": ["enterprise_brief", "free_brief"],
  "publicScopes": ["leaderboard", "calendar", "all"],
  "publicTokenTtlDays": 30,
  "taskEvidence": { "requireRunnableOrBlocker": true, "requireVersionTag": true, "maxSummaryLength": 500 },
  "workflow": { "claimMode": "self_claim_only" }
}
```

> `packageStatusFilter` 是空数组 = 不按 `task_packages.status` 过滤（只过滤软删除）。
> 理由：契约未给出 `status` 的取值枚举，猜错会让资源池"空得莫名其妙"或混入未审批任务包（见偏差章节 D-7）。P1 确认枚举后在这里填上即可，不改代码结构。

- [ ] **Step 4: 创建 `src/domain/pool-derive.js`**

```javascript
// src/domain/pool-derive.js — 三池派生纯函数
// 依据：设计文档 §5.4；R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池；R-RNK-10 个人积分终生上榜
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。所有时间与规则由参数传入。
//
// ⭐ 本文件是【三池派生值的唯一计算点】。
//    任何别处都不要再自己求一次个人积分 —— 那正是"两处算出不同结果"的温床。
//    （个人积分本身的口径已经收敛到 src/domain/pool-derive.js 之外的
//      src/domain/personal-points.js —— 本文件只做**委派**，不再自己实现一套口径。）

import { computePersonalTotals } from './personal-points.js';

/** 资源池的分组类型（企业题 / 自由题）—— 派生源的 is_free_brief 决定。
 *  依据：设计文档 §5.4「资源池 = 企业侧资源」+ R-POOL-03。 */
export const RESOURCE_KINDS = ['enterprise_brief', 'free_brief'];

function pick(row, camel, snake) {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

/**
 * 同刻（同时间戳）记录的兜底比较键。
 *
 * ⚠️ 为什么是 rowid 而不是 id：
 *    这三张表的 id 列**全是 randomUUID()**（src/db/repo/points.js、tiers.js、
 *    registrations.js 的头部注释都写明了「排序兜底键不得用随机 UUID」）。
 *    拿 randomUUID 当排序键 ⇒ 同一批写入的记录顺序逐次运行都不同 ⇒ 不可复算。
 *    rowid 是 SQLite 的**隐式行号 = 写入次序**：确定性、且与
 *    src/db/repo/tiers.js 的 `ORDER BY computed_at DESC, rowid DESC` 同一口径。
 */
function tiebreakOf(row) {
  const raw = row?.rowid;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 确定性字符串比较：按码位（code point）逐字符比。
 *
 * ⛔ 不用 localeCompare（Global Constraints「确定性排序」明确点名禁用）：
 *    localeCompare 的结果依赖运行环境的 ICU 数据与 locale —— 同一份数据在两台
 *    机器（或同一台机器的两个 locale）上可能排出**不同顺序** ⇒ 榜单不可复算。
 *    这与「破同分链必须以确定性键收尾」是同一条纪律（设计文档 §6.7）。
 */
function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * 个人积分聚合（R-RNK-10 终生上榜）—— **委派**给唯一计算点。
 *
 * ⚠️ 口径**不在本文件**：R-RNK-10 曾有两套独立实现（这里的 aggregatePersonalPoints
 *    与 src/domain/points.js 的 computePersonalPoints），读不同的规则文件、按不同的口径算，
 *    同一份流水能算出两个不同的名次。现在两边都委托 src/domain/personal-points.js。
 *
 * ledger: [{ userId, kind, points, stageId }]
 * 返回：{ byUser: { [userId]: { userId, total, stagesJoined, breakdown } }, warnings: [] }
 *   （输出形状与本 Task 最初交付时**逐字一致** —— services/pools.js 与既有测试不受影响）
 */
export function aggregatePersonalPoints({ ledger = [], pointsConfig = {} } = {}) {
  const { byUser, warnings } = computePersonalTotals({ ledger, pointsConfig });
  const out = {};
  for (const [userId, agg] of Object.entries(byUser)) {
    out[userId] = {
      userId,
      total: agg.total,
      stagesJoined: agg.stagesJoined,
      breakdown: agg.breakdown,
    };
  }
  return { byUser: out, warnings };
}

/** 项目池派生：teams + stage_results + tier_records（+ task_packages 取标题与痛点） */
export function derivePoolProjects({ teams = [], packages = [], stageResults = [], stages = [], tierRecords = [] } = {}) {
  const pkgById = new Map(packages.map((p) => [p.id, p]));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // 赛段先后顺序按 starts_at 排（拿不到 starts_at 的排最后）
  const orderedStages = [...stages].sort((a, b) => {
    const ax = String(a.startsAt ?? a.starts_at ?? '');
    const bx = String(b.startsAt ?? b.starts_at ?? '');
    if (ax === bx) return compareIds(a.id, b.id);
    return ax < bx ? -1 : 1;
  });
  const stageOrder = new Map(orderedStages.map((s, i) => [s.id, i]));

  const furthest = new Map();
  for (const r of stageResults) {
    const teamId = pick(r, 'teamId', 'team_id');
    const stageId = pick(r, 'stageId', 'stage_id');
    if (!teamId || !stageId) continue;
    const order = stageOrder.has(stageId) ? stageOrder.get(stageId) : -1;
    const prev = furthest.get(teamId);
    if (!prev || order > prev.order) furthest.set(teamId, { order, stageId });
  }

  const latestTier = new Map();
  for (const t of tierRecords) {
    if (pick(t, 'deletedAt', 'deleted_at')) continue;
    const teamId = pick(t, 'teamId', 'team_id');
    if (!teamId) continue;
    const at = String(pick(t, 'computedAt', 'computed_at') ?? '');
    // ⚠️ 同刻（computed_at 完全相同）的多条段位记录：靠 **rowid** 兜底。
    //    兜底键由【仓储层的 ORDER BY】保证（src/db/repo/pool-sources.js：
    //    ORDER BY tr.team_id, tr.computed_at, tr.rowid —— rowid = 写入次序，确定性、
    //    ⛔ 不是 randomUUID），域函数**不再依赖入参顺序**：
    //    它只按行内携带的 rowid 显式比较 ⇒ 同一份数据无论以什么顺序喂进来，结果都一样。
    //    （口径与 src/db/repo/tiers.js 的 `ORDER BY computed_at DESC, rowid DESC` 一致：
    //    同刻时**后写入**的那条算数。）
    const key = tiebreakOf(t);
    const prev = latestTier.get(teamId);
    if (!prev || at > prev.at || (at === prev.at && (key === null || prev.key === null || key >= prev.key))) {
      latestTier.set(teamId, {
        at,
        key,
        tier: t.tier ?? null,
        signoffs: Number(pick(t, 'businessSignoffCount', 'business_signoff_count') ?? 0),
      });
    }
  }

  const rows = [];
  for (const team of teams) {
    const pkg = pkgById.get(pick(team, 'taskPackageId', 'task_package_id'));
    const title = pkg?.title || team.name || String(team.id);
    const stage = furthest.get(team.id);
    const tierRec = latestTier.get(team.id);
    const pain = pkg ? pick(pkg, 'painPoint', 'pain_point') : null;
    const summary = `${team.name ?? ''}｜${title}${pain ? `｜${String(pain).slice(0, 200)}` : ''}`;
    rows.push({
      teamId: team.id,
      title,
      industry: null, // 一期无行业字段来源 → 显式 NULL（不臆造）
      stageReached: stage ? (stageById.get(stage.stageId)?.stage_key ?? null) : null,
      tier: tierRec?.tier ?? team.tier ?? null,
      businessValue: tierRec && Number.isFinite(tierRec.signoffs) ? tierRec.signoffs : null,
      summary,
    });
  }
  rows.sort((a, b) => compareIds(a.teamId, b.teamId));
  return rows;
}

/** 人才池派生：points_ledger 聚合 + users 取档案 + registrations 取技能画像 */
export function derivePoolTalents({ users = [], ledger = [], registrations = [], pointsConfig = {} } = {}) {
  const { byUser, warnings } = aggregatePersonalPoints({ ledger, pointsConfig });
  const userById = new Map(users.map((u) => [u.id, u]));

  const latestReg = new Map();
  for (const r of registrations) {
    if (pick(r, 'deletedAt', 'deleted_at')) continue;
    const userId = pick(r, 'userId', 'user_id');
    if (!userId) continue;
    const at = String(pick(r, 'createdAt', 'created_at') ?? '');
    // ⚠️ 同刻（created_at 完全相同）的多条报名记录：兜底键同样是 **rowid**
    //    （仓储层 ORDER BY user_id, created_at, rowid 保证顺序；行内 rowid 让域函数
    //    显式比较 ⇒ 不依赖入参顺序）。
    //    注：同一人同一届**最多一条有效报名**（registrations 的部分唯一索引
    //    (user_id, edition_id) WHERE deleted_at IS NULL）⇒ 这条兜底在真实数据上
    //    不会被触发；留着是为了「万一有」时结果仍然确定，而不是靠运气。
    const key = tiebreakOf(r);
    const prev = latestReg.get(userId);
    if (!prev || at > prev.at || (at === prev.at && (key === null || prev.key === null || key >= prev.key))) {
      latestReg.set(userId, { at, key, reg: r });
    }
  }

  const rows = [];
  for (const [userId, agg] of Object.entries(byUser)) {
    const user = userById.get(userId);
    if (!user) {
      warnings.push({ code: 'talent_user_missing', userId });
      continue;
    }
    const reg = latestReg.get(userId)?.reg ?? null;
    const skills = parseSkills(reg ? pick(reg, 'dimensionScoresJson', 'dimension_scores_json') : null, warnings, userId);
    rows.push({
      userId,
      name: user.name ?? '',
      org: user.org ?? null,
      mbaStatus: pick(user, 'mbaStatus', 'mba_status') ?? null,
      totalPoints: agg.total,
      stagesJoined: agg.stagesJoined,
      skills,
    });
  }
  rows.sort((a, b) => b.totalPoints - a.totalPoints || compareIds(a.userId, b.userId));
  return { rows, warnings };
}

/** 资源池派生：task_packages（企业侧资源），按（企业 × 类型）分组 */
export function derivePoolResources({ packages = [] } = {}) {
  const groups = new Map();
  for (const p of packages) {
    if (pick(p, 'deletedAt', 'deleted_at')) continue;
    const enterpriseId = pick(p, 'enterpriseId', 'enterprise_id') ?? 'unknown';
    const kind = pick(p, 'isFreeBrief', 'is_free_brief') ? 'free_brief' : 'enterprise_brief';
    const key = `${enterpriseId}::${kind}`;
    if (!groups.has(key)) {
      groups.set(key, {
        enterpriseId,
        kind,
        enterpriseName: pick(p, 'enterpriseName', 'enterprise_name') ?? null,
        titles: [],
        details: [],
      });
    }
    const g = groups.get(key);
    if (p.title) g.titles.push(p.title);
    const pain = pick(p, 'painPoint', 'pain_point');
    if (pain) g.details.push(String(pain).slice(0, 500));
  }

  const rows = [];
  for (const g of groups.values()) {
    const detail = g.titles.length
      ? `${g.titles.join(' / ')}${g.details.length ? `：${g.details.join(' / ')}` : ''}`
      : null;
    rows.push({
      enterpriseId: g.enterpriseId,
      enterpriseName: g.enterpriseName,
      kind: g.kind,
      detail,
      // ⚠️ 这里**不再**产出 packageCount：
      //    契约 §6 的 pool_resources 列清单里没有这一列，仓储层也没有落库 ⇒
      //    算出来就是**算完即丢**（T3-C7 登记过的信息损失）。
      //    修法二选一：① 从派生结构去掉（本处，代价最小、契约零改动）；
      //              ② 给 pool_resources 增列并在仓储层落库 —— 那要改**已发布**的
      //                 006_pools.sql（迁移按版本号记账，改内容不会重跑 ⇒ 老库漂移）
      //                 或新增 007 迁移 + 改契约列清单 —— 与「本 Task 一列未动」相悖。
      //    结论：取①。条数没有真丢：detail 里已经带着全部标题（' / ' 分隔），
      //    条数可由它数出来。
    });
  }
  rows.sort((a, b) => compareIds(a.enterpriseId, b.enterpriseId) || compareIds(a.kind, b.kind));
  return rows;
}

function parseSkills(raw, warnings, userId) {
  if (!raw) return [];
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    warnings.push({ code: 'skills_parse_failed', userId });
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj)
    .sort()
    .map((key) => ({ key, score: Number(obj[key]) || 0 }));
}
```

- [ ] **Step 5: 创建 `src/services/pools.js`**

```javascript
// src/services/pools.js — 三池派生同步与只读查询
// 依据：INTERFACES.md §6（P5 产出）；设计文档 §5.4 三池底座
//   R-POOL-01 项目池 / R-POOL-02 人才池 / R-POOL-03 资源池 / R-POOL-04 增长飞轮闭环
//   R-RNK-10 个人积分终生上榜（积分口径见 rules/pools.json）
//   顶层文档 §3.1 S2 —— 一切按 edition（届期）隔离：多期多城复制不改表结构
//
// ⛔ 本阶段【只做底座，不做前台页面】（设计文档 §1.2）：只有仓储 + 同步服务 + 只读 API。
// ⛔ 同步是【幂等重建】：按派生源全量重算并覆盖，不是增量累加。
// ⛔ 派生值只有一个计算点：src/domain/pool-derive.js。
import { randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { derivePoolProjects, derivePoolTalents, derivePoolResources, aggregatePersonalPoints } from '../domain/pool-derive.js';
import * as poolRepo from '../db/repo/pools.js';
import * as srcRepo from '../db/repo/pool-sources.js';
// ⛔ 事务助手复用 P4 的 withTransaction（src/db/tx.js，SAVEPOINT），**不再自建一份**：
//    自建 BEGIN IMMEDIATE 的版本在「调用方已经开了事务」时会抛
//    "cannot start a transaction within a transaction"，而 Task 4 的
//    POST /api/pools/sync 极可能把同步包在别的事务里 —— 同一件事两处实现，
//    正是「同一动作在两份材料里被标成一手与二手」的同构风险。
//    依据：本计划偏差章节 F.2（P5 消费 P4 的 src/db/tx.js）；设计文档 §11「事务回滚，无部分写入」。
import { withTransaction } from '../db/tx.js';

function nowIso(now) {
  return now ?? new Date().toISOString();
}

function requireEdition(editionId) {
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  return editionId;
}

function packageStatuses(rules) {
  const list = rules?.pools?.packageStatusFilter;
  return Array.isArray(list) ? list : [];
}

/**
 * 项目池同步：teams + stage_results + tier_records → pool_projects。
 * 幂等：以（edition_id, team_id）为自然键 upsert，并删掉本届时不再成立的行。
 */
export function syncPoolProjects({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  const source = {
    teams: srcRepo.listEditionTeams(db, editionId),
    packages: srcRepo.listEditionPackages(db, editionId, { statuses: packageStatuses(rules) }),
    stageResults: srcRepo.listEditionStageResults(db, editionId),
    stages: srcRepo.listEditionStages(db, editionId),
    tierRecords: srcRepo.listEditionTierRecords(db, editionId),
  };
  const rows = derivePoolProjects(source);

  return withTransaction(db, () => {
    const existing = poolRepo.listPoolProjectRows(db, editionId);
    const byTeam = new Map(existing.map((r) => [r.team_id, r]));
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const prev = byTeam.get(row.teamId);
      if (prev) {
        poolRepo.updatePoolProject(db, prev.id, row);
        updated += 1;
      } else {
        poolRepo.insertPoolProject(db, {
          id: randomUUID(), editionId, ...row, now: at,
        });
        inserted += 1;
      }
      byTeam.delete(row.teamId);
    }
    let removed = 0;
    for (const stale of byTeam.values()) {
      poolRepo.deletePoolProject(db, stale.id);
      removed += 1;
    }
    return { editionId, inserted, updated, removed, total: rows.length, at };
  });
}

/**
 * 人才池同步：points_ledger 聚合 → pool_talents。
 * ⭐ 幂等重建：按派生源重算，不是累加。
 * ⭐ 同一用户所有届次的行一起刷新 → 同一人在任何一行里的积分都相同（不做"两份算法"）。
 * ⭐ 写完自检：用【同一个】纯函数重算比对，不一致即抛错。
 */
export function syncPoolTalents({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  // ⚠️ 个人积分口径的**唯一规则来源**是 rules.points（personal 组）：
  //    规则曾散在 rules.pools.talentPointKinds 与 rules.points.personal 两处，
  //    两处口径还不一样 ⇒ 现在只认 rules.points（见 src/domain/personal-points.js）。
  const pointsConfig = rules?.points;

  const editionUsers = srcRepo.listEditionUsers(db, editionId);
  const ledger = [];
  for (const u of editionUsers) ledger.push(...srcRepo.listUserLedger(db, u.id));

  const { rows, warnings } = derivePoolTalents({
    users: editionUsers,
    ledger,
    registrations: srcRepo.listEditionRegistrations(db, editionId),
    pointsConfig,
  });

  return withTransaction(db, () => {
    const allRows = poolRepo.listPoolTalentRows(db, null);
    const rowsOfUser = new Map();
    for (const r of allRows) {
      if (!rowsOfUser.has(r.user_id)) rowsOfUser.set(r.user_id, []);
      rowsOfUser.get(r.user_id).push(r);
    }
    let inserted = 0;
    let updated = 0;
    // 跨届期连带写入的计数：同一个人**别的届期**的行也被一起刷新了
    // （保证「同一人在任何一行里的积分都相同」）—— 这部分写入原来**不计数**，
    // 同步结果里看不见 ⇒ 误以为「什么都没写」。单列一个计数，不混进 updated。
    let updatedOtherEditions = 0;
    for (const row of rows) {
      const mine = rowsOfUser.get(row.userId) ?? [];
      const inThisEdition = mine.find((r) => r.edition_id === editionId);
      if (inThisEdition) {
        poolRepo.updatePoolTalent(db, inThisEdition.id, {
          name: row.name,
          org: row.org,
          totalPoints: row.totalPoints,
          mbaStatus: row.mbaStatus,
          stagesJoined: row.stagesJoined,
          skillsJson: JSON.stringify(row.skills),
        });
        updated += 1;
      } else {
        poolRepo.insertPoolTalent(db, {
          id: randomUUID(),
          editionId,
          userId: row.userId,
          name: row.name,
          org: row.org,
          totalPoints: row.totalPoints,
          mbaStatus: row.mbaStatus,
          stagesJoined: row.stagesJoined,
          skillsJson: JSON.stringify(row.skills),
          now: at,
        });
        inserted += 1;
      }
      // 同一用户其他届次的行一起刷新，保证"同一人在任何一行里的积分都相同"
      for (const other of mine) {
        if (other.edition_id === editionId) continue;
        poolRepo.updatePoolTalent(db, other.id, {
          name: row.name,
          org: row.org,
          totalPoints: row.totalPoints,
          mbaStatus: row.mbaStatus,
          stagesJoined: row.stagesJoined,
          skillsJson: JSON.stringify(row.skills),
        });
        updatedOtherEditions += 1;
      }
    }
    // 本届时不再成立的人（没有积分记录了）从本届时移除
    const alive = new Set(rows.map((r) => r.userId));
    let removed = 0;
    for (const r of allRows) {
      if (r.edition_id !== editionId) continue;
      if (alive.has(r.user_id)) continue;
      poolRepo.deletePoolTalent(db, r.id);
      removed += 1;
    }

    // ⭐ 唯一真源自检：写入后用【同一个】纯函数重算比对。
    // ⚠️ **必须在 withTransaction 回调内**：放在事务外时，事务已经 RELEASE，
    //    此时抛错只能让调用方看到 500，**脏值已经提交**（自检形同虚设）。
    //    放在事务内抛错 ⇒ SAVEPOINT 回滚 ⇒ 脏值一条都不落地。
    for (const r of poolRepo.listPoolTalentRows(db, editionId)) {
      const expect = aggregatePersonalPoints({
        ledger: srcRepo.listUserLedger(db, r.user_id),
        pointsConfig,
      }).byUser[r.user_id];
      if (!expect || Math.abs(expect.total - r.total_points) > 1e-9) {
        throw appError(
          500,
          'POOL_TALENT_POINTS_MISMATCH',
          `人才池积分与积分流水不一致：${r.user_id}（派生值必须只有一个计算点）`,
        );
      }
    }
    return {
      editionId, inserted, updated, updatedOtherEditions, removed, total: rows.length, at, warnings,
    };
  });
}

/** 资源池同步：task_packages → pool_resources（按企业 × 类型分组）。 */
export function syncPoolResources({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  const packages = srcRepo.listEditionPackages(db, editionId, { statuses: packageStatuses(rules) });
  const rows = derivePoolResources({ packages });

  return withTransaction(db, () => {
    const existing = poolRepo.listPoolResourceRows(db, editionId);
    const byKey = new Map(existing.map((r) => [`${r.enterprise_id}::${r.kind}`, r]));
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const key = `${row.enterpriseId}::${row.kind}`;
      const prev = byKey.get(key);
      if (prev) {
        poolRepo.updatePoolResource(db, prev.id, {
          enterpriseName: row.enterpriseName,
          kind: row.kind,
          detail: row.detail,
        });
        updated += 1;
      } else {
        poolRepo.insertPoolResource(db, {
          id: randomUUID(), editionId, ...row, now: at,
        });
        inserted += 1;
      }
      byKey.delete(key);
    }
    let removed = 0;
    for (const stale of byKey.values()) {
      poolRepo.deletePoolResource(db, stale.id);
      removed += 1;
    }
    return { editionId, inserted, updated, removed, total: rows.length, at };
  });
}

function canReadPool(db, viewer, editionId) {
  if (!viewer) return false;
  return can(viewer, 'pool:read', { scopeType: 'edition', scopeId: editionId }, db);
}

function applyLimit(rows, limit) {
  if (!Number.isInteger(limit) || limit <= 0) return rows;
  return rows.slice(0, limit);
}

/** 项目池只读查询。⛔ 列表不满足 → 空数组（200 + 空集）。 */
export function listPoolProjects({ db, filter = {}, viewer }) {
  if (!canReadPool(db, viewer, filter.editionId ?? null)) return [];
  const rows = poolRepo.listPoolProjectRows(db, filter.editionId ?? null);
  return applyLimit(rows, filter.limit).map((r) => ({
    id: r.id,
    editionId: r.edition_id,
    teamId: r.team_id,
    title: r.title,
    industry: r.industry,
    stageReached: r.stage_reached,
    tier: r.tier,
    businessValue: r.business_value,
    summary: r.summary,
  }));
}

/** 人才池只读查询。 */
export function listPoolTalents({ db, filter = {}, viewer }) {
  if (!canReadPool(db, viewer, filter.editionId ?? null)) return [];
  let rows = poolRepo.listPoolTalentRows(db, filter.editionId ?? null);
  if (filter.userId) rows = rows.filter((r) => r.user_id === filter.userId);
  if (Number.isFinite(filter.minPoints)) rows = rows.filter((r) => r.total_points >= filter.minPoints);
  return applyLimit(rows, filter.limit).map((r) => ({
    id: r.id,
    editionId: r.edition_id,
    userId: r.user_id,
    name: r.name,
    org: r.org,
    totalPoints: r.total_points,
    mbaStatus: r.mba_status,
    stagesJoined: r.stages_joined,
    skills: safeParse(r.skills_json),
  }));
}

/** 资源池只读查询。 */
export function listPoolResources({ db, filter = {}, viewer }) {
  if (!canReadPool(db, viewer, filter.editionId ?? null)) return [];
  let rows = poolRepo.listPoolResourceRows(db, filter.editionId ?? null);
  if (filter.enterpriseId) rows = rows.filter((r) => r.enterprise_id === filter.enterpriseId);
  if (filter.kind) rows = rows.filter((r) => r.kind === filter.kind);
  return applyLimit(rows, filter.limit).map((r) => ({
    id: r.id,
    editionId: r.edition_id,
    enterpriseId: r.enterprise_id,
    enterpriseName: r.enterprise_name,
    kind: r.kind,
    detail: r.detail,
  }));
}

function safeParse(raw) {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: 修改 `src/config.js`（新增 `rules.pools`）**

在 `FILES` 里加一行：

```javascript
  pools: 'pools.json',
```

在 `grouped` 里加一行：

```javascript
    pools: rules.pools,
```

> **【2026-10-21 漂移审计修正 I-2】** **version 一致性校验这一步【不需要改】** ——
> 原计划隐含的「新增规则文件要同步加进 `versionValues` 数组」**不适用**（那个数组已经不存在了）。
> **原来错在哪**：P0 终审时的 `src/config.js` 里，version 全等校验是**硬编码的 9 项列表**
> + 硬编码的 `9`；新增的规则文件即使注册进 `FILES` / `grouped`，它的 `version`
> **从不参与比较**（审计实跑：注入异版本号 → `validateRules` **零报错**）→
> 「版本号漂移 = 审计链在说谎」这条被打破。
> **现状（基线已修好）**：基线的 `src/config.js` 已改成
> `validateRules(rules, expectedCount = null)` **按「有 id 的是一份配置」自动派生**
> （`collectConfigObjects`），`expectedCount` 由 `loadRules()` 传 `Object.keys(FILES).length`
> → **加多少份配置都自动覆盖**，P5 不需要改 version 校验。
> **改成什么**：本步**只**做三件事 —— ① `FILES` 加 `pools`；② `grouped` 加 `pools`；
> ③ `validateRules` 末尾追加 pools 的**内容**校验段。version 校验一个字都不动。
> **⚠️ 硬前提**：`rules/pools.json` **必须带 `"id": "pools"`**（识别「一份配置」用的是 `id`
> 而不是 `version`；`collectConfigObjects` 命中配置对象即 `return`，**嵌套对象里的 `id` 不算**）。
> **份数以【本分支实测】为准**：P5 分支上 `FILES` 是 **15** 份
> （P0 的 9 + P1 的 3 + P3 的 2 + P5 的 1）—— **P4 的 `rules.audit` 还没并进本分支**
> （P4 只并进来了 `src/db/tx.js` 与反作弊检测器，`src/config.js` 的 `rules.audit` 命名空间
> 与 `rules/audit.json` 留在 P4 分支上）。识别到的配置份数必须与 `Object.keys(FILES).length`
> 一致（= 15），否则报「规则配置应有 15 份，实际只识别到 N 份」→ **拒绝启动**。
> ⚠️ **份数是自动派生的**（`validateRules(rules, expectedCount)` 的 `expectedCount`
> 来自 `Object.keys(FILES).length`）→ **P4 合回 main 时这里不需要改任何代码**，
> 份数会自己从 15 变成 16。**不要把份数硬编码进本计划或代码。**
> **依据**：基线 `platform/src/config.js` + 漂移审计报告 I-2 与 D-3 + 本分支实测
> （`Object.keys(FILES).length` = 15）。

在 `validateRules()` 的 `return errors;` 之前追加：

```javascript
  // ── 三池与工作流（P5）────────────────────────────────────────────
  const pools = rules.pools;
  if (!pools) {
    errors.push('pools 缺失');
  } else {
    // R-OPS-14：禁止岗位制——claimMode 只允许 self_claim_only，写别的值直接拒绝启动
    if (pools.workflow?.claimMode !== 'self_claim_only') {
      errors.push('pools.workflow.claimMode 必须是 self_claim_only（R-OPS-14 禁止岗位制，不允许其他取值）');
    }
    if (!Number.isInteger(pools.publicTokenTtlDays) || pools.publicTokenTtlDays <= 0) {
      errors.push('pools.publicTokenTtlDays 必须是正整数');
    }
    if (!Array.isArray(pools.publicScopes) || !pools.publicScopes.includes('all')) {
      errors.push('pools.publicScopes 必须包含 all');
    }
    // ⚠️ 交叉引用校验：配置里写的取值必须**真实存在**。
    //    原来这一段只校验「形状」，不校验「引用」：
    //    · packageStatusFilter 里写错一个 status 拼写 → 过滤掉**全部**任务包
    //      → 资源池空掉，而且**不报任何错**（空集是合法结果）；
    //    · resourceKinds 写错 → 与派生端（RESOURCE_KINDS）对不上，配置在骗人。
    if (!Array.isArray(pools.packageStatusFilter)) {
      errors.push('pools.packageStatusFilter 必须是数组（空数组 = 不按状态过滤）');
    } else {
      for (const st of pools.packageStatusFilter) {
        if (!TASK_PACKAGE_STATUSES.includes(st)) {
          errors.push(
            `pools.packageStatusFilter 含不存在的任务包状态：${st}`
            + `（合法取值：${TASK_PACKAGE_STATUSES.join(' / ')}）`,
          );
        }
      }
    }
    if (!Array.isArray(pools.resourceKinds) || pools.resourceKinds.length === 0) {
      errors.push('pools.resourceKinds 必须是非空数组');
    } else {
      for (const k of pools.resourceKinds) {
        if (!RESOURCE_KINDS.includes(k)) {
          errors.push(
            `pools.resourceKinds 含不存在的资源类型：${k}`
            + `（合法取值：${RESOURCE_KINDS.join(' / ')}）`,
          );
        }
      }
    }
    if (pools.talentTotalScope !== 'lifetime') {
      errors.push('pools.talentTotalScope 必须是 lifetime（R-RNK-10 个人积分终生上榜）');
    }
    if (!pools.taskEvidence?.requireRunnableOrBlocker) {
      errors.push('pools.taskEvidence.requireRunnableOrBlocker 必须为 true（R-STG-04）');
    }
  }
```

### 增长飞轮闭环（R-POOL-04）在本阶段的落点

任务书 §二 的飞轮：**①更多 B 端出题 → ②更多创业者组队 → ③三池沉淀 → ④成果落地 → ⑤影响力扩散 → ⑥更多资源方加入 → 回①**。

⛔ **一期不跑这个飞轮**（首届只验机制，不验收入与规模；R-ENT-05）。本阶段只做两件事，且必须说清边界：

| 飞轮环节 | 一期的落点 | 一期**没有**做什么 |
|---|---|---|
| ① B 端出题 | `pool_resources`（企业侧资源，来自 `task_packages`） | 不做企业侧申报的前台页面 |
| ② 创业者组队 | `pool_projects`（来自 `teams`） | 不做组队撮合（二期：MILP） |
| **③ 三池沉淀** | **本阶段的核心**：`pool_projects` / `pool_talents` / `pool_resources` 三张表 + 幂等同步 | 不做三池前台（会变成"空池无内容"的死界面） |
| ④ 成果落地 | `pool_projects.business_value`（企业业务部门签字数，商业事实代理） | 首届不验收入（无收入口径） |
| ⑤ 影响力扩散 | **公开榜单 API + iCal 订阅**（无需登录、token 鉴权、可外链） | 不做对外站点与投放（P6 的公网演示版） |
| ⑥ 更多资源方加入 | `pool_resources` 的 `enterprise_id` 维度 | 不做资源方入驻流程 |

→ **可计量的部分**：每次 `POST /api/pools/sync` 返回 `inserted / updated / removed / total`，
逐届对比即可看出"这一届沉淀了多少项目、多少人才、多少资源方"——这是飞轮第③步唯一可观测的刻度。
**不可计量的部分**：①→② 与 ⑥→① 的转化率（缺数据），本阶段不假装能算。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/pools-sync.test.js`
Expected: PASS（**40** 个测试全过：pools-sync.test.js 40）

Run: `cd platform && node --test test/config.test.js`
Expected: PASS（**27** 个测试全过：config.test.js 27）——仓库自带的**全部 15 份**规则配置
（P0 的 9 + P1 的 3 + P3 的 2 + P5 的 1；**P4 的 `rules.audit` 还没并进本分支**）
加上本阶段的 `pools.json` 一起通过校验

> **【2026-10-21 漂移审计修正 M-2】**
> **原来错在哪**：这一行原来写的是
> `Expected: PASS（仓库自带的 9 份 + 本阶段的 \`pools.json\` 一起通过校验）` ——
> **「9 份」早就过期了**，而且格式不是任务要求的 `Expected: PASS（N 个测试全过：file N）`。
> **为什么错**：① 「9 份」是 P0 时的份数，P1 加了 3 份（`teamFormation` / `schedule` /
> `compliance`）、P3 加了 2 份（`points` / `criteria`）、P4 加了 1 份（`audit`）、
> P5 本阶段再加 1 份（`pools`）→ 到本阶段是 **9 + 3 + 2 + 1 + 1 = 16 份**。
> 照「9 份」写，实施者会以为规则配置**少了一大半**。
> ② 「条数声明」本身也不该靠人记 —— 改成实测条数。
> **改成什么**：改成 `Expected: PASS（23 个测试全过：config.test.js 23）` +
> 「全部 **16 份**规则配置一起通过校验」的说明。
> **依据**：基线 `platform/test/config.test.js` **23 条**（P0 建立、P1 未改条数）；
> 基线 `platform/src/config.js` 的 `FILES` 共 12 键（P0 的 9 + P1 的 3）→ 逐阶段累加得 16。
> ⚠️ **审计报告 M-2 自己写的「13 份」也漏算了 P1 的 3 份**（它按「P0 的 9 + P3 的 2 +
> P4 的 1 + P5 的 1」算）→ 本次按实际算 **16 份**，并在 P4 / P5 的 I-2 修正记录里
> 把份数算式一并订正（P3 = 14、P4 = 15、P5 = 16）。
> **旁证**：P1 已把 `test/config.test.js` 里的「9 份」措辞泛化为「全部规则配置」
> （3 处）—— 说明「份数」不该硬编码在测试名与文案里，本阶段沿用同一口径。
>
> **【2026-10-21 P5 Task 3 实跑修正】** 上面这段的**条数**是按**本分支实测**改写的：
> `test/config.test.js` 实跑 **27** 条（不是 23），`FILES` 实测 **15** 份（不是 16，
> 因为 **P4 的 `rules.audit` 命名空间与 `rules/audit.json` 还没并进 P5 分支**）。
> **份数不写进代码**（`expectedCount` 由 `Object.keys(FILES).length` 派生），
> 所以 P4 合回 main 时**这一段不需要改**，份数会自己变成 16。

- [ ] **Step 8: 提交**

```bash
cd platform && git add rules/pools.json src/domain/pool-derive.js src/services/pools.js src/config.js test/pools-sync.test.js
git commit -m "feat(P5): 三池派生同步（幂等重建 + 派生值唯一计算点）

对应 R-POOL-01 / R-POOL-02 / R-POOL-03 / R-RNK-10：
- syncPool* 按派生源全量重算覆盖，连跑两次结果一致
- personal_points 只有一个计算点，写后自检，不一致即报错
- 个人积分终生累计；无 pool:read 能力读到空数组"
```

---

### Task 4: 公开榜单 API + token 鉴权（显式过可见性过滤）

**Files:**
- Create: `platform/src/services/public-api.js`
- Create: `platform/src/http/routes/workflow.js`
- Create: `platform/src/http/routes/pools.js`
- Create: `platform/src/http/routes/public.js`
- Modify: `platform/src/server.js`（挂载 P5 三组路由 + 支持原文响应 `.ics`）
- Test: `platform/test/public-api.test.js`

**Interfaces:**
- Consumes: P3 的 `applyVisibility`（`src/domain/visibility.js`）与 `points_ledger` / `tier_records`；P2 的 `stage_results` / `stages`；P1 的 `teams` / `task_packages`；Task 1–3 的服务与仓储
- Produces（与 `INTERFACES.md` §6 逐字一致，另**追加**三个建对象与三条 API，见偏差章节 D-3 / D-5）：
  - `getPublicLeaderboard({ db, token, editionId })` → 公开榜单 payload（**追加可选** `rules` / `now`）
  - `createPublicToken({ db, scope, editionId, expiresAt, now })` → `{ token, scope, editionId, expiresAt }`（追加）
  - `resolvePublicToken({ db, token, now, requiredScope, editionId })` → `{ scope, editionId, expiresAt }`（追加）
  - API：`GET /api/workflows/:id/tasks`、`POST /api/tasks/:id/claim`、`POST /api/tasks/:id/release`、`GET /api/pools/projects|talents|resources`、`POST /api/pools/sync`、`GET /api/public/leaderboard`（另**追加** 3 条：建工作流 / 建任务 / 完成任务）

> **⚠️ 本 Task 的灵魂（公开接口是最容易泄露的地方）**
> 公开 API **无需登录**，用 `public_tokens` 鉴权（scope + edition_id + expires_at）。
> 但"无需登录"⛔ **不等于"默认给全量"**：
> ① **必须显式调用 `applyVisibility`**（P3 产出），不是"公开接口反正没人看"；
> ② 过滤之后再做**字段白名单投影**（allowlist）：只给 `rank / teamName / tier / total / points / tiedWith`；
> ③ D 段队伍**不公示**（段位未知 = 视为未达 C 段，fail-closed）；
> ④ B 榜评分与签字人、企业名、互评来源**一律不进公开响应**。
> 依据：S10 §0.3 分层公开 + §8 风险表；【冲突】C-02 已裁决（C 段及以上公示名次，D 段只公示个人进度）。

- [ ] **Step 1: 写失败的测试**

`platform/test/public-api.test.js`：

```javascript
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
import { insertWorkflow, insertWorkflowTask } from '../src/db/repo/workflows.js';
import {
  createPublicToken, resolvePublicToken, getPublicLeaderboard, PUBLIC_NOTICE,
} from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
// 统一注入时间：所有时间断言都基于它，口径可复算
const NOW = '2026-10-20T00:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5pub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000031', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_sign', '签字人丁', '13900000032', 'x', 'other', '某银行', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_super', '组委会', '13900000033', 'x', 'mba', '组委会', 1, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_a', 'tp_1', 'D', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_ghost', 'ed_1', '幽灵队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_3', 'ed_1', '三队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_3', 'st_1', 'tm_3', 3, 70.0, 72.0, 68.0, 1, 6, NULL, '2026-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_0', 'tm_1', 'D', 0, 0, '[]', '2026-10-11T00:00:00.000Z', NULL),
           ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_3', 'tm_1', 'B', 3, 1, '[]', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');
    INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
    VALUES ('pr_1', 'st_1', 'tm_ghost', 'tm_1', 7.5, 'req_1', '2026-10-10T00:00:00.000Z');
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z');
    INSERT INTO capabilities (key, description) VALUES ('pool:read', '读取三池'), ('pool:write', '维护三池');
  `);
  const app = createApp({ db, rules, webDir });
  return {
    db,
    close,
    dataDir,
    rules,
    app,
    tokenMember: createSession(db, 'u_a').token,
    tokenOutsider: createSession(db, 'u_sign').token,
    tokenSuper: createSession(db, 'u_super').token,
  };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

// 工作流夹具：用**仓储层的真实写入方**建（数据形状与生产写入一致）
function seedWorkflow(db) {
  const wf = insertWorkflow(db, {
    id: 'wf_1', editionId: 'ed_1', taskPackageId: 'tp_1', name: '工作流一',
    now: '2026-10-01T00:00:00.000Z',
  });
  const task = insertWorkflowTask(db, {
    id: 'wt_1', workflowId: wf.id, title: '做风控原型',
    now: '2026-10-01T00:00:00.000Z',
  });
  return { wf, task };
}

function leaderboardToken(db, { scope = 'leaderboard', editionId = 'ed_1', expiresAt = '2027-01-01T00:00:00.000Z' } = {}) {
  return createPublicToken({
    db, scope, editionId, expiresAt, now: '2026-10-01T00:00:00.000Z',
  }).token;
}

test('无 token → 403', () => {
  const { db, close, dataDir, rules } = setup();
  assert.throws(
    () => getPublicLeaderboard({ db, token: '', editionId: 'ed_1', rules }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_MISSING',
  );
  cleanup(db, close, dataDir);
});

test('token 过期 → 403', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2026-10-01T00:00:00.000Z', now: '2026-09-01T00:00:00.000Z',
  });
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_EXPIRED',
  );
  cleanup(db, close, dataDir);
});

test('token 属于别的届期 → 403', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_other', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_EDITION_MISMATCH',
  );
  cleanup(db, close, dataDir);
});

test('scope 不匹配（calendar token 去拉榜单）→ 403', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'calendar', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_SCOPE_MISMATCH',
  );
  cleanup(db, close, dataDir);
});

test('有效 token → 拿到榜单，但 D 段队伍不公示', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' });
  assert.equal(payload.stages.length, 1);
  const rows = payload.stages[0].rows;
  assert.equal(rows.length, 1, 'D 段队伍（二队）不进公开榜单');
  assert.equal(rows[0].teamName, '一队');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].tier, 'C');
  cleanup(db, close, dataDir);
});

test('公开响应体里没有签字人、没有企业名、没有互评来源、没有 D 段队伍', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' });
  const text = JSON.stringify(payload);

  assert.equal(text.includes('签字人丁'), false, 'B 榜签字人不公开');
  assert.equal(text.includes('某银行'), false, '企业名不公示');
  assert.equal(text.includes('tm_ghost'), false, '互评来源不公示');
  assert.equal(text.includes('二队'), false, 'D 段队伍不公示排名');
  assert.equal(text.includes('enterpriseName'), false);
  assert.equal(text.includes('signatory'), false);
  assert.equal(text.includes('peer'), false);
  cleanup(db, close, dataDir);
});

test('公开行的字段是白名单（结构上杜绝泄露）', () => {
  const { db, close, dataDir, rules } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: '2026-10-20T00:00:00.000Z' });
  const row = payload.stages[0].rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['points', 'rank', 'teamName', 'tier', 'tiedWith', 'total'].sort());
  cleanup(db, close, dataDir);
});

test('公开接口必须显式调用可见性过滤（源码里有 applyVisibility）', () => {
  const src = readFileSync(join(here, '..', 'src', 'services', 'public-api.js'), 'utf8');
  assert.ok(src.includes('applyVisibility'), '公开接口必须显式过 applyVisibility（P3 产出）');
  assert.ok(src.includes("from '../domain/visibility.js'"), '必须从 P3 的 visibility 模块导入');
  // ⚠️ 补（P5 Task 4 实跑后追加）：context 必须是 scope='rank'。
  //    P3 的 rank 分支只剔互评来源与企业名，**不做段位过滤**（段位下限由 P5 自己执行）；
  //    写成 'tier' 会让 P3 先按它自己的段位表过滤 —— 两层口径一旦漂移，
  //    公开榜就会随 P3 的改动而变（D 段是否公示不再由 P5 单独决定）。
  assert.ok(src.includes("context: { scope: 'rank'"), 'applyVisibility 的 context 必须是 scope=rank');
});

test('token 只存哈希：库里看不到明文', () => {
  const { db, close, dataDir } = setup();
  const { token } = createPublicToken({
    db, scope: 'all', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const rows = db.prepare('SELECT token FROM public_tokens').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, token, '库里存的是哈希，不是明文 token');
  assert.equal(rows[0].token.length, 64, 'SHA-256 十六进制长度');
  cleanup(db, close, dataDir);
});

test('resolvePublicToken 对有效 token 返回 scope 与届期', () => {
  const { db, close, dataDir } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const resolved = resolvePublicToken({
    db, token, now: '2026-10-20T00:00:00.000Z', requiredScope: 'leaderboard', editionId: 'ed_1',
  });
  assert.equal(resolved.scope, 'leaderboard');
  assert.equal(resolved.editionId, 'ed_1');
  cleanup(db, close, dataDir);
});

// ── 以下为 P5 Task 4 实跑后补齐的用例（计划原块只覆盖服务层，
//    新建的 3 个路由文件 + server.js 的原文响应分支**零覆盖**）──

test('resolvePublicToken 同时返回 expiresAt（调用方据此判断剩余有效期）', () => {
  const { db, close, dataDir } = setup();
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2027-01-01T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  });
  const resolved = resolvePublicToken({
    db, token, now: '2026-10-20T00:00:00.000Z', requiredScope: 'leaderboard', editionId: 'ed_1',
  });
  assert.equal(resolved.expiresAt, '2027-01-01T00:00:00.000Z');
  cleanup(db, close, dataDir);
});

test('token 库里查不到 → 403 PUBLIC_TOKEN_INVALID', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => resolvePublicToken({ db, token: '根本没签发过', now: NOW, requiredScope: 'leaderboard' }),
    (err) => err.status === 403 && err.code === 'PUBLIC_TOKEN_INVALID',
  );
  cleanup(db, close, dataDir);
});

test('createPublicToken 不给 expiresAt → 按 rules.pools.publicTokenTtlDays 推算（默认 30 天）', () => {
  const { db, close, dataDir } = setup();
  const created = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', now: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(created.expiresAt, '2026-10-31T00:00:00.000Z');
  cleanup(db, close, dataDir);
});

test('createPublicToken 的 scope 必须在 publicScopes 内 → 否则 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => createPublicToken({ db, scope: 'admin', editionId: 'ed_1', now: '2026-10-01T00:00:00.000Z' }),
    (err) => err.status === 400 && err.code === 'PUBLIC_SCOPE_INVALID',
  );
  cleanup(db, close, dataDir);
});

test('createPublicToken 缺 editionId → 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => createPublicToken({ db, scope: 'leaderboard', now: '2026-10-01T00:00:00.000Z' }),
    (err) => err.status === 400 && err.code === 'EDITION_REQUIRED',
  );
  cleanup(db, close, dataDir);
});

test('getPublicLeaderboard 缺规则 → 500 RULES_MISSING（拒绝出数，不用默认口径凑数）', () => {
  const { db, close, dataDir } = setup();
  const token = leaderboardToken(db);
  assert.throws(
    () => getPublicLeaderboard({ db, token, editionId: 'ed_1' }),
    (err) => err.status === 500 && err.code === 'RULES_MISSING',
  );
  cleanup(db, close, dataDir);
});

test('getPublicLeaderboard 缺 editionId → 400', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  assert.throws(
    () => getPublicLeaderboard({ db, token, rules, now: NOW }),
    (err) => err.status === 400 && err.code === 'EDITION_REQUIRED',
  );
  cleanup(db, close, dataDir);
});

test('公开 payload 的元信息：editionId / generatedAt / scope / notice / 赛段信息', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  assert.equal(payload.editionId, 'ed_1');
  assert.equal(payload.generatedAt, NOW, 'generatedAt 必须落在注入的时间上');
  assert.equal(payload.scope, 'rank');
  assert.equal(payload.notice, PUBLIC_NOTICE);
  assert.equal(payload.stages[0].stageId, 'st_1');
  assert.equal(payload.stages[0].stageKey, 's1');
  assert.equal(payload.stages[0].stageName, '调研');
  cleanup(db, close, dataDir);
});

test('段位取最新的一条【有效】记录（软删除的不算）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  // 种子里有 tm_1 的三条段位记录：tr_0（D, 更早）/ tr_1（C）/ tr_3（B, 更晚但已软删除）
  assert.equal(payload.stages[0].rows[0].tier, 'C', '取最新的一条有效记录；软删除的不生效');
  cleanup(db, close, dataDir);
});

test('公开行的分值字段逐个透传（total / points / tiedWith）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  const row = payload.stages[0].rows[0];
  assert.equal(row.total, 90);
  assert.equal(row.points, 10);
  assert.equal(row.tiedWith, 0);
  cleanup(db, close, dataDir);
});

test('被段位门槛挡下的队伍要留下 warning（不是静默丢弃）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  const hidden = payload.warnings.find((w) => w.code === 'tier_below_public_threshold_hidden');
  assert.ok(hidden, '低于公示门槛的队伍必须留 warning');
  assert.equal(hidden.stageId, 'st_1');
  // 二队（D 段）+ 三队（无段位记录 = 段位未知 = 视为未达 C 段）
  assert.equal(hidden.count, 2);
  cleanup(db, close, dataDir);
});

test('段位未知（无 tier_record）= 视为未达 C 段 → 不公示（fail-closed）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules, now: NOW });
  const names = payload.stages[0].rows.map((r) => r.teamName);
  assert.deepEqual(names, ['一队'], '三队段位未知 ⇒ 与 D 段同待遇，不公示');
  cleanup(db, close, dataDir);
});

test('公示门槛可配置：publicFromTier 提到 B → C 段队伍也不公示', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  const strict = {
    ...rules,
    visibility: { ...rules.visibility, rank: { ...rules.visibility.rank, publicFromTier: 'B' } },
  };
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules: strict, now: NOW });
  assert.equal(payload.stages[0].rows.length, 0, '门槛提到 B 段后 C 段队伍也不公示');
  cleanup(db, close, dataDir);
});

test('HTTP GET /api/public/leaderboard 带有效 token → 200，且只给白名单字段', async () => {
  const s = setup();
  const token = leaderboardToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/leaderboard?token=${token}&editionId=ed_1`);
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.stages.length, 1);
  assert.deepEqual(
    Object.keys(payload.stages[0].rows[0]).sort(),
    ['points', 'rank', 'teamName', 'tier', 'tiedWith', 'total'].sort(),
  );
  assert.equal(res.body.includes('二队'), false, 'D 段队伍不公示');
  assert.equal(res.body.includes('某银行'), false, '企业名不公示');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/leaderboard 无 token → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/leaderboard?editionId=ed_1');
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_MISSING');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/leaderboard token 无效 → 403', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/leaderboard?token=not-a-real-token&editionId=ed_1');
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_INVALID');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/leaderboard 缺 editionId → 400', async () => {
  const s = setup();
  const token = leaderboardToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/leaderboard?token=${token}`);
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/:id/tasks 未登录 → 401', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'GET', `/api/workflows/${wf.id}/tasks`);
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/:id/tasks 队成员 → 200 + 任务清单', async () => {
  const s = setup();
  const { wf, task } = seedWorkflow(s.db);
  const res = await call(s.app, 'GET', `/api/workflows/${wf.id}/tasks`, { token: s.tokenMember });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].id, task.id);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/:id/tasks 非队成员 → 200 + 空集（列表三态）', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'GET', `/api/workflows/${wf.id}/tasks`, { token: s.tokenOutsider });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).tasks, []);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/workflows/<不存在> → 404（单条不存在）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/workflows/wf_none/tasks', { token: s.tokenMember });
  assert.equal(res.status, 404, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/claim 未登录 → 401', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { body: {} });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/claim → 200；重复领取 → 409（唯一领取由数据库兜底）', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const first = await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  assert.equal(first.status, 200, first.body);
  assert.equal(JSON.parse(first.body).task.status, 'in_progress');
  const second = await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  assert.equal(second.status, 409, second.body);
  assert.equal(JSON.parse(second.body).error.code, 'TASK_ALREADY_CLAIMED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/release 未登录 → 401', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/release`, { body: {} });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/release 非领取人 → 403（谁领的谁放，不存在上级指派）', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/release`, { token: s.tokenOutsider, body: {} });
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'NOT_CLAIM_HOLDER');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/complete 未登录 → 401', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/tasks/${task.id}/complete`, { body: {} });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/tasks/:id/complete 证据不合格 → 400；合格 → 200 done', async () => {
  const s = setup();
  const { task } = seedWorkflow(s.db);
  await call(s.app, 'POST', `/api/tasks/${task.id}/claim`, { token: s.tokenMember, body: {} });
  const bad = await call(s.app, 'POST', `/api/tasks/${task.id}/complete`, {
    token: s.tokenMember, body: { evidence: { kind: 'runnable', summary: '做完了' } },
  });
  assert.equal(bad.status, 400, bad.body);
  assert.equal(JSON.parse(bad.body).error.code, 'EVIDENCE_REQUIRED');
  const good = await call(s.app, 'POST', `/api/tasks/${task.id}/complete`, {
    token: s.tokenMember,
    body: { evidence: { kind: 'runnable', summary: '原型跑通了', artifactUrl: 'https://example.com/repo', version: 'v1' } },
  });
  assert.equal(good.status, 200, good.body);
  assert.equal(JSON.parse(good.body).task.status, 'done');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/{projects,talents,resources} 未登录 → 200 + 空集（列表三态）', async () => {
  const s = setup();
  for (const [path, key] of [
    ['/api/pools/projects', 'projects'],
    ['/api/pools/talents', 'talents'],
    ['/api/pools/resources', 'resources'],
  ]) {
    const res = await call(s.app, 'GET', `${path}?editionId=ed_1`);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(JSON.parse(res.body)[key], [], `${path} 应返回空集`);
  }
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { body: { editionId: 'ed_1' } });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 缺 editionId → 400', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: {} });
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 无 pool:write 权限 → 403（can() 是唯一判定入口）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenMember, body: { editionId: 'ed_1' } });
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN');
  cleanup(s.db, s.close, s.dataDir);
});

test('原文响应（__rawText）走 text() 而不是 json()', async () => {
  const s = setup();
  s.app.router.add('GET', '/api/test-raw', async () => ({
    __rawText: true, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', contentType: 'text/calendar; charset=utf-8',
  }));
  const raw = await call(s.app, 'GET', '/api/test-raw');
  assert.equal(raw.status, 200);
  assert.equal(raw.body, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', '原文响应必须原样输出');
  assert.equal(raw.headers['Content-Type'], 'text/calendar; charset=utf-8');
  // 对照：普通 handler 仍走 JSON
  const jsonRes = await call(s.app, 'GET', '/api/health');
  assert.equal(jsonRes.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(jsonRes.body).ok, true);
  cleanup(s.db, s.close, s.dataDir);
});

test('可见性过滤抛错 → 记 warning 并用严格投影兜底（fail-safe：宁可少给不可多给）', () => {
  const { db, close, dataDir, rules } = setup();
  const token = leaderboardToken(db);
  // 只让 peerReview 这个键抛错：applyVisibility 读它时炸，
  // 而 projectPublicRows 读的是 rank.publicFromTier（不炸）⇒ 兜底路径可被观测。
  const boom = new Proxy({ rank: rules.visibility.rank }, {
    get(target, prop) {
      if (prop === 'peerReview') throw new Error('可见性配置炸了');
      return target[prop];
    },
  });
  const payload = getPublicLeaderboard({ db, token, editionId: 'ed_1', rules: { ...rules, visibility: boom }, now: NOW });
  const w = payload.warnings.find((x) => x.code === 'visibility_filter_failed');
  assert.ok(w, '过滤失败必须留 warning，不能静默');
  assert.equal(payload.stages[0].rows.length, 1, '兜底后仍只给 C 段队伍（D 段照旧不公示）');
  cleanup(db, close, dataDir);
});

test('HTTP GET /api/workflows/<不存在> 未登录 → 401（先判登录，不泄露工作流是否存在）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/workflows/wf_none/tasks');
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows 未登录 → 401', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/workflows', {
    body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '工作流一' },
  });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows 认领该任务包的队员 → 200（任务包 → 工作流）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/workflows', {
    token: s.tokenMember, body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '工作流一' },
  });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.workflow.task_package_id, 'tp_1');
  assert.equal(payload.workflow.name, '工作流一');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows/:id/tasks 未登录 → 401', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/workflows/${wf.id}/tasks`, { body: { title: '任务一' } });
  assert.equal(res.status, 401, res.body);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows/:id/tasks 指定 ownerTeamId → 落库（队伍归属明确）', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/workflows/${wf.id}/tasks`, {
    token: s.tokenMember, body: { title: '任务二', ownerTeamId: 'tm_1' },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).task.owner_team_id, 'tm_1');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/workflows/:id/tasks 队成员 → 200（工作流 → 任务清单）', async () => {
  const s = setup();
  const { wf } = seedWorkflow(s.db);
  const res = await call(s.app, 'POST', `/api/workflows/${wf.id}/tasks`, {
    token: s.tokenMember, body: { title: '任务一', detail: '细节' },
  });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.task.title, '任务一');
  assert.equal(payload.task.workflow_id, wf.id);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/projects 组委会 → 200 + 4 支队伍（限流与过滤参数生效）', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  const res = await call(s.app, 'GET', '/api/pools/projects?editionId=ed_1', { token: s.tokenSuper });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).projects.length, 4);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/talents 组委会 → 200 + 个人积分（minPoints / userId 过滤生效）', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  const all = await call(s.app, 'GET', '/api/pools/talents?editionId=ed_1', { token: s.tokenSuper });
  assert.equal(all.status, 200, all.body);
  const talents = JSON.parse(all.body).talents;
  assert.equal(talents.length, 1);
  assert.equal(talents[0].userId, 'u_a');
  assert.equal(talents[0].totalPoints, 10);
  const none = await call(s.app, 'GET', '/api/pools/talents?editionId=ed_1&minPoints=100', { token: s.tokenSuper });
  assert.deepEqual(JSON.parse(none.body).talents, []);
  const other = await call(s.app, 'GET', '/api/pools/talents?editionId=ed_1&userId=nobody', { token: s.tokenSuper });
  assert.deepEqual(JSON.parse(other.body).talents, []);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/pools/resources 组委会 → 200 + 企业侧资源（kind 过滤生效）', async () => {
  const s = setup();
  await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  const res = await call(s.app, 'GET', '/api/pools/resources?editionId=ed_1', { token: s.tokenSuper });
  assert.equal(res.status, 200, res.body);
  const resources = JSON.parse(res.body).resources;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].kind, 'enterprise_brief');
  const none = await call(s.app, 'GET', '/api/pools/resources?editionId=ed_1&kind=free_brief', { token: s.tokenSuper });
  assert.deepEqual(JSON.parse(none.body).resources, []);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 缺 editionId（且无 pool:write）→ 400（先判参数，再判权限）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenMember, body: {} });
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 的 editionId 也可以走 query 参数', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync?editionId=ed_1', { token: s.tokenSuper, body: {} });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).projects.editionId, 'ed_1');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP POST /api/pools/sync 三池都同步（项目 / 人才 / 资源）', async () => {
  const s = setup();
  const res = await call(s.app, 'POST', '/api/pools/sync', { token: s.tokenSuper, body: { editionId: 'ed_1' } });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.projects.total, 4, '4 支队（幽灵队也在内）进项目池');
  assert.equal(payload.talents.total, 1, '有积分流水的人进人才池');
  assert.equal(payload.resources.total, 1);
  cleanup(s.db, s.close, s.dataDir);
});

```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --disable-warning=ExperimentalWarning --test test/public-api.test.js`
Expected: FAIL —— `Cannot find module '../src/services/public-api.js'`

- [ ] **Step 3: 创建 `src/services/public-api.js`**

```javascript
// src/services/public-api.js — 公开榜单 API（无需登录，token 鉴权）与赛程日历
// 依据：INTERFACES.md §6（P5 产出）；设计文档 §8「公开榜单 API + 赛程 iCal 订阅」
//   R-RNK-04 滚动榜单全程公开 + 分层公开；【冲突】C-02 段位公示范围已裁决
//
// ⛔ 本模块【不是"默认给全量"】：公开响应必须先过 applyVisibility（P3 产出），
//    再做字段白名单投影。D 段队伍不公示排名；B 榜评分与签字人不公开；
//    企业名不公示；互评来源不公示。前端隐藏 = 数据已泄露 —— 过滤必须在服务端完成。
import { createHash, randomBytes } from 'node:crypto';
import { appError } from '../errors.js';
import { applyVisibility } from '../domain/visibility.js';
import { buildEventInfo } from '../domain/event-info.js';
import * as tokenRepo from '../db/repo/public-tokens.js';
import * as srcRepo from '../db/repo/pool-sources.js';
import { buildICalendarText } from '../domain/icalendar.js';

export const PUBLIC_NOTICE =
  'A 榜赛段名次全程公开；D 段不公示排名；B 榜评分与签字人不公开；企业名不公示；互评来源不公示。';

function nowIso(now) {
  return now ?? new Date().toISOString();
}

export function hashPublicToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 签发公开令牌。
 * ⛔ 库里只存 SHA-256（与 P0 的 sessions.token_hash 同一纪律）；明文只在这里返回一次。
 */
export function createPublicToken({
  db, scope = 'all', editionId, expiresAt, now, ttlDays, rules,
}) {
  const at = nowIso(now);
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  const allowed = rules?.pools?.publicScopes ?? ['leaderboard', 'calendar', 'all'];
  if (!allowed.includes(scope)) {
    throw appError(400, 'PUBLIC_SCOPE_INVALID', `scope 必须是 ${allowed.join(' / ')} 之一`);
  }
  const token = randomBytes(32).toString('base64url');
  const ttl = Number.isInteger(ttlDays) && ttlDays > 0
    ? ttlDays
    : (rules?.pools?.publicTokenTtlDays ?? 30);
  const expires = expiresAt ?? new Date(new Date(at).getTime() + ttl * 86400000).toISOString();
  tokenRepo.insertPublicToken(db, {
    token: hashPublicToken(token), scope, editionId, expiresAt: expires, now: at,
  });
  return { token, scope, editionId, expiresAt: expires };
}

/**
 * 校验公开令牌。
 * ⛔ 四种失败一律 403（无 token / 无效 / 过期 / 跨届期 / scope 不符），不返回 401：
 *    公开接口本来就没有"登录"这回事，401 会让调用方误以为该去登录。
 */
export function resolvePublicToken({
  db, token, now, requiredScope = 'all', editionId = null,
}) {
  const at = nowIso(now);
  if (!token || !String(token).trim()) {
    throw appError(403, 'PUBLIC_TOKEN_MISSING', '缺少公开访问 token');
  }
  const row = tokenRepo.findPublicToken(db, hashPublicToken(String(token)));
  if (!row) throw appError(403, 'PUBLIC_TOKEN_INVALID', 'token 无效');
  if (new Date(row.expires_at).getTime() <= new Date(at).getTime()) {
    throw appError(403, 'PUBLIC_TOKEN_EXPIRED', 'token 已过期');
  }
  if (editionId && row.edition_id !== editionId) {
    throw appError(403, 'PUBLIC_TOKEN_EDITION_MISMATCH', 'token 不适用于该届期');
  }
  if (requiredScope && requiredScope !== 'all' && row.scope !== 'all' && row.scope !== requiredScope) {
    throw appError(403, 'PUBLIC_TOKEN_SCOPE_MISMATCH', 'token 权限范围不足');
  }
  return { scope: row.scope, editionId: row.edition_id, expiresAt: row.expires_at };
}

/**
 * 公开榜单。
 * @param db       数据库
 * @param token    公开令牌（query 参数）
 * @param editionId 届期
 * @param rules    规则集（【追加的可选参数】：可见性规则与段位表都来自这里；
 *                 不给就拒绝出数，绝不用"默认口径"凑一份能看的榜单出来）
 * @param now      时间（【追加的可选参数】，便于测试注入）
 */
export function getPublicLeaderboard({ db, token, editionId, rules, now }) {
  const at = nowIso(now);
  if (!rules?.visibility || !rules?.ranks) {
    throw appError(500, 'RULES_MISSING', '缺少可见性规则，拒绝出数（不用默认口径凑数）');
  }
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  resolvePublicToken({ db, token, now: at, requiredScope: 'leaderboard', editionId });

  const warnings = [];
  const stages = srcRepo.listEditionStages(db, editionId);
  const tierByTeam = buildTierMap(srcRepo.listEditionTierRecords(db, editionId));

  const out = stages.map((stage) => {
    const raw = buildStagePayload(db, stage, tierByTeam);
    let filterOk = true;
    let visibleRows = null;
    try {
      // ⛔ 必须显式过可见性过滤（P3 产出）—— 公开接口是最容易泄露的地方
      const visible = applyVisibility({
        payload: raw,
        viewer: { id: null, isPublic: true },
        visibilityConfig: rules.visibility,
        context: { scope: 'rank', public: true, stageId: stage.id, editionId },
      });
      visibleRows = extractRows(visible, raw, warnings, stage.id);
    } catch (err) {
      // 过滤失败不静默：记 warning，并用【严格投影】兜底（宁可少给，不可多给）
      filterOk = false;
      warnings.push({
        code: 'visibility_filter_failed',
        stageId: stage.id,
        message: String(err?.message ?? err),
      });
    }
    let rows = raw.rows;
    if (filterOk && visibleRows) {
      const allowed = new Set(visibleRows.map(identity).filter(Boolean));
      rows = raw.rows.filter((r) => allowed.has(identity(r)));
    }
    return {
      stageId: stage.id,
      stageKey: stage.stage_key,
      stageName: stage.name,
      rows: projectPublicRows(rows, rules, warnings, stage.id),
    };
  });

  return {
    editionId,
    generatedAt: at,
    scope: 'rank',
    notice: PUBLIC_NOTICE,
    warnings,
    stages: out,
  };
}

function identity(row) {
  return row.teamId ?? row.team_id ?? row.id ?? null;
}

function buildTierMap(tierRecords) {
  const map = new Map();
  for (const t of tierRecords) {
    if (t.deleted_at) continue;
    const teamId = t.team_id;
    const at = String(t.computed_at ?? '');
    const prev = map.get(teamId);
    if (!prev || at >= prev.at) map.set(teamId, { at, tier: t.tier });
  }
  return map;
}

function buildStagePayload(db, stage, tierByTeam) {
  const results = srcRepo.listStageResultsWithTeams(db, stage.id);
  const rows = results.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    rank: r.rank,
    total: r.total,
    points: r.points,
    tiedWith: r.tied_with,
    tier: tierByTeam.get(r.team_id)?.tier ?? null,
  }));
  return { scope: 'rank', stageId: stage.id, rows };
}

function extractRows(visible, raw, warnings, stageId) {
  if (!visible || typeof visible !== 'object') {
    warnings.push({ code: 'visibility_payload_shape_unexpected', stageId });
    return raw.rows;
  }
  if (Array.isArray(visible.rows)) return visible.rows;
  if (Array.isArray(visible.teams)) return visible.teams;
  warnings.push({ code: 'visibility_payload_shape_unexpected', stageId });
  return raw.rows;
}

/**
 * 公开字段白名单投影 + 段位下限。
 * ⛔ allowlist（只列要给什么），不是 denylist（列不给什么）—— 后者漏一个字段就是一次泄露。
 * 段位未知 = 视为未达 C 段 = 不公示（fail-closed，宁可少给不可多给）。
 */
function projectPublicRows(rows, rules, warnings, stageId) {
  const order = new Map((rules.ranks?.tiers ?? []).map((t, i) => [t.key, i]));
  const minKey = rules.visibility?.rank?.publicFromTier ?? 'C';
  const minOrder = order.has(minKey) ? order.get(minKey) : 0;
  const out = [];
  let hidden = 0;
  for (const r of rows) {
    const tier = r.tier ?? null;
    const tierOrder = tier && order.has(tier) ? order.get(tier) : -1;
    if (tierOrder < minOrder) {
      hidden += 1;
      continue;
    }
    out.push({
      rank: r.rank ?? null,
      teamName: r.teamName ?? r.team_name ?? null,
      tier,
      total: r.total ?? null,
      points: r.points ?? null,
      tiedWith: r.tiedWith ?? r.tied_with ?? null,
    });
  }
  if (hidden > 0) {
    warnings.push({ code: 'tier_below_public_threshold_hidden', stageId, count: hidden });
  }
  return out;
}

/**
 * 赛事公开信息（落地页的赛制数据源）。
 *
 * ⚠️⚠️ **为什么要有这个投影，而不是让前端直接读 rules/**：
 *   落地页要「介绍赛事与赛制」⇒ 前端需要赛段的起止与交付物、评审维度权重、段位表、
 *   筛选漏斗、组队规则、名次积分、破同分链、合规红线。
 *   这些**全部**只在 `platform/rules/*.json` 里（赛制的唯一出处），
 *   而 rules 是**服务端**配置、浏览器读不到 ⇒ 只能由服务端投影出去。
 *   ⇒ 前端**一个字都不许硬编码**赛制数字（改 rules/*.json 即改落地页，不必改前端）。
 *
 * ⛔⛔ **白名单投影，不是整体倒 rules**：
 *   rules 里大量字段是**内部工作备注**（「此为待组委会确认口径」「首届后回测」…），
 *   整体倒出去 = 把内部待办状态公开发布。
 *   ⇒ 投影本身在 **src/domain/event-info.js**（纯函数、零依赖、可进浏览器），
 *     演示站（web/api.demo.js）import **同一个函数** ⇒ 正式站与演示站的落地页内容**不可能漂移**。
 *
 * ⛔ **公开的是「规则」，不是「数据」**：
 *   规则（权重、赛程、段位）本来就该公开 —— 参赛者有权知道自己被怎么评；
 *   而**分数、名次、企业名、签字人**由 applyVisibility 负责，不在这个函数里。
 *
 * @param {object} rules  已加载的规则配置（src/config.js 的 loadRules 结果）
 * @returns {object}      落地页用的赛制数据（形状固定，见 platform/test/event-info-api.test.js）
 */
export function getEventInfo(rules) {
  if (!rules || typeof rules !== 'object') {
    throw appError(500, 'RULES_MISSING', '规则配置未加载');
  }
  return buildEventInfo(rules);
}

/**
 * 赛程日历（iCal）。
 * 溯源：R-STG-01（5 赛段时间轴与交付物）—— 依据 INTERFACES.md §6 / 设计文档 §8
 * @param db        数据库
 * @param editionId 届期
 * @param now       时间（【追加的可选参数】，便于测试注入；不传则取当前时间）
 * @returns ics 文本
 */
export function buildICalendar({ db, editionId, now }) {
  const at = nowIso(now);
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  const edition = srcRepo.getEdition(db, editionId);
  const stages = srcRepo.listEditionStages(db, editionId);
  const events = stages.map((s) => ({
    uid: `stage-${s.id}@heikesong.local`,
    summary: `${s.name}（${s.stage_key}）`,
    description: `赛段 ${s.stage_key}：${s.name}`,
    start: s.starts_at,
    end: s.ends_at ?? addOneDay(s.starts_at),
    location: edition?.city ?? null,
    url: `/leaderboard?stageId=${encodeURIComponent(s.id)}`,
  }));
  return buildICalendarText({
    calName: edition?.name ?? '黑客松赛程',
    events,
    now: at,
  });
}

function addOneDay(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 86400000).toISOString();
}
```

- [ ] **Step 4: 创建 `src/http/routes/workflow.js`**

```javascript
// src/http/routes/workflow.js — 任务清单 API
// 依据：INTERFACES.md §6 的 P5 API 清单；R-OPS-13 / R-OPS-14
// ⛔ R-OPS-14：禁止岗位制，任务只能自主领取 —— 这里【没有】任何"按岗位分配任务"的端点。
import { appError } from '../../errors.js';
import {
  createWorkflow, createWorkflowTask, listWorkflowTasks,
  claimTask, releaseTask, completeTask,
} from '../../services/workflow.js';

export function registerWorkflowRoutes(router, { db, rules }) {
  router.add('GET', '/api/workflows/:id/tasks', async ({ user, params }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return { tasks: listWorkflowTasks({ db, workflowId: params.id, viewer: user }) };
  });

  // 追加：建工作流（任务包 → 工作流）。契约的 API 清单里没有这条，
  // 但没有它就无法产生工作流 —— 见偏差章节 D-5。
  router.add('POST', '/api/workflows', async ({ user, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const wf = createWorkflow({
      db,
      editionId: body?.editionId,
      taskPackageId: body?.taskPackageId,
      name: body?.name,
      actorId: user.id,
    });
    return { workflow: wf };
  });

  // 追加：建任务（工作流 → 任务清单）。
  router.add('POST', '/api/workflows/:id/tasks', async ({ user, params, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const task = createWorkflowTask({
      db,
      workflowId: params.id,
      title: body?.title,
      detail: body?.detail,
      ownerTeamId: body?.ownerTeamId,
      dueAt: body?.dueAt,
      actorId: user.id,
    });
    return { task };
  });

  router.add('POST', '/api/tasks/:id/claim', async ({ user, params, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return claimTask({
      db, taskId: params.id, userId: user.id, teamId: body?.teamId,
    });
  });

  router.add('POST', '/api/tasks/:id/release', async ({ user, params }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return releaseTask({ db, taskId: params.id, userId: user.id });
  });

  // 追加：完成任务。契约的 API 清单漏了这条，工作流闭环断在这里 —— 见偏差章节 D-5。
  router.add('POST', '/api/tasks/:id/complete', async ({ user, params, body }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    return completeTask({
      db, taskId: params.id, userId: user.id, evidence: body?.evidence,
    });
  });
}
```

- [ ] **Step 5: 创建 `src/http/routes/pools.js`**

```javascript
// src/http/routes/pools.js — 三池只读 API + 同步
// 依据：INTERFACES.md §6 的 P5 API 清单；R-POOL-01/02/03/04
// ⚠️ 一期【不做三池前台页面】（设计文档 §1.2）：这里只提供只读 API 与同步入口。
import { appError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import {
  syncPoolProjects, syncPoolTalents, syncPoolResources,
  listPoolProjects, listPoolTalents, listPoolResources,
} from '../../services/pools.js';

export function registerPoolsRoutes(router, { db, rules }) {
  router.add('GET', '/api/pools/projects', async ({ user, query }) => ({
    projects: listPoolProjects({
      db,
      filter: { editionId: query.editionId, limit: Number(query.limit) || undefined },
      viewer: user,
    }),
  }));

  router.add('GET', '/api/pools/talents', async ({ user, query }) => ({
    talents: listPoolTalents({
      db,
      filter: {
        editionId: query.editionId,
        userId: query.userId,
        minPoints: query.minPoints !== undefined ? Number(query.minPoints) : undefined,
        limit: Number(query.limit) || undefined,
      },
      viewer: user,
    }),
  }));

  router.add('GET', '/api/pools/resources', async ({ user, query }) => ({
    resources: listPoolResources({
      db,
      filter: {
        editionId: query.editionId,
        enterpriseId: query.enterpriseId,
        kind: query.kind,
        limit: Number(query.limit) || undefined,
      },
      viewer: user,
    }),
  }));

  router.add('POST', '/api/pools/sync', async ({ user, body, query }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const editionId = body?.editionId ?? query.editionId;
    if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
    if (!can(user, 'pool:write', { scopeType: 'edition', scopeId: editionId }, db)) {
      throw appError(403, 'FORBIDDEN', '没有三池维护权限');
    }
    return {
      projects: syncPoolProjects({ db, editionId, rules }),
      talents: syncPoolTalents({ db, editionId, rules }),
      resources: syncPoolResources({ db, editionId, rules }),
    };
  });
}
```

- [ ] **Step 6: 创建 `src/http/routes/public.js`**

```javascript
// src/http/routes/public.js — 公开接口
//   ① /api/public/* —— **token 鉴权**的公开数据（榜单 / 日历）：公开 ≠ 无鉴权。
//   ② /api/event-info —— **免 token**的赛事规则说明（落地页用）：规则本来就该公开。
//
// ⚠️ token 走 query 参数（契约如此）：部署时应在 nginx 层关掉 query 串的访问日志（P6 负责）。
import { getPublicLeaderboard, buildICalendar, resolvePublicToken, getEventInfo } from '../../services/public-api.js';

export function registerPublicRoutes(router, { db, rules }) {
  router.add('GET', '/api/public/leaderboard', async ({ query }) =>
    getPublicLeaderboard({
      db,
      token: query.token,
      editionId: query.editionId,
      rules,
    }));
  // 赛程日历（iCal）。⛔ 同样要 token：公开 ≠ 无鉴权。
  // 溯源：R-STG-01（5 赛段时间轴与交付物）—— 依据 INTERFACES.md §6 / 设计文档 §8
  router.add('GET', '/api/public/calendar.ics', async ({ query }) => {
    resolvePublicToken({
      db, token: query.token, requiredScope: 'calendar', editionId: query.editionId,
    });
    const body = buildICalendar({ db, editionId: query.editionId });
    return { __rawText: true, body, contentType: 'text/calendar; charset=utf-8' };
  });

  // ── P9：赛事规则说明（落地页）──────────────────────────────────
  // ⚠️ **为什么它不要 token，而上面两条要**：
  //   上面两条吐的是**比赛数据**（榜单行、赛程实例）⇒ 公开访问要有门槛（token 可撤销、可限范围）。
  //   这一条吐的是**规则本身**（赛段、权重、段位、漏斗）⇒ 参赛者有权知道「我按什么被评」，
  //   规则里**不含任何参赛数据**（白名单投影，见 getEventInfo）⇒ 匿名可读是应该的，
  //   而且落地页要给「还没注册的人」看 ⇒ 不能要求先有 token。
  //
  // ⛔ 它返回的是**配置投影**，不是数据库查询 ⇒ 无 db 依赖、无可见性过滤需求
  //    （规则不是「谁可见」的数据，是「大家都知道」的约定）。
  router.add('GET', '/api/event-info', async () => getEventInfo(rules));
}
```

- [ ] **Step 7: 修改 `src/server.js`（挂载路由 + 支持原文响应）**

在 `src/server.js` 顶部的导入区加入：

```javascript
import { json, error, text } from './http/respond.js';
import { registerWorkflowRoutes } from './http/routes/workflow.js';
import { registerPoolsRoutes } from './http/routes/pools.js';
import { registerPublicRoutes } from './http/routes/public.js';
```

（把原来那行 `import { json, error } from './http/respond.js';` 替换成上面这行。）

在 `createApp()` 里、`router.add('GET', '/api/me', ...)` 之后加入：

```javascript
  // ── P5 路由 ────────────────────────────────────────────────
  registerWorkflowRoutes(router, { db, rules });
  registerPoolsRoutes(router, { db, rules });
  registerPublicRoutes(router, { db, rules });
```

在 `handleRequest()` 里（**不是 `handle()`** —— `handle()` 是外层兜底，这段在它里面的
`handleRequest()` 中），找到下面这段**原文**（P0 终审 I7-4 立的 handler 返回约定，
**整段保留、不许删**）：

```javascript
        const result = await match.handler(ctx);
        // ⛔ 预审修正（I7-4）：handler 返回约定 ——
        //   undefined → 200（保持原行为）；{ status, body }（可选 headers）→ 按返回值应答。
        if (result && typeof result === 'object' && typeof result.status === 'number') {
```

在 `const result = await match.handler(ctx);` **之后**、`if (result && …)` **之前**
**插入**下面这 5 行（**插入，不是替换**）：

```javascript
        // 原文响应（.ics 等）：P0 的 handler 统一 json() 序列化，这里走 text()
        if (result && typeof result === 'object' && result.__rawText === true) {
          text(res, 200, String(result.body ?? ''), result.contentType || 'text/plain; charset=utf-8');
          return;
        }
```

插入后该段应是（**顺序：原文 → 插入段 → I7-4 块 → json 兜底**）：

```javascript
        const result = await match.handler(ctx);
        // 原文响应（.ics 等）：P0 的 handler 统一 json() 序列化，这里走 text()
        if (result && typeof result === 'object' && result.__rawText === true) {
          text(res, 200, String(result.body ?? ''), result.contentType || 'text/plain; charset=utf-8');
          return;
        }
        // ⛔ 预审修正（I7-4）：handler 返回约定 ——
        //   undefined → 200（保持原行为）；{ status, body }（可选 headers）→ 按返回值应答。
        if (result && typeof result === 'object' && typeof result.status === 'number') {
          const { status, body: payload } = result;
          if (status === 204) {
            res.writeHead(204);
            res.end();
            return;
          }
          json(res, status, payload ?? null, result.headers || {});
          return;
        }
        json(res, 200, result ?? { ok: true });
```

> **【2026-10-21 漂移审计修正 C-2 + M-5】**（**本计划最危险的一处**）
> **原来错在哪**：原指令是「在 `handle()` 里，把
> ```javascript
>         const result = await match.handler(ctx);
>         json(res, 200, result ?? { ok: true });
> ```
> **替换成**：……」—— 这两行在 P0 终态里**并不相邻**：中间夹着 I7-4 的 12 行
> handler 返回契约块（基线 `src/server.js:208-221`）。
> **为什么错（两层）**：
> ① **落点锚点不存在** —— 实施者按字面「替换这两行」只有两种落法：**要么找不到锚点卡住**，
> **要么把整段 I7-4 一起删掉**。
> ② **删掉的后果是灾难性的** —— `/api/auth/login` 路由返回 `{ status, body, headers }`，
> 靠 I7-4 块才会被翻译成「200 + 正确 body + `Set-Cookie` 头」。删掉后
> `json(res, 200, result)` 会把 `{status, body, headers}` **整个当 body 序列化**，
> **`Set-Cookie` 头消失** → 浏览器拿不到会话 → **登录功能整体失效**。
> **实跑证据（审计报告 C-2）**：把原替换逐字打进 pristine P0（`38c6713` 与 `d077537`
> 两个基线各跑一遍），跑全量 → **3 个 P0 用例当场变红**：
> `not ok 82 - 正确手机号+密码登录返回 200 并下发 Session Cookie`、
> `not ok 104 - 登出响应必须下发清空 Cookie 的 Set-Cookie（终审 M-3）`、
> `not ok 107 - 登录响应体必须带回当前用户，且不得含 password_hash（复核 I1）`
> （`# tests 151 / # pass 148 / # fail 3`）。审计还用脚本验证过
> 「`const result = await match.handler(ctx);` 紧邻 `json(res, 200, …)`」这个锚点
> 在两个基线上**均不存在**（`adjacent-anchor exists: False`）。
> **改成什么**：① 指令从「**替换**」改为「**插入**」，锚点更新成 P0 终态的**真实原文**
> （含 I7-4 块，逐字抄自基线 `src/server.js`）；② 插入位置明确为
> 「`const result = await match.handler(ctx);` 之后、`if (result && …)` 之前」——
> 这个位置既在 I7-4 块**之前**（`__rawText` 分支要抢在 JSON 应答之前），
> 又**不触碰** I7-4 块本身；③ 补上「插入后该段应长什么样」的完整示意，便于实施者自检。
> **M-5 一并订正**：定位词从 `handle()` 改成 **`handleRequest()`** ——
> `handle()` 是外层兜底（`try { await handleRequest(req, res); } catch { …500… }`），
> 这段代码在 `handleRequest()` 里；写错定位词会让人在错误的函数里找锚点，
> 与 C-2 叠加会**放大误删风险**。
> **依据**：基线 `platform/src/server.js:206-221`（逐字）+
> `platform/src/server.js:151-170`（`handle` 与 `handleRequest` 的关系）
> + 漂移审计报告 C-2 与 M-5。

- [ ] **Step 8: 运行测试确认通过**

Run: `cd platform && node --disable-warning=ExperimentalWarning --test test/public-api.test.js`
Expected: PASS（**55** 个测试全过：public-api.test.js 55）

Run: `cd platform && node --disable-warning=ExperimentalWarning --test`
Expected: 全部通过（P0–P5 累计：**1076** 例 / 通过 1075 / 失败 0 / 跳过 1）

- [ ] **Step 9: 提交**

```bash
git add platform/src/services/public-api.js platform/src/http/routes/workflow.js \
  platform/src/http/routes/pools.js platform/src/http/routes/public.js \
  platform/src/server.js platform/test/public-api.test.js
git commit -m "feat(P5): 公开榜单 API（token 鉴权 + 显式可见性过滤）与 P5 路由挂载" -- \
  platform/src/services/public-api.js platform/src/http/routes/workflow.js \
  platform/src/http/routes/pools.js platform/src/http/routes/public.js \
  platform/src/server.js platform/test/public-api.test.js
```

---

### Task 5: iCal 日历导出（手写 RFC 5545，零依赖）

**Files:**
- Create: `platform/src/domain/icalendar.js`
- Modify: `platform/src/services/public-api.js`（追加 `buildICalendar`）
- Modify: `platform/src/http/routes/public.js`（追加 `GET /api/public/calendar.ics`）
- Test: `platform/test/icalendar.test.js`

**Interfaces:**
- Consumes: Task 1 的 `public_tokens` 仓储；P2 的 `stages` 表；P1 的 `editions`
- Produces（与 `INTERFACES.md` §6 逐字一致）：
  - `buildICalendar({ db, editionId })` → ics 文本（**追加可选** `now`）
  - 领域纯函数：`buildICalendarText({ calName, prodId, events, now })` / `formatICalTimestamp(value)` / `escapeICalText(value)` / `foldICalLine(line)`

> **⚠️ 本 Task 的灵魂（手写格式的四个坑）**
> 零依赖约束（R-OPS-07）意味着**不能引 ical 库**。RFC 5545 有四个必须处理的点，少一个就会让
> 主流日历客户端（Apple 日历 / Google 日历 / Outlook）拒收整个文件：
> ① **行折叠**：每行 ≤ 75 octets，超长要折行，续行以**一个空格**开头；
> ② **转义**：逗号 `,`、分号 `;`、反斜杠 `\`、换行必须转义（顺序不能错：先反斜杠）；
> ③ **行尾**：必须是 **CRLF**（`\r\n`），裸 LF 会被一部分客户端判为格式错误；
> ④ **时间戳**：`YYYYMMDDTHHMMSSZ`（UTC，秒级精度）。
> 可借鉴 dribdat 的 iCal 实现思路（MIT），但**自己写**——它依赖 Django 生态，违反零依赖约束。

- [ ] **Step 1: 写失败的测试**

`platform/test/icalendar.test.js`：

```javascript
// platform/test/icalendar.test.js — iCal 日历导出（手写 RFC 5545，零依赖）
// 依据：设计文档 §8「公开榜单 API + 赛程 iCal 订阅」；INTERFACES.md §6 `buildICalendar`
// 溯源：R-STG-01（5 赛段时间轴与交付物）—— 赛段起止时间轴能被日历客户端订阅
//
// ⚠️ 本文件同时覆盖【两层】：
//   ① 领域纯函数（src/domain/icalendar.js）：转义 / 折叠 / 时间戳
//   ② HTTP 路由（GET /api/public/calendar.ics）：token 鉴权 + 原文响应（__rawText）
//   计划原块只覆盖领域层与���务层 ⇒ 路由零覆盖（同 Task 4 的 T4-C2 同款病根），此处补齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import {
  buildICalendarText, formatICalTimestamp, escapeICalText, foldICalLine,
} from '../src/domain/icalendar.js';
import { buildICalendar, createPublicToken } from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';
import { stripComments } from '../test-helpers/strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
// 统一注入时间：领域层不读时钟，所有时间断言都基于它，口径可复算
const NOW = '2026-10-20T00:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5ics-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  db.exec(`
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届 · 杭州', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '任务', 'initial', '2026-10-10', '2026-10-13', NULL, 'initial', 'computed'),
           ('st_3', 'ed_1', 's3', '开发', 'initial', '2026-10-13', '2026-10-25', NULL, 'initial', 'open');
  `);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, rules, app };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

/** 基本解析器：先取消折叠，再切 VEVENT 块 */
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '');
}

function parseEvents(ics) {
  const flat = unfold(ics);
  return flat.split('BEGIN:VEVENT').slice(1).map((block) => {
    const body = block.split('END:VEVENT')[0];
    const fields = {};
    for (const line of body.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      fields[line.slice(0, idx).split(';')[0]] = line.slice(idx + 1);
    }
    return fields;
  });
}

/** 追加一个赛段（给「长标题」「含特殊字符」等场景用） */
function addStage(db, { id, key, name, startsAt = '2026-10-01', endsAt = '2026-10-10' }) {
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
     VALUES (?, 'ed_1', ?, ?, 'initial', ?, ?, NULL, 'initial', 'computed')`,
  ).run(id, key, name, startsAt, endsAt);
}

/** 签发一个公开令牌（明文只在这里返回一次） */
function publicToken(db, { scope = 'calendar', editionId = 'ed_1', expiresAt = '2099-01-01T00:00:00.000Z' } = {}) {
  return createPublicToken({ db, scope, editionId, expiresAt, now: NOW }).token;
}

test('VEVENT 数 = 赛段数（基本解析器能读出来）', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  const events = parseEvents(ics);
  assert.equal(events.length, 3);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  cleanup(db, close, dataDir);
});

test('每个事件都有 UID / DTSTAMP / DTSTART / DTEND / SUMMARY，时间戳是 YYYYMMDDTHHMMSSZ', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  for (const ev of parseEvents(ics)) {
    assert.ok(ev.UID, '缺 UID');
    assert.match(ev.DTSTAMP, /^\d{8}T\d{6}Z$/);
    assert.match(ev.DTSTART, /^\d{8}T\d{6}Z$/);
    assert.match(ev.DTEND, /^\d{8}T\d{6}Z$/);
    assert.ok(ev.SUMMARY, '缺 SUMMARY');
  }
  cleanup(db, close, dataDir);
});

test('行尾是 CRLF，没有裸 LF', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false, '不允许裸 LF');
  assert.equal(ics.replace(/\r\n/g, '').includes('\r'), false, '不允许裸 CR');
  cleanup(db, close, dataDir);
});

test('每行 ≤ 75 octets（RFC 5545 行折叠）', () => {
  const ics = buildICalendarText({
    calName: '第一届',
    events: [{
      uid: 'stage-1@heikesong.local',
      summary: '这是一个非常非常非常长的赛段标题，用来触发 RFC 5545 的行折叠规则，必须被折成多行，否则客户端会拒收整个文件',
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-10T00:00:00.000Z',
    }],
    now: '2026-10-20T00:00:00.000Z',
  });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `行太长（${Buffer.byteLength(line, 'utf8')} octets）：${line.slice(0, 40)}…`);
  }
});

test('长行被折叠，续行以一个空格开头，取消折叠后内容还原', () => {
  const summary = '长标题'.repeat(60);
  const ics = buildICalendarText({
    events: [{ uid: 'u1', summary, start: '2026-10-01T00:00:00.000Z' }],
    now: '2026-10-20T00:00:00.000Z',
  });
  const physical = ics.split('\r\n');
  assert.ok(physical.some((l) => l.startsWith(' ')), '必须有续行');
  const flat = unfold(ics);
  assert.ok(flat.includes(`SUMMARY:${summary}`), '取消折叠后内容必须还原');
});

test('逗号 / 分号 / 反斜杠 / 换行被转义', () => {
  assert.equal(escapeICalText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const ics = buildICalendarText({
    events: [{ uid: 'u1', summary: 'A,B;C\\D', start: '2026-10-01T00:00:00.000Z' }],
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.ok(ics.includes('SUMMARY:A\\,B\\;C\\\\D'), '文本里的特殊字符必须转义');
});

test('formatICalTimestamp 输出 UTC 秒级时间戳', () => {
  assert.equal(formatICalTimestamp('2026-10-01T09:30:00.000Z'), '20261001T093000Z');
  assert.equal(formatICalTimestamp(new Date('2026-12-31T23:59:59.000Z')), '20261231T235959Z');
});

test('foldICalLine 不劈开多字节字符', () => {
  const line = `SUMMARY:${'赛段'.repeat(80)}`;
  const folded = foldICalLine(line);
  for (const part of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 75);
    assert.equal(part.includes('\uFFFD'), false, '不能出现乱码（说明字符被劈开了）');
  }
  assert.equal(folded.replace(/\r\n /g, ''), line, '取消折叠后必须还原');
});

test('折叠宽度用满 75 octets（首段 75 octets；续行 = 74 octets 内容 + 1 个前导空格；末段是余量）', () => {
  const line = `SUMMARY:${'a'.repeat(200)}`;
  const folded = foldICalLine(line);
  const parts = folded.split('\r\n');
  assert.equal(Buffer.byteLength(parts[0], 'utf8'), 75, '首段必须用满 75 octets');
  for (const p of parts.slice(1, -1)) {
    assert.equal(Buffer.byteLength(p, 'utf8'), 75, '续行 = 74 octets 内容 + 1 个前导空格');
  }
  const last = Buffer.byteLength(parts[parts.length - 1], 'utf8');
  assert.ok(last > 0 && last <= 75, `末段是余量，实际 ${last}`);
  assert.equal(folded.replace(/\r\n /g, ''), line);
});

// ── 以下为 P5 Task 5 实跑后补齐的用例（计划原块只覆盖领域层与���务层，
//    新建的 GET /api/public/calendar.ics 路由**零覆盖**）──

test('buildICalendarText 不给 now → 抛错（领域层不读时钟，时间必须由调用方注入）', () => {
  assert.throws(
    () => buildICalendarText({ events: [{ uid: 'u1', start: '2026-10-01T00:00:00.000Z' }] }),
    /now/,
    '缺 now 必须抛错，不能默默取当前时间',
  );
});

test('领域层是纯函数：icalendar.js 不 import node: 内置模块、不用 Date.now()/Math.random()', () => {
  const src = readFileSync(join(here, '..', 'src', 'domain', 'icalendar.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/from\s+['"]node:/.test(code), false, '领域层不得 import Node 内置模块');
  assert.equal(/\bDate\.now\s*\(/.test(code), false, '领域层不得用 Date.now()');
  assert.equal(/\bMath\.random\s*\(/.test(code), false, '领域层不得用 Math.random()');
  assert.equal(/new Date\s*\(\s*\)/.test(code), false, '领域层不得无参构造 Date');
});

test('★ 领域层不含 Node 专属全局：Buffer / process / require / __dirname / __filename', () => {
  // ⚠️ 为什么钉这一条：P6 的演示版把 `src/domain/*.js` **原样拷进浏览器产物**
  //    （platform/scripts/build-demo.js）⇒ 领域层必须在**浏览器**里跑同一套引擎。
  //    `Buffer` 是 Node 专属全局 —— 浏览器里 `Buffer is not defined` ⇒ 整个模块 ReferenceError。
  //    ⛔ `build-demo.js` 的 `assertDomainIsBrowserSafe` **只查 import 说明符、不查 Node 全局**
  //    ⇒ 这类违规它查不出来（见计划文档 T5-C9）。所以这里补一条静态扫描把它钉住。
  const banned = [
    { re: /\bBuffer\b/, name: 'Buffer' },
    { re: /\bprocess\s*\./, name: 'process.' },
    { re: /\brequire\s*\(/, name: 'require(' },
    { re: /\b__dirname\b/, name: '__dirname' },
    { re: /\b__filename\b/, name: '__filename' },
  ];
  const dir = join(here, '..', 'src', 'domain');
  const files = readdirSync(dir).filter((n) => n.endsWith('.js'));
  assert.ok(files.length > 0, '领域层目录不该是空的');
  for (const name of files) {
    // 先剥注释：注释里提到 Buffer 不算「用了 Buffer」
    const code = stripComments(readFileSync(join(dir, name), 'utf8'));
    for (const b of banned) {
      assert.equal(
        b.re.test(code),
        false,
        `src/domain/${name} 不得使用 Node 专属全局 ${b.name}（浏览器里不存在）`,
      );
    }
  }
});

test('★ 换成 TextEncoder/TextDecoder 后折叠语义不变：每行 ≤ 75 UTF-8 字节，拼接后与原文逐字相等', () => {
  const original = `SUMMARY:${'华东区赛段：需求评审与原型验证'.repeat(9)}`;
  const folded = foldICalLine(original);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, '长中文标题必须被折成多行');
  for (const line of lines) {
    assert.ok(
      Buffer.byteLength(line, 'utf8') <= 75,
      `行太长（${Buffer.byteLength(line, 'utf8')} octets）`,
    );
    assert.equal(line.includes('\uFFFD'), false, '不能出现乱码（说明字符被劈开了）');
  }
  // 取消折叠后必须与原文逐字相等（证明换字节 API 没改语义）
  assert.equal(folded.replace(/\r\n /g, ''), original);
});

test('escapeICalText 的空值口径是空串（不是 "null"/"undefined" 字面量）', () => {
  assert.equal(escapeICalText(null), '');
  assert.equal(escapeICalText(undefined), '');
  assert.equal(escapeICalText(''), '');
});

test('formatICalTimestamp 遇到非法时间 → 抛错（不静默产出一个坏时间戳）', () => {
  assert.throws(() => formatICalTimestamp('not-a-date'), /非法时间戳/);
  assert.throws(() => formatICalTimestamp(''), /非法时间戳/);
});

test('每个事件带 DESCRIPTION / LOCATION / URL（赛段说明、赛点、榜单跳转）', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const events = parseEvents(ics);
  for (const ev of events) {
    assert.ok(ev.DESCRIPTION, '缺 DESCRIPTION');
    assert.ok(ev.LOCATION, '缺 LOCATION');
    assert.ok(ev.URL, '缺 URL');
  }
  assert.equal(events[0].LOCATION, '杭州', '赛点取届期城市');
  assert.ok(events[0].URL.includes('stageId=st_1'), 'URL 必须指向该赛段');
  assert.ok(events[0].DESCRIPTION.includes('s1'), 'DESCRIPTION 必须带赛段代号');
  assert.ok(events[0].DESCRIPTION.includes('调研'), 'DESCRIPTION 必须带赛段名');
  cleanup(db, close, dataDir);
});

test('同样的输入产出同样的字节（可复算：不掺入真实时钟）', () => {
  const { db, close, dataDir } = setup();
  const a = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const b = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  assert.equal(a, b, '同一个 now 必须产出逐字相同的日历');
  const c = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-21T00:00:00.000Z' });
  assert.notEqual(a, c, 'now 变了 DTSTAMP 必须变');
  assert.ok(c.includes('DTSTAMP:20261021T000000Z'));
  cleanup(db, close, dataDir);
});

test('日历头字段齐全：VERSION / PRODID / CALSCALE / METHOD / X-WR-CALNAME', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  assert.ok(ics.includes('VERSION:2.0\r\n'));
  assert.ok(ics.includes('PRODID:-//heikesong//platform//CN\r\n'));
  assert.ok(ics.includes('CALSCALE:GREGORIAN\r\n'));
  assert.ok(ics.includes('METHOD:PUBLISH\r\n'));
  assert.ok(ics.includes('X-WR-CALNAME:第一届 · 杭州\r\n'), '日历名取届期名');
  cleanup(db, close, dataDir);
});

test('每个赛段一个 VEVENT：UID 唯一且可追溯到赛段 id', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const events = parseEvents(ics);
  const uids = events.map((e) => e.UID);
  assert.equal(new Set(uids).size, uids.length, 'UID 必须唯一（重复 UID 客户端会互相覆盖）');
  assert.deepEqual(uids.sort(), ['stage-st_1@heikesong.local', 'stage-st_2@heikesong.local', 'stage-st_3@heikesong.local']);
  cleanup(db, close, dataDir);
});

test('赛段起止时间落到 DTSTART/DTEND（日期串按 UTC 零点解析）', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const events = parseEvents(ics);
  assert.equal(events[0].DTSTART, '20261001T000000Z');
  assert.equal(events[0].DTEND, '20261010T000000Z');
  assert.equal(events[2].DTEND, '20261025T000000Z');
  cleanup(db, close, dataDir);
});

test('赛段名里的逗号/分号/反斜杠在服务层同样被转义（不只在纯函数层）', () => {
  const { db, close, dataDir } = setup();
  addStage(db, { id: 'st_x', key: 'sx', name: 'A,B;C\\D' });
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  assert.ok(ics.includes('SUMMARY:A\\,B\\;C\\\\D（sx）'), '特殊字符必须转义');
  cleanup(db, close, dataDir);
});

test('超长赛段名在服务层同样被折叠（且不劈开多字节字符）', () => {
  const { db, close, dataDir } = setup();
  addStage(db, { id: 'st_long', key: 'sl', name: '长'.repeat(80) });
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `行太长：${Buffer.byteLength(line, 'utf8')}`);
    assert.equal(line.includes('\uFFFD'), false, '不能出现乱码');
  }
  assert.ok(unfold(ics).includes(`SUMMARY:${'长'.repeat(80)}（sl）`), '取消折叠后必须还原');
  cleanup(db, close, dataDir);
});

test('buildICalendar 缺 editionId → 400 EDITION_REQUIRED（不静默出一份空日历）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => buildICalendar({ db, now: NOW }),
    (err) => err.status === 400 && err.code === 'EDITION_REQUIRED',
  );
  cleanup(db, close, dataDir);
});

test('HTTP GET /api/public/calendar.ics：带 token → 200 + text/calendar + 原文 CRLF', async () => {
  const s = setup();
  const token = publicToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, res.body);
  assert.equal(res.headers['Content-Type'], 'text/calendar; charset=utf-8');
  assert.ok(res.body.startsWith('BEGIN:VCALENDAR\r\n'), '必须是原文，不是 JSON 字符串');
  assert.ok(res.body.endsWith('END:VCALENDAR\r\n'));
  assert.equal(res.body.includes('\\r\\n'), false, '原文不能被 JSON 转义');
  assert.equal(res.body.replace(/\r\n/g, '').includes('\n'), false, '不允许裸 LF');
  assert.equal(parseEvents(res.body).length, 3);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：无 token → 403 PUBLIC_TOKEN_MISSING（公开 ≠ 无鉴权）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/calendar.ics?editionId=ed_1');
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_MISSING');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：scope 不符 → 403 PUBLIC_TOKEN_SCOPE_MISMATCH', async () => {
  const s = setup();
  const token = publicToken(s.db, { scope: 'leaderboard' });
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_SCOPE_MISMATCH');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：跨届期 token → 403 PUBLIC_TOKEN_EDITION_MISMATCH', async () => {
  const s = setup();
  const token = publicToken(s.db, { editionId: 'ed_other' });
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_EDITION_MISMATCH');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：过期 token → 403 PUBLIC_TOKEN_EXPIRED', async () => {
  const s = setup();
  const token = createPublicToken({
    db: s.db, scope: 'calendar', editionId: 'ed_1',
    expiresAt: '2026-10-19T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  }).token;
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_EXPIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：缺 editionId → 400 EDITION_REQUIRED', async () => {
  const s = setup();
  const token = publicToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：该届期没有赛段 → 200 + 空日历（列表 → 200 + 空集）', async () => {
  const s = setup();
  s.db.exec("INSERT INTO editions (id, name, city, starts_at, ends_at, created_at) VALUES ('ed_2', '第二届', '上海', '2026-11-01', '2026-11-30', '2026-10-01T00:00:00.000Z')");
  const token = publicToken(s.db, { editionId: 'ed_2' });
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_2&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, res.body);
  assert.equal(parseEvents(res.body).length, 0);
  assert.ok(res.body.startsWith('BEGIN:VCALENDAR\r\n'));
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：日历里不泄露企业名与内部身份（公开面只给赛段时间轴）', async () => {
  const s = setup();
  s.db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000051', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL);
  `);
  const token = publicToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, res.body);
  assert.equal(res.body.includes('某银行'), false, '企业名不公示');
  assert.equal(res.body.includes('零售风控助手'), false, '任务包标题不公示');
  cleanup(s.db, s.close, s.dataDir);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --disable-warning=ExperimentalWarning --test test/icalendar.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/icalendar.js'`

- [ ] **Step 3: 创建 `src/domain/icalendar.js`**

```javascript
// src/domain/icalendar.js — RFC 5545 日历文本生成（纯函数）
// 依据：设计文档 §8「公开榜单 API + 赛程 iCal 订阅」；INTERFACES.md §6 `buildICalendar`
// 溯源：R-STG-01（5 赛段时间轴与交付物）—— iCal 把「赛段时间轴」变成机器可读、可订阅的形态
// 借鉴：dribdat 的 iCal 实现思路（MIT）——但【自己写】：
//   零依赖约束（R-OPS-07：只用 Node 标准库），且 dribdat 的实现依赖 Django 生态。
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。now 由调用方传入。
//
// 四个必须处理的点（少一个，主流日历客户端就会拒收整个文件）：
//   ① 行折叠：每行 ≤ 75 octets，续行以一个空格开头
//   ② 转义：逗号 / 分号 / 反斜杠 / 换行（先转义反斜杠，否则会把前面的转义符再转义一次）
//   ③ 行尾：CRLF
//   ④ 时间戳：YYYYMMDDTHHMMSSZ（UTC）
export const ICAL_LINE_MAX_OCTETS = 75;

// ⚠️ ⛔ 领域层必须在**浏览器**里跑同一套引擎（P6 的演示版把 src/domain/*.js 原样拷进浏览器产物）
//    ⇒ 不得用 Node 专属全局（Buffer / process / require / __dirname / __filename）——
//    浏览器里 `Buffer is not defined` ⇒ 整个模块直接 ReferenceError。
//    TextEncoder / TextDecoder 是 **WHATWG Web 标准**（Node ≥ 11 起也是全局）⇒ 两端通用，
//    且**不需要 import 任何 Node 内置模块**。
//    ⚠️ `build-demo.js` 的 `assertDomainIsBrowserSafe` 只查 import 说明符、不查 Node 全局
//    ⇒ 这类违规它查不出来（见计划文档 T5-C9）。
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function escapeICalText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function formatICalTimestamp(value) {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间戳：${value}`);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * 行折叠：超过 75 octets 的行拆成多行，续行以一个空格开头。
 * ⚠️ 不能把一个多字节字符劈成两半（中文标题很容易踩这个坑）。
 */
export function foldICalLine(line) {
  const text = String(line ?? '');
  const bytes = ENCODER.encode(text);
  if (bytes.length <= ICAL_LINE_MAX_OCTETS) return text;

  const parts = [];
  let start = 0;
  let limit = ICAL_LINE_MAX_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // 回退到字符边界：bytes[end] 若是续接字节（10xxxxxx）说明劈开了多字节字符
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(DECODER.decode(bytes.subarray(start, end)));
    start = end;
    limit = ICAL_LINE_MAX_OCTETS - 1; // 续行首字符是空格，占 1 octet
  }
  return parts.map((p, i) => (i === 0 ? p : ` ${p}`)).join('\r\n');
}

export function buildICalendarText({
  calName = '赛事赛程',
  prodId = '-//heikesong//platform//CN',
  events = [],
  now,
}) {
  if (!now) throw new Error('buildICalendarText 需要 now 参数（领域层不读时钟）');
  const stamp = formatICalTimestamp(now);

  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${prodId}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:${escapeICalText(calName)}`);

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.start) lines.push(`DTSTART:${formatICalTimestamp(ev.start)}`);
    if (ev.end) lines.push(`DTEND:${formatICalTimestamp(ev.end)}`);
    lines.push(`SUMMARY:${escapeICalText(ev.summary ?? '')}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeICalText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeICalText(ev.location)}`);
    if (ev.url) lines.push(`URL:${escapeICalText(ev.url)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldICalLine).join('\r\n')}\r\n`;
}
```

- [ ] **Step 4: 在 `src/services/public-api.js` 追加 `buildICalendar`**

在文件顶部导入区加一行：

```javascript
import { buildICalendarText } from '../domain/icalendar.js';
```

在文件末尾追加：

```javascript
/**
 * 赛程日历（iCal）。
 * 溯源：R-STG-01（5 赛段时间轴与交付物）—— 依据 INTERFACES.md §6 / 设计文档 §8
 * @param db        数据库
 * @param editionId 届期
 * @param now       时间（【追加的可选参数】，便于测试注入；不传则取当前时间）
 * @returns ics 文本
 */
export function buildICalendar({ db, editionId, now }) {
  const at = nowIso(now);
  if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
  const edition = srcRepo.getEdition(db, editionId);
  const stages = srcRepo.listEditionStages(db, editionId);
  const events = stages.map((s) => ({
    uid: `stage-${s.id}@heikesong.local`,
    summary: `${s.name}（${s.stage_key}）`,
    description: `赛段 ${s.stage_key}：${s.name}`,
    start: s.starts_at,
    end: s.ends_at ?? addOneDay(s.starts_at),
    location: edition?.city ?? null,
    url: `/leaderboard?stageId=${encodeURIComponent(s.id)}`,
  }));
  return buildICalendarText({
    calName: edition?.name ?? '黑客松赛程',
    events,
    now: at,
  });
}

function addOneDay(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 86400000).toISOString();
}
```

- [ ] **Step 5: 在 `src/http/routes/public.js` 追加日历路由**

把导入区改成：

```javascript
import { getPublicLeaderboard, buildICalendar, resolvePublicToken } from '../../services/public-api.js';
```

在 `registerPublicRoutes` 里追加：

```javascript
  // 赛程日历（iCal）。⛔ 同样要 token：公开 ≠ 无鉴权。
  // 溯源：R-STG-01（5 赛段时间轴与交付物）—— 依据 INTERFACES.md §6 / 设计文档 §8
  router.add('GET', '/api/public/calendar.ics', async ({ query }) => {
    resolvePublicToken({
      db, token: query.token, requiredScope: 'calendar', editionId: query.editionId,
    });
    const body = buildICalendar({ db, editionId: query.editionId });
    return { __rawText: true, body, contentType: 'text/calendar; charset=utf-8' };
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --disable-warning=ExperimentalWarning --test test/icalendar.test.js`
Expected: PASS（**31** 个测试全过：icalendar.test.js 31）

Run: `cd platform && node --disable-warning=ExperimentalWarning --test`
Expected: 全部通过（P0–P5 累计：**1107** 例 / 通过 1106 / 失败 0 / 跳过 1）

Run: `cd platform && node --disable-warning=ExperimentalWarning --test`
Expected: 全部通过（P0–P5 累计：**1104** 例 / 通过 1103 / 失败 0 / 跳过 1）

- [ ] **Step 7: 提交**

```bash
git add platform/src/domain/icalendar.js platform/src/services/public-api.js \
  platform/src/http/routes/public.js platform/test/icalendar.test.js
git commit -m "feat(P5): iCal 日历导出（手写 RFC 5545，零依赖）

对应设计文档 §8 公开日历订阅（R-STG-01 赛段时间轴）：
- 行折叠 ≤75 octets、逗号/分号/反斜杠转义、CRLF 行尾、UTC 时间戳
- 日历接口同样要 token（scope=calendar）" -- \
  platform/src/domain/icalendar.js platform/src/services/public-api.js \
  platform/src/http/routes/public.js platform/test/icalendar.test.js
```

---

### Task 6: 前端任务清单页 + 端到端验收

**Files:**
- Create: `platform/web/views/tasks.js`
- Modify: `platform/web/app.js`（注册 `/tasks/:workflowId` 路由 + 把路由参数透传给视图）
- Test: `platform/test/workflow-e2e.test.js`

**Interfaces:**
- Consumes: Task 2–5 的服务与路由；P0 的 `createApp` / `createSession` / `can`
- Produces:
  - `web/views/tasks.js` → `renderTasks(ctx)`：任务清单页（**可领取的 / 我领取的 / 已完成的** 三段）
  - 端到端验收：工作流 → 任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜单

> **⚠️ 本 Task 的边界**
> 前端**只做任务清单页**。⛔ 不做三池前台页面（设计文档 §1.2：一期三池只做底座），
> ⛔ 前端不做任何可见性过滤（过滤在 API 层完成——前端隐藏 = 数据已泄露）。
> 页面上的任务**只有"自主领取"一个入口**：不出现"指派给某人""按岗位分工"这类控件（R-OPS-14）。

- [ ] **Step 1: 写失败的测试**

`platform/test/workflow-e2e.test.js`：

```javascript
// platform/test/workflow-e2e.test.js —— P5 Task 6 端到端验收 + 前端任务清单页
//
// 规则溯源：
//   - R-OPS-13 任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成
//   - R-OPS-14 禁止岗位制：任务**只能自主领取**（⛔ 页面不得出现指派 / 按岗位分工的控件）
//   - 「前端只渲染，不做过滤」→ 可见性在 API 层完成（设计文档 §6.6）——前端隐藏 = 数据已泄露
//
// ⚠️ 本文件覆盖**三块**（计划原块只覆盖第 ① 块）：
//   ① 后端闭环：建工作流 → 建任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜
//   ② 前端视图的**纯函数**：三段分类 / 可用操作 / 行内容（P1 的 web/views/*.js 同款做法）
//   ③ 前端**接线**：web/app.js 注册了 /tasks/:workflowId 且把路由参数透传给视图
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { createPublicToken } from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';
import { stripComments } from '../test-helpers/strip-comments.js';
import {
  classifyTasks, taskMode, taskActions, buildTaskItem, buildTaskSections,
} from '../web/views/tasks.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });

  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000041', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_b', '乙', '13900000042', 'x', 'other', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_admin', '组委会', '13900000043', 'x', 'mba', '组委会', 1, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_admin', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO teams (id, edition_id, name, captain_id, task_package_id, tier, status, created_at, deleted_at)
    VALUES ('tm_1', 'ed_1', '一队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'ed_1', '二队', 'u_b', 'tp_1', 'D', 'active', '2026-10-01T00:00:00.000Z', NULL);
    -- ⚠️ P1 建了部分唯一索引 idx_team_members_active(user_id) WHERE left_at IS NULL：
    --    「同一人只能同时在一个战队」，所以 u_b 只能在一支队里
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL),
           ('tm_2', 'u_b', 'captain', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL);
    INSERT INTO points_ledger (id, edition_id, stage_id, team_id, user_id, kind, points, created_at)
    VALUES ('pl_1', 'ed_1', 'st_1', 'tm_1', 'u_a', 'stage_rank', 10, '2026-10-10T00:00:00.000Z');
  `);

  return { db, close, dataDir, app };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

test('端到端：工作流 → 任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜单', async () => {
  const { db, close, dataDir, app } = setup();
  const member = createSession(db, 'u_a', { ttlDays: 1 });
  const admin = createSession(db, 'u_admin', { ttlDays: 1 });

  // ① 工作流（任务包 → 工作流）
  const wfRes = await call(app, 'POST', '/api/workflows', {
    token: member.token,
    body: { editionId: 'ed_1', taskPackageId: 'tp_1', name: '风控助手工作流' },
  });
  assert.equal(wfRes.status, 200, wfRes.body);
  const workflowId = JSON.parse(wfRes.body).workflow.id;

  // ② 任务清单（工作流 → 任务）
  const taskRes = await call(app, 'POST', `/api/workflows/${workflowId}/tasks`, {
    token: member.token,
    body: { title: '跑通风控模型', detail: '需要一个可演示的 demo', ownerTeamId: 'tm_1', dueAt: '2026-10-12' },
  });
  assert.equal(taskRes.status, 200, taskRes.body);
  const taskId = JSON.parse(taskRes.body).task.id;

  // ③ 看到任务清单
  const listRes = await call(app, 'GET', `/api/workflows/${workflowId}/tasks`, { token: member.token });
  assert.equal(listRes.status, 200);
  const tasks = JSON.parse(listRes.body).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'todo');
  assert.equal(tasks[0].claim, null);

  // ④ 自主领取
  const claimRes = await call(app, 'POST', `/api/tasks/${taskId}/claim`, {
    token: member.token, body: { teamId: 'tm_1' },
  });
  assert.equal(claimRes.status, 200, claimRes.body);
  assert.equal(JSON.parse(claimRes.body).task.status, 'in_progress');

  // ⑤ 再领一次 → 409（同一任务不能被两个人领取）
  const again = await call(app, 'POST', `/api/tasks/${taskId}/claim`, {
    token: member.token, body: { teamId: 'tm_1' },
  });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(again.body).error.code, 'TASK_ALREADY_CLAIMED');

  // ⑥ 纯文字进度说明 → 400
  const bad = await call(app, 'POST', `/api/tasks/${taskId}/complete`, {
    token: member.token, body: { evidence: { summary: '今天还在弄' } },
  });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error.code, 'EVIDENCE_REQUIRED');

  // ⑦ 带可运行证据完成
  const done = await call(app, 'POST', `/api/tasks/${taskId}/complete`, {
    token: member.token,
    body: { evidence: { kind: 'runnable', summary: '跑通了', artifactUrl: 'https://git.example.com/demo/risk', version: 'v0.1' } },
  });
  assert.equal(done.status, 200, done.body);
  assert.equal(JSON.parse(done.body).task.status, 'done');

  // ⑧ 同步三池
  const syncRes = await call(app, 'POST', '/api/pools/sync', {
    token: admin.token, body: { editionId: 'ed_1' },
  });
  assert.equal(syncRes.status, 200, syncRes.body);
  const sync = JSON.parse(syncRes.body);
  assert.equal(sync.talents.total, 1, '人才池里应该有一个人');

  // ⑨ 人才池读回：积分终生累计
  const talentsRes = await call(app, 'GET', '/api/pools/talents?editionId=ed_1', { token: admin.token });
  assert.equal(talentsRes.status, 200);
  const talents = JSON.parse(talentsRes.body).talents;
  assert.equal(talents.length, 1);
  assert.equal(talents[0].userId, 'u_a');
  assert.equal(talents[0].totalPoints, 10);

  // ⑩ 公开 API 拉榜单（无需登录，带 token）
  // ⚠️ 有效期给到 2099：这个用例走真实时钟，避免"计划隔年执行就必然过期"的时间炸弹
  const { token } = createPublicToken({
    db, scope: 'leaderboard', editionId: 'ed_1', expiresAt: '2099-01-01T00:00:00.000Z', now: '2026-10-20T00:00:00.000Z',
  });
  const pub = await call(app, 'GET', `/api/public/leaderboard?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(pub.status, 200, pub.body);
  const payload = JSON.parse(pub.body);
  const names = payload.stages.flatMap((s) => s.rows.map((r) => r.teamName));
  assert.ok(names.includes('一队'), 'C 段队伍应公示');
  assert.equal(names.includes('二队'), false, 'D 段队伍不公示');
  assert.equal(pub.body.includes('某银行'), false, '企业名不公示');
  assert.equal(pub.body.includes('u_admin'), false, '不泄露内部身份');

  // ⑪ 无 token → 403
  const noToken = await call(app, 'GET', '/api/public/leaderboard?editionId=ed_1');
  assert.equal(noToken.status, 403);

  cleanup(db, close, dataDir);
});

// ── 以下为 P5 Task 6 实跑后补齐的用例（计划原块只覆盖后端闭环，
//    前端任务清单页与 web/app.js 的接线**零覆盖**）──

const TASKS = [
  { id: 't1', title: '没人领的任务', detail: '', status: 'todo', claim: null },
  { id: 't2', title: '我领的', detail: '细节', status: 'in_progress', claim: { userId: 'u_a', teamId: 'tm_1' } },
  { id: 't3', title: '别人领的', detail: '', status: 'in_progress', claim: { userId: 'u_b', teamId: 'tm_2' } },
  { id: 't4', title: '做完了', detail: '', status: 'done', claim: { userId: 'u_a', teamId: 'tm_1' }, completedAt: '2026-10-12T00:00:00.000Z' },
];

test('★ 三段分类：可领取的 / 我领取的 / 已完成的', () => {
  const s = classifyTasks(TASKS, 'u_a');
  assert.deepEqual(s.claimable.map((t) => t.id), ['t1']);
  assert.deepEqual(s.mine.map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(s.done.map((t) => t.id), ['t4']);
});

test('★ 前端不做可见性过滤：每个任务都落进且只落进一段，一个都不丢', () => {
  // ⛔ 「前端隐藏 = 数据已泄露」—— 可见性在 API 层完成。
  //    前端只能**重新分桶**，不能少给一条：少给一条 = 用户看不到自己有权看的任务。
  const s = classifyTasks(TASKS, 'u_a');
  assert.equal(s.claimable.length + s.mine.length + s.done.length, TASKS.length);
  const ids = [...s.claimable, ...s.mine, ...s.done].map((t) => t.id).sort();
  assert.deepEqual(ids, TASKS.map((t) => t.id).sort());
  // 换个登录人，分桶跟着变，但**条数不变**
  const other = classifyTasks(TASKS, 'u_b');
  assert.equal(other.claimable.length + other.mine.length + other.done.length, TASKS.length);
});

test('★ 任务模式：未领=可领取 / 本人领=mine / 他人领=taken / 已完成=done', () => {
  assert.equal(taskMode(TASKS[0], 'u_a'), 'claimable');
  assert.equal(taskMode(TASKS[1], 'u_a'), 'mine');
  assert.equal(taskMode(TASKS[2], 'u_a'), 'taken');
  assert.equal(taskMode(TASKS[3], 'u_a'), 'done');
  assert.equal(taskMode(TASKS[2], 'u_b'), 'mine', '同一个人看自己的任务就是 mine');
});

test('★ R-OPS-14：任务只有一个入口 —— 自主领取；⛔ 没有任何指派 / 按岗位分工的操作', () => {
  assert.deepEqual(taskActions(TASKS[0], 'u_a'), ['claim'], '未领取的任务只有「自主领取」');
  assert.deepEqual(taskActions(TASKS[1], 'u_a'), ['complete', 'release'], '本人领的：可提交完成 / 可释放');
  assert.deepEqual(taskActions(TASKS[2], 'u_a'), [], '别人领的：不可动');
  assert.deepEqual(taskActions(TASKS[3], 'u_a'), [], '已完成的：不可动');
  // ⛔ 白名单：任何模式下都不得出现「指派 / 按岗位」类操作
  const allowed = new Set(['claim', 'complete', 'release']);
  for (const t of TASKS) {
    for (const me of ['u_a', 'u_b', null]) {
      for (const a of taskActions(t, me)) {
        assert.ok(allowed.has(a), `出现了计划外的操作「${a}」`);
      }
    }
  }
});

test('★ 视图源码里没有任何指派 / 岗位控件（剥掉注释后扫）', () => {
  const src = stripComments(readFileSync(join(here, '..', 'web', 'views', 'tasks.js'), 'utf8'));
  for (const word of ['指派', 'assign', 'Assign', '岗位分工', '<select', 'role=']) {
    assert.equal(
      src.includes(word),
      false,
      `任务清单页不得出现「${word}」（R-OPS-14：任务只能自主领取）`,
    );
  }
});

test('★ 行内容：标题与详情必须转义（innerHTML 插值 = 存储型 XSS）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = buildTaskItem({ id: 't', title: evil, detail: evil, status: 'todo', claim: null }, 'u_a');
  assert.equal(html.includes(evil), false, `原始 payload 不得出现在 HTML 里：${html}`);
  assert.equal(/<img/i.test(html), false, `不得出现真实的 <img> 标签：${html}`);
  assert.ok(html.includes('&lt;img'), `payload 必须被转义：${html}`);
});

test('★ 行内容：已完成的任务显示完成时间；无人领取的显示「无人领取」', () => {
  const doneHtml = buildTaskItem(TASKS[3], 'u_a');
  assert.ok(doneHtml.includes('完成于'), doneHtml);
  assert.ok(doneHtml.includes('2026-10-12T00:00:00.000Z'), doneHtml);
  const freeHtml = buildTaskItem(TASKS[0], 'u_a');
  assert.ok(freeHtml.includes('无人领取'), freeHtml);
  const takenHtml = buildTaskItem(TASKS[2], 'u_a');
  assert.ok(takenHtml.includes('领取人：u_b'), takenHtml);
});

test('★ 三段的行内容由同一套纯函数产出（视图与断言不会各写一套）', () => {
  const sections = buildTaskSections(TASKS, 'u_a');
  assert.ok(sections.claimable.includes('没人领的任务'), sections.claimable);
  assert.ok(sections.mine.includes('我领的'), sections.mine);
  assert.ok(sections.mine.includes('别人领的'), sections.mine);
  assert.ok(sections.done.includes('做完了'), sections.done);
  assert.equal(sections.claimable.includes('做完了'), false, '已完成的任务不得出现在「可领取的」里');
});

// ── 前端接线：web/app.js 注册了 /tasks/:workflowId 且把路由参数透传给视图 ──

/** 最小 DOM 桩（同 test/web.test.js 的做法）：够 web/app.js + 任务清单页跑起来 */
function installDom(hash, tasks = []) {
  const calls = [];
  const makeEl = (tag = 'div') => {
    const el = {
      tagName: tag,
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      placeholder: '',
      id: '',
      children: [],
      listeners: {},
      appendChild(child) { el.children.push(child); return child; },
      replaceChildren(...kids) { el.children = kids; },
      addEventListener(evt, fn) { el.listeners[evt] = fn; },
      querySelector(sel) {
        el.__sels = el.__sels ?? {};
        if (!el.__sels[sel]) el.__sels[sel] = makeEl();
        return el.__sels[sel];
      },
      querySelectorAll() { return []; },
    };
    return el;
  };
  const appEl = makeEl('div');
  globalThis.window = {
    location: { search: '', hash },
    addEventListener: () => {},
  };
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => appEl,
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const body = url === '/api/me'
      ? { user: { id: 'u_a', name: '甲' } }
      : { tasks };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, appEl };
}

test('★ web/app.js 注册了 /tasks/:workflowId 且把 workflowId 透传给视图', async () => {
  const { calls, appEl } = installDom('#/tasks/wf_123');
  // ?v=tag → 每个用例一个独立的 app.js 模块实例（ESM 只求值一次）
  await import(`../web/app.js?v=taskroute`);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    calls.some((c) => c.url === '/api/workflows/wf_123/tasks'),
    `路由必须把 workflowId 透传给视图，实际请求：${JSON.stringify(calls)}`,
  );
  // 页面骨架：三段标题都在
  const html = appEl.children?.[0]?.innerHTML ?? '';
  assert.ok(html.includes('可领取的'), `页面必须有「可领取的」段：${html}`);
  assert.ok(html.includes('我领取的'), `页面必须有「我领取的」段：${html}`);
  assert.ok(html.includes('已完成的'), `页面必须有「已完成的」段：${html}`);
});

test('★ 任务清单页的 DOM 接线：无人领取的任务挂「自主领取」按钮，点它发 POST /api/tasks/<id>/claim', async () => {
  const { calls, appEl } = installDom('#/tasks/wf_123', [
    { id: 't1', title: '没人领的任务', detail: '', status: 'todo', claim: null },
  ]);
  await import(`../web/app.js?v=claimbtn`);
  await new Promise((r) => setTimeout(r, 30));
  const wrap = appEl.children?.[0];
  const list = wrap?.querySelector('#task-claimable');
  const li = list?.children?.[0];
  assert.ok(li, '「可领取的」段里应有任务行');
  const btn = li.children.find((c) => c.textContent === '自主领取');
  assert.ok(
    btn,
    `任务行里应有「自主领取」按钮，实际子节点：${JSON.stringify(li.children.map((c) => c.textContent))}`,
  );
  await btn.listeners.click();
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, `点「自主领取」必须发 POST，实际调用：${JSON.stringify(calls)}`);
  assert.equal(post.url, '/api/tasks/t1/claim');
});

test('★ 没有登记 /tasks/:workflowId 的路由 → 渲染「页面不存在」（反向对照：上面的用例不是恒绿）', async () => {
  const { calls } = installDom('#/no-such-page');
  await import(`../web/app.js?v=notasks`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    calls.some((c) => c.url.includes('/api/workflows/')),
    false,
    `未知路由不得触发任务清单请求，实际请求：${JSON.stringify(calls)}`,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/workflow-e2e.test.js`
Expected: FAIL —— `POST /api/workflows` 返回 404（`src/http/routes/workflow.js` 未在 `src/server.js` 挂载，或视图文件不存在）

- [ ] **Step 3: 创建 `web/views/tasks.js`**

```javascript
// web/views/tasks.js — 任务清单页
// 依据：设计文档 §9 前端信息架构「赛段与任务清单 + 自主领取任务」；INTERFACES.md §6 的 P5 API 清单
// 溯源：R-OPS-13（任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成）
// 溯源：R-OPS-14（禁止岗位制：严禁按岗位和身份分工，任务只能自主领取）
//
// ⛔ R-OPS-14：页面上任务**只有「自主领取」一个入口** —— 不出现任何"分给别人/按岗位切分"的控件。
//    这是【刻意的功能缺失】，不是遗漏（探月黑客松因岗位制失败：忙的忙死、闲的闲死、最后一个人说了算）。
//    唯一的取任务路径：POST /api/tasks/:id/claim（自主领取）。
//
// ⚠️ 前端**不做任何可见性过滤**：过滤在 API 层完成 —— 前端隐藏 = 数据已泄露。
//    ⇒ 本视图把 API 返回的任务**原样分桶**呈现，一个都不丢（见 classifyTasks 的分桶恒等式）。
//
// ⚠️ 为什么把分类与操作抽成**纯函数**（与 web/views/team.js 的 buildTeamCards 同款做法）：
//    如果「三段怎么分」「这个任务能做什么」只写在 DOM 回调里，
//    就没有任何东西能断言「页面没有多余控件」—— 把分类逻辑改掉，全量测试照样全绿。
//    抽成纯函数后，这两条**渲染路径**能被直接断言（见 test/workflow-e2e.test.js）。
//
// ⚠️ **源码扫描禁区**（test/workflow-e2e.test.js 剥掉注释后扫本文件）：
//    「指派 / assign / Assign / 岗位分工 / <select / role=」一个字都不许出现在代码里
//    （注释里无所谓）。⇒ 本页不得有下拉选择控件，不得有 role= 属性，不得有 data-role= 这类属性名。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead,
} from '../ui.js';

/** 任务的展示模式 → 中文标签 / 徽章色调（让「我的」和「可领取的」一眼分得开）。 */
const MODE_LABEL = {
  claimable: '待领取',
  mine: '我领取的',
  taken: '他人领取',
  done: '已完成',
};

const MODE_TONE = {
  claimable: 'neutral',
  mine: 'brand',
  taken: 'info',
  done: 'success',
};

/** 三个分段的语义（可领取=neutral / 我的=brand / 已完成=success）。 */
const SECTION_BADGE = {
  claimable: '待领取',
  mine: '我领取的',
  done: '已完成',
};

const EMPTY_VIEW = {
  claimable: {
    title: '暂时没有可领取的任务',
    hint: '这个工作流的任务都已被领走或已完成：等组委会发布新任务，或回工作流索引看看别的赛段。',
  },
  mine: {
    title: '你手上没有任务',
    hint: '在「可领取的」里挑一个领走就算开工 —— 不用等别人分给你。',
  },
  done: {
    title: '还没有已完成的任务',
    hint: '你领走并提交完成的任务会出现在这里（含完成时间），用来复盘。',
  },
};

/**
 * 任务的展示模式（纯函数）。
 * - claimable：无人领取 → 可自主领取
 * - mine：本人领取 → 可提交完成 / 可释放
 * - taken：他人领取 → 不可动
 * - done：已完成
 */
export function taskMode(t, me) {
  if (!t) return 'claimable';
  if (t.status === 'done') return 'done';
  if (!t.claim) return 'claimable';
  return t.claim.userId === me ? 'mine' : 'taken';
}

/**
 * 三段分类（纯函数）：可领取的 / 我领取的 / 已完成的。
 *
 * ⚠️ **分桶恒等**：每个任务恰好落进一段，一个都不丢 ——
 *    这是「前端不做可见性过滤」的**可断言形式**：前端只重新分桶，不隐藏任何一条。
 */
export function classifyTasks(tasks, me) {
  const out = { claimable: [], mine: [], done: [] };
  for (const t of tasks ?? []) {
    const mode = taskMode(t, me);
    if (mode === 'done') out.done.push(t);
    else if (mode === 'claimable') out.claimable.push(t);
    else out.mine.push(t);
  }
  return out;
}

/**
 * 某个任务当前**允许的操作**（纯函数）。
 * ⛔ 只有三种：自主领取 / 提交完成 / 释放。**没有**别的操作。
 */
export function taskActions(t, me) {
  const mode = taskMode(t, me);
  if (mode === 'claimable') return ['claim'];
  if (mode === 'mine') return ['complete', 'release'];
  return [];
}

/**
 * 单行任务的静态内容 HTML（纯函数，不碰 document）。
 * ⚠️ 服务端返回的标题/详情必须转义 —— innerHTML 插值 = 存储型 XSS（设计文档 §14.2 / P0 终审 I-2）。
 */
export function buildTaskItem(t, me) {
  const mode = taskMode(t, me);
  const who = t?.claim ? `领取人：${t.claim.userId}` : '无人领取';
  const parts = [
    `<span class="task-title">${escapeHtml(t?.title)}</span>`,
    badge(MODE_LABEL[mode] ?? mode, MODE_TONE[mode] ?? 'neutral'),
    `<span class="task-meta">${escapeHtml(t?.detail || '')}</span>`,
    `<span class="task-meta">${escapeHtml(who)} · 状态 ${escapeHtml(t?.status)}</span>`,
  ];
  if (mode === 'done') {
    parts.push(`<span class="task-meta">完成于 ${escapeHtml(t?.completedAt || '')}</span>`);
  }
  return parts.join('');
}

/**
 * 三段的行内容 HTML（纯函数）：{ claimable, mine, done }。
 * 段标题写死在 renderTasks 的骨架里（可领取的 / 我领取的 / 已完成的）。
 */
export function buildTaskSections(tasks, me) {
  const s = classifyTasks(tasks, me);
  const rows = (list) => list.map((t) => buildTaskItem(t, me)).join('');
  return { claimable: rows(s.claimable), mine: rows(s.mine), done: rows(s.done) };
}

/** 一个分段的面板骨架（panel 的 class 结构 + 状态徽章与计数）。 */
function sectionHtml(id, title, toneName, desc) {
  return `
    <section class="panel panel--${toneName}">
      <div class="panel__head">
        <div class="row row--between">
          <h2 class="panel__title">${title}</h2>
          <span class="row">
            ${badge(SECTION_BADGE[id], toneName)}
            <span class="muted small" id="task-count-${id}">0 项</span>
          </span>
        </div>
        <p class="panel__desc">${desc}</p>
      </div>
      <div class="panel__body">
        <ul class="task-list" id="task-${id}"></ul>
      </div>
    </section>`;
}

export function renderTasks(ctx) {
  const { api } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'tasks';
  const workflowId = ctx.params?.workflowId ?? '';

  wrap.innerHTML = `
    ${pageHead({
      title: '任务清单',
      sub: '任务只能自主领取 —— 严禁按岗位和身份分工（R-OPS-14）',
    })}
    <div id="task-state"></div>
    <div id="task-msg"></div>
    ${sectionHtml('claimable', '可领取的', 'neutral', '看到合适的就是你的：直接领走，完成后提交可运行产物。')}
    ${sectionHtml('mine', '我领取的', 'brand', '你手上还没交付的任务：填上产物链接与版本号即可提交完成，也可释放给别人。')}
    ${sectionHtml('done', '已完成的', 'success', '已交付的任务（含完成时间），留作复盘与评审依据。')}`;

  const stateBox = wrap.querySelector('#task-state');
  const msgBox = wrap.querySelector('#task-msg');
  const lists = {
    claimable: wrap.querySelector('#task-claimable'),
    mine: wrap.querySelector('#task-mine'),
    done: wrap.querySelector('#task-done'),
  };
  const counters = {
    claimable: wrap.querySelector('#task-count-claimable'),
    mine: wrap.querySelector('#task-count-mine'),
    done: wrap.querySelector('#task-count-done'),
  };

  // ⚠️ 重试用事件委托：errorState() 的重试按钮没有固定 id，委托到容器更稳。
  stateBox.addEventListener('click', (ev) => {
    if (ev.target?.dataset?.action === 'retry') void load();
  });

  /** 操作结果提示（成功 / 失败都出声，不静默）。 */
  function showMsg(toneName, title, text) {
    msgBox.innerHTML = noticeState({ tone: toneName, title, items: text ? [text] : [] });
  }

  async function load() {
    stateBox.innerHTML = loadingState({ rows: 2, label: '正在加载任务清单…' });
    try {
      const res = await api.get(`/api/workflows/${encodeURIComponent(workflowId)}/tasks`);
      const tasks = res?.tasks ?? [];
      const me = ctx.getState?.().user?.id ?? null;
      renderAll(tasks, me);
      stateBox.innerHTML = '';
    } catch (e) {
      stateBox.innerHTML = errorState({
        message: e.message || '加载任务清单失败',
        hint: '任务清单没拉到。可以重试；若持续失败，确认这个工作流还在进行中。',
      });
    }
  }

  function renderAll(tasks, me) {
    const s = classifyTasks(tasks, me);
    fill(lists.claimable, s.claimable, me, 'claimable');
    fill(lists.mine, s.mine, me, 'mine');
    fill(lists.done, s.done, me, 'done');
    counters.claimable.textContent = `${s.claimable.length} 项`;
    counters.mine.textContent = `${s.mine.length} 项`;
    counters.done.textContent = `${s.done.length} 项`;
  }

  function fill(ul, tasks, me, kind) {
    ul.replaceChildren();
    if (!tasks.length) {
      const li = document.createElement('li');
      li.innerHTML = emptyState(EMPTY_VIEW[kind]);
      ul.appendChild(li);
      return;
    }
    for (const t of tasks) ul.appendChild(renderTask(t, me));
  }

  function renderTask(t, me) {
    const li = document.createElement('li');
    li.className = `task task-${taskMode(t, me)}`;
    li.innerHTML = buildTaskItem(t, me);

    // ⛔ 只按 taskActions 给控件 —— 没有任何别的任务操作可加
    for (const action of taskActions(t, me)) {
      if (action === 'claim') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--primary btn--sm';
        // ⚠️ textContent 必须**恰好**是这四个字（测试断言 === '自主领取'）
        btn.textContent = '自主领取';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/claim`, {});
            showMsg('success', '已领取', `任务「${t.title}」现在在你手上。`);
            await load();
          } catch (e) {
            btn.disabled = false;
            showMsg('danger', '领取失败', e.message || '领取失败');
          }
        });
        li.appendChild(btn);
      }

      if (action === 'complete') {
        // ⚠️ 两个输入都要有**可见标签**（.field__label）—— 打磨前是两个裸 input，填什么都不清楚。
        const artifact = makeField('产物链接', 'task-artifact', 'https://…（仓库或演示地址）');
        const version = makeField('版本号', 'task-version', '如 v0.1');
        li.appendChild(artifact.wrap);
        li.appendChild(version.wrap);

        const note = document.createElement('p');
        note.className = 'task-meta';
        li.appendChild(note);

        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'btn btn--primary btn--sm';
        done.textContent = '提交完成';
        done.addEventListener('click', async () => {
          const url = artifact.input.value.trim();
          const ver = version.input.value.trim();
          if (!url && !ver) {
            // ⚠️ 本地拦下：两个都空就发请求，服务端只会回一句 EVIDENCE_REQUIRED。
            note.className = 'field__error';
            note.textContent = '产物链接与版本号至少填一项（两项都空的完成申请会被服务端拒收）';
            return;
          }
          done.disabled = true;
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/complete`, {
              evidence: {
                kind: 'runnable',
                summary: url
                  ? `已提交可运行版本 ${ver || '未标注版本'}`
                  : '已提交可运行版本',
                artifactUrl: url,
                version: ver,
              },
            });
            showMsg('success', '已提交完成', `任务「${t.title}」已标记完成。`);
            await load();
          } catch (e) {
            done.disabled = false;
            note.className = 'field__error';
            note.textContent = e.message || '提交失败';
          }
        });
        li.appendChild(done);

        const release = document.createElement('button');
        release.type = 'button';
        release.className = 'btn btn--ghost btn--sm';
        release.textContent = '释放任务';
        // ⚠️ 释放是"把机会让给别人"：先要点一次确认，避免手滑就放手。
        let armed = false;
        release.addEventListener('click', async () => {
          if (!armed) {
            armed = true;
            release.textContent = '确认释放';
            note.className = 'task-meta';
            note.textContent = '再点一次「确认释放」生效；释放后别人就能领走这个任务。';
            return;
          }
          release.disabled = true;
          try {
            await api.post(`/api/tasks/${encodeURIComponent(t.id)}/release`, {});
            showMsg('success', '已释放', `任务「${t.title}」已放回可领取池。`);
            await load();
          } catch (e) {
            release.disabled = false;
            note.className = 'field__error';
            note.textContent = e.message || '释放失败';
          }
        });
        li.appendChild(release);
      }
    }

    return li;
  }

  /** 带可见标签的输入（.field + .field__label + .input）。 */
  let fieldSeq = 0;
  function makeField(labelText, idPrefix, placeholder) {
    fieldSeq += 1;
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.className = 'field__label';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'input';
    input.id = `${idPrefix}-${fieldSeq}`;
    input.placeholder = placeholder;
    label.htmlFor = input.id;
    field.appendChild(label);
    field.appendChild(input);
    return { wrap: field, input };
  }

  void load();
  return wrap;
}
```

- [ ] **Step 4: 修改 `web/app.js`（注册路由 + 透传路由参数）**

在导入区加一行：

`web/app.js`（导入行 · 核验锚点）

```javascript
import { renderTasks } from './views/tasks.js';
```

在既有路由注册之后追加一行（⛔ 必须在文件末尾的 `render()` **之前** —— 否则首屏路由匹配不到，
页面会先渲染一次「页面不存在」）：

`web/app.js`（路由注册行 · 核验锚点）

```javascript
route('/tasks/:workflowId', (c) => renderTasks(c));
```

⚠️ **这一步 P0 终态已经做过了**：`web/app.js` 的 `render()` 里**已经**是
`found.view({ ...ctx, params: found.params, query: currentQuery() })` —— 路由参数 `params` 与 `query` 都已透传。
**本步不需要再改这一行**；下面这行是**核验用**（实现里必须逐字是它）：

`web/app.js`（render() 透传行 · 核验锚点）

```javascript
    const el = await found.view({ ...ctx, params: found.params, query: currentQuery() });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --disable-warning=ExperimentalWarning --test test/workflow-e2e.test.js`
Expected: PASS（**12** 个用例全过：workflow-e2e.test.js 12）

Run: `cd platform && node --disable-warning=ExperimentalWarning --test`
Expected: 全部通过（P0–P5 累计：**1119** 例 / 通过 1118 / 失败 0 / 跳过 1）

- [ ] **Step 6: 人工验收任务清单页**

Run: `cd platform && node scripts/migrate.js && node scripts/seed.js && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

Run: 浏览器打开 `http://127.0.0.1:8080/#/tasks/<workflowId>`（workflowId 来自 `POST /api/workflows` 的返回）
Expected: 页面分三段显示「可领取的 / 我领取的 / 已完成的」；点「自主领取」后任务移入「我领取的」；页面**没有**任何指派/岗位控件

- [ ] **Step 7: 提交**

```bash
git add platform/web/views/tasks.js platform/web/app.js platform/test/workflow-e2e.test.js
git commit -m "feat(P5): 任务清单前端页 + 端到端验收（工作流→任务→领取→完成→同步→公开榜）

对应 R-OPS-13 / R-OPS-14 / R-POOL-01~04 / R-RNK-10：
- 页面只有自主领取入口，无任何按岗位指派的控件
- 端到端跑通公开 API 拉榜，D 段队伍不公示" -- \
  platform/web/views/tasks.js platform/web/app.js platform/test/workflow-e2e.test.js
```

---

## P5 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P5-1 | 迁移 006 建出七张表 | `cd platform && node --test test/pools-migration.test.js` 通过；`node scripts/migrate.js` 输出「迁移完成，当前版本 6」 |
| P5-2 | **同一任务不能被两人同时领取** | `node --test test/workflow-service.test.js` 通过：甲领取成功后乙领取返回 409 `TASK_ALREADY_CLAIMED`，且 `SELECT count(*) FROM task_claims WHERE task_id=? AND released_at IS NULL` 恒为 1；绕过应用层直接第二次 INSERT 被数据库拒绝（部分唯一索引） |
| P5-3 | 完成必须给可运行状态或明确阻塞点，**且不加分** | 同上文件：只传 `summary` → 400 `EVIDENCE_REQUIRED` 且任务状态不变；`kind=runnable` 且带链接+版本 → 200 且状态 `done`、证据落库；`kind=blocked` 且写明阻塞点与解除条件 → 状态 `blocked`；完成一个任务后 `SELECT count(*) FROM points_ledger` 不变（任务完成 ≠ 赛段交付物得分） |
| P5-4 | **禁止岗位制**（刻意缺失） | `grep -nE "assignTask\|assignByRole\|assignTaskByPosition\|dispatchTask\|allocateTask" platform/src/services/workflow.js platform/src/http/routes/workflow.js` 无命中；服务层导出里只有 `claimTask` 能让人拿到任务；`rules/pools.json` 的 `workflow.claimMode` = `self_claim_only`，改成别的值启动即失败 |
| P5-5 | 三池同步幂等 | `node --test test/pools-sync.test.js` 通过：连跑两次同步后三表内容 `deepEqual`；改积分流水后重跑 → 积分为重算值（16）而不是累加值（23） |
| P5-6 | 派生值单一真源 | 同上文件：库里的 `total_points` 等于积分流水聚合；同步时的自检不抛错（若派生源与派生值不一致 → 500 `POOL_TALENT_POINTS_MISMATCH`） |
| P5-7 | **公开 API 鉴权** | `node --test test/public-api.test.js` 通过：无 token → 403 `PUBLIC_TOKEN_MISSING`；过期 → 403 `PUBLIC_TOKEN_EXPIRED`；跨届期 → 403 `PUBLIC_TOKEN_EDITION_MISMATCH`；scope 不符 → 403 `PUBLIC_TOKEN_SCOPE_MISMATCH`；`public_tokens.token` 存的是 SHA-256（长度 64，不等于明文） |
| P5-8 | **公开响应不泄露** | 同上文件：响应体不含 D 段队名、不含签字人姓名、不含企业名、不含互评来源队伍、不含 `enterpriseName`/`signatory`/`peer` 字段；公开行字段集合恰为 `{rank, teamName, tier, total, points, tiedWith}`；源码里显式出现 `applyVisibility` |
| P5-9 | iCal 合法可订阅 | `node --test test/icalendar.test.js` 通过：VEVENT 数 == 赛段数；每行 ≤ 75 octets；行尾全为 CRLF（无裸 LF）；`DTSTART` 形如 `20261001T000000Z`；逗号/分号/反斜杠被转义；长标题被折叠后取消折叠可还原 |
| P5-10 | 任务清单页 + 端到端闭环 | `web/views/tasks.js` 渲染「可领取的 / 我领取的 / 已完成的」三段，页面无任何指派/岗位控件；`node --test test/workflow-e2e.test.js` 通过：建工作流 → 建任务 → 领取 → 完成 → 同步三池 → 人才池读到 `u_a` 积分 10 → 公开 API 榜里有「一队」但没有「二队」、没有「某银行」；无 token 请求公开榜 → 403 |
| P5-11 | **增长飞轮的沉淀物可计量**（R-POOL-04） | `GET /api/pools/projects\|talents\|resources?editionId=ed_1` 分别返回本届沉淀的项目数 / 人才数 / 资源方数；`POST /api/pools/sync` 的返回体给出三池的 `inserted/updated/removed/total`（沉淀量可逐届对比 = 飞轮的第③步「三池沉淀」可计量）；⚠️ 飞轮本身不在一期运行（一期只建沉淀侧与扩散侧） |
| P5-12 | 零依赖 | `node --test test/zero-deps.test.js` 通过；无 `node_modules`、无 `package-lock.json`；`platform/package.json` 的 `dependencies` 仍为 undefined |

---

## 与接口契约的偏差

`INTERFACES.md` 是跨阶段的唯一事实来源。以下是本计划**必须**与它不一致或需要它补充的地方，全部在此登记。

### A. 新增模块（**不改动 `INTERFACES.md` 里任何既有签名**，只是把实现拆到本阶段新建的文件里）

| 文件 | 为什么需要它 |
|---|---|
| `src/domain/pool-derive.js` | 契约只给了三池的**服务层**，但派生值必须是纯函数（无 IO、无 `Date.now()`）。这个文件是「派生值唯一计算点」 |
| `src/domain/task-evidence.js` | 任务完成证据的校验必须是纯函数（R-STG-04）。⚠️ **刻意不叫 `evidence.js`**：P4 已占用 `src/domain/evidence.js`（R-AUD-04 证据三列 + 按发行方去重，是**审计**概念）；这里是 **R-STG-04 的任务完成证据**，是另一个东西。同名不同义 → 后写的阶段覆盖先写的模块，是「同一动作在两份材料里被标成一手与二手」的同构风险 |
| `src/domain/icalendar.js` | iCal 的转义 / 折叠 / 时间戳必须是纯函数；服务层的 `buildICalendar` 只负责取赛段数据 |
| `src/http/routes/workflow.js` / `pools.js` / `public.js` | 路由属于 HTTP 层。**沿用 P1 / P2 已确立的 `src/http/routes/` 约定**（P1：`registration.js` / `taskPackage.js` / `team.js`；P2：`review.js`；P4：`audit.js`）—— 设计文档 §4.3 的目录清单里 `http/` 下就是 `router.js` / `respond.js` / `body.js` / `static.js` / `sse.js` / `routes/`，**顶层从来没有 `src/routes/`**。⚠️ 原写法是跟随 P4 的 `src/routes/*.js` 建议（「更晚 = 更接近终态」）—— 那个建议方向是**反的**，已按 I-4 修正记录改齐 |
| `src/db/repo/teamMembers.js`（**P1 已建**，本阶段**追加** `hasActiveMembership` / `listMemberTeams`） | 只读 P1 的 `team_members`。⚠️ 原写法是**新建** `src/db/repo/team-membership.js` 自建一套只读入口 —— 那样同一张 `team_members` 会出现**两个仓储文件、两套函数**，且 `getTeamById` 与 P1 的 `getTeam` **逐字相同**（将来修一处忘一处 → 「P5 认为在队、P1 认为已离队」的数据分歧）。改为**单一归属**：`team_members` → `teamMembers.js`、`teams` → `teams.js`（`getTeam` / `listTeamRows` 直接复用）。见 I-3 修正记录 |
| `src/db/repo/pool-sources.js` | 三池派生源（teams / stages / stage_results / tier_records / points_ledger / registrations / task_packages / users）的只读入口 |
| `rules/pools.json` | 三池与工作流的规则（包状态过滤 / 积分口径 / 公开 scope / 令牌有效期 / 证据要求 / `claimMode`）——这些是「待组委会确认的机制件」，必须配置化 |

### B. 既有签名的**可选**扩展（保持向后兼容，按契约原样调用仍然成立）

| 契约签名 | 本阶段扩展 | 说明 |
|---|---|---|
| `getPublicLeaderboard({ db, token, editionId })` | `+ rules?, now?` | `rules` 必填实效：不传 → 500 `RULES_MISSING`，**拒绝出数**（不用默认可见性口径凑一份能看的榜单）。`now` 便于测试注入 |
| `buildICalendar({ db, editionId })` | `+ now?` | 时间注入；不传则取当前时间 |
| `syncPoolProjects / syncPoolTalents / syncPoolResources({ db, editionId, now })` | `+ rules?` | 读 `rules.pools`（`packageStatusFilter` / 积分口径）；不传则用契约里的默认值（不过滤状态、原子 kind = stage_rank/mvp/roadshow、rollup = personal_rollup） |
| `listPool*({ db, filter, viewer })` | `filter` 增加 `limit` / `userId` / `minPoints` / `enterpriseId` / `kind` | 纯过滤扩展，返回结构不变 |

### C. 表结构的**追加**（列清单与契约一致，只多列与多索引）

| 项 | 说明 |
|---|---|
| `workflow_tasks` 追加 `evidence_json` / `completed_at` / `completed_by` | 契约的 `workflow_tasks` 只有 8 列。「完成」必须留痕（R-STG-04 要求提交可运行状态或明确阻塞点），否则完成记录无法复核。**这是本计划唯一一处新增的列** |
| `task_claims` 的部分唯一索引 `ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL` | **不新增 `status` 列**，列清单与契约逐字一致；靠部分索引保证「同一任务同时只有一个有效领取」 |
| `pool_projects` / `pool_talents` / `pool_resources` 的自然键唯一索引 | 保证幂等 upsert 与「同一实体只有一行」；索引不是列，不与契约冲突 |
| `public_tokens.token` 存 SHA-256 十六进制 | 与 P0 的 `sessions.token_hash` 同一纪律：库被拖走也拿不到可用的公开令牌。明文只在签发时返回一次。**列名与列类型不变** |

### D. 追加的服务函数与 API（契约未列，但缺了它整条链路断在这里）

| 追加项 | 为什么必须有 | 找谁 |
|---|---|---|
| `createWorkflow({ db, editionId, taskPackageId, name, actorId, now })` | 契约的服务层清单里没有建工作流的入口 → 「任务包 → 工作流」这一段无法落地（R-OPS-13 无载体） | 本阶段新增，不改既有签名 |
| `createWorkflowTask({ db, workflowId, title, detail, ownerTeamId, dueAt, actorId, now })` | 同上，「工作流 → 任务清单」这一段无法落地 | 本阶段新增 |
| `POST /api/workflows` | 建工作流的 HTTP 入口 | 本阶段新增 |
| `POST /api/workflows/:id/tasks` | 建任务的 HTTP 入口 | 本阶段新增 |
| `POST /api/tasks/:id/complete` | 契约的 API 清单里有 `claim` 与 `release`，**唯独漏了 `complete`** → 「领取 → 完成」闭环断在这里 | 本阶段新增 |

### E. 需要上游配合的跨阶段要求（**不是对契约的修改，是把契约落到可执行**）

| 项 | 要求 | 找谁 |
|---|---|---|
| `applyVisibility` 的公开场景（**已按 P3 计划的实际实现对齐**） | P3 的实现：payload 形如 `{ scope, rows }`；context 形如 `{ scope, viewerTeamIds?, viewerTeamId?, tierOrder? }`；`scope='rank'` 分支**只**剔掉互评来源与企业名字段，**不做段位过滤**（段位过滤在 `scope='tier'` 分支）。→ P5 传 `context: { scope: 'rank', public: true, stageId, editionId }`，并**自己**执行段位下限（C 段及以上） | P3（已对齐，无需改动） |
| 公开榜的段位下限由谁执行 | P5 执行（`projectPublicRows`）：段位未知 = 视为未达 C 段 = 不公示（fail-closed）。P3 的 `scope='rank'` 不管这一层，若 P5 不补，**D 段队伍会直接泄进公开榜** | — |
| `applyVisibility` 的失败语义 | 过滤抛错时 P5 记 `visibility_filter_failed` warning 并用自身的严格投影兜底（fail-safe：宁可少给，不可多给），**不静默** | P3（知悉即可） |
| `getLeaderboard` 的行结构 | P5 **不依赖** `getLeaderboard`：公开榜的行由 P5 自己从 `stage_results` + `tier_records` 组装，再用 `applyVisibility` 过滤。P3 的 `getLeaderboard` 返回 `{ scope, stageId, editionId, rows, warnings }`（已过滤），与 P5 自建的 payload 形状一致，替换成本很低 | — |
| `task_packages.status` 的取值枚举 | 契约未给出；P1 的 DDL 默认值是 `'submitted'`，无 CHECK 约束。P5 一期**不按状态过滤**（只过滤软删除），枚举放在 `rules/pools.json` 的 `packageStatusFilter`（默认空数组 = 不过滤） | P1 |
| `team_members` 的 `id` 列 | P1 的实际 DDL 有 `id TEXT PRIMARY KEY`（契约未列）。P5 的测试种子**不写 `id`**——两种形态都能插入（SQLite 允许 NULL 主键），不会因上游改列而炸 | P1 |
| `team_members` 的「一人一队」约束 | P1 建了部分唯一索引 `idx_team_members_active(user_id) WHERE left_at IS NULL` → **同一人同时只能在一支队**。影响两处：① `resolveTeam` 未显式指定队时最多命中 1 支（防御分支保留）；② P5 的测试种子不能把同一人同时塞进两支队（跨届期要写 `left_at`） | P1 |
| `teams.milestones_json` / `task_packages.meta_json` | P1 的契约外新增列（报名时固定的里程碑快照 / 合规与六维评估明细）。P5 的 INSERT **全部显式列名**，不受影响；P5 的 SELECT 只取自己用到的列 | P1 |
| `stages` 的 `key` 列 | P2 的 DDL 里是带引号的 `"key"`。P5 的 SQL 一律写 `s.key`（不带表别名前缀时按 SQLite 规则解析），必要时写 `s."key"` | P2 |
| 错误模块的位置与签名 | **P0 的 Task 4 建 `src/errors.js`**（`AppError` / `appError(status, code, message, detail)`，**status-first**）；P3 已改为**复用**它、**不再建** `src/errors/app-error.js`；P4 只**追加**快捷函数、**不重建**。P5 只用 `src/errors.js` | P0 |

### F. 与契约 §8「阶段间依赖一览」的两处出入

1. **§8 写「P5 ← P0 + P1 + P3」，但 §6 要求 `pool_projects` 从 `stage_results` 派生**——而 `stage_results` 是 **P2** 建的表（契约 §3）。→ **P5 额外只读 P2 的 `stages` 与 `stage_results`**（只读，不写）。
2. **§8 未列 P4，但 P5 消费 P4 的 `src/db/tx.js`（`withTransaction`）**。执行顺序上 P4 在 P5 之前，可用。`src/errors.js` 的 `appError` 由 **P0** 提供（**status-first**），P5 只需 `import { appError } from '../errors.js'`。

### G. 一处口径调和（不是冲突，是把两句话的适用边界写清楚）

- **R-STG-04「纯文字进度说明不给分」** 原文针对的是**赛段交付物打分**（P2/P3 的评审对象）。本阶段只把它用来约束**任务清单的完成记录**：`completeTask` 只写 `workflow_tasks` 的状态与证据，⛔ **不写 `points_ledger`、不写 `behavior_events`、不产生任何分数**。→ **任务完成 ≠ 赛段交付物得分**（有测试断言）。
- **「列表不满足 → 200 + 空集」** 与 **R-AUD-05「空结果必须显式报错」** 适用范围不同：读取类列表（三池、任务清单）仍按三态返回 200 + 空集；**写入/同步类**（同步三池、提交完成状态）返回空才是危险场景 → 一律抛错或 4xx，不返回空成功。

### I. Task 1（工作流与三池数据模型）的偏差

> 逐条核对 `INTERFACES.md` §6 的**列清单**（契约只约束列名，索引不是列）。
> 核对结论：**契约的 7 张表、全部列名，本 Task 一列不多、一列不少**（唯一的多项是 `workflow_tasks` 的 3 列，
> 已在上面的 C 节登记）。下面记的是「计划写法 vs 实际写法」里**需要父代理知情**的部分。

| # | 偏差 | 规格的写法 | 本阶段的写法 | 理由 |
|---|---|---|---|---|
| I-1 | `workflow_tasks` 多 3 列 | 契约 8 列：`id, workflow_id, title, detail, owner_team_id, status, due_at, created_at` | 11 列：追加 `evidence_json` / `completed_at` / `completed_by` | 计划 C 节已登记；R-STG-04 要求「完成」留痕（可运行产物 / 明确阻塞点）。**不追加这 3 列 → 完成记录无法复核** |
| I-2 | 其余 6 张表 | 契约列清单 | **逐字一致**（`workflows` / `task_claims` / `pool_projects` / `pool_talents` / `pool_resources` / `public_tokens`） | 逐列比对通过 |
| I-3 | 索引（契约未列） | 契约只给列清单 | **12 个显式索引**：8 个普通索引（`idx_workflows_edition` / `idx_workflows_package` / `idx_workflow_tasks_workflow` / `idx_workflow_tasks_team` / `idx_task_claims_task` / `idx_task_claims_user` / `idx_pool_talents_user` / `idx_public_tokens_edition`）+ **4 个唯一索引**（`ux_task_claims_active` 部分唯一索引 + 三池自然键唯一索引 `ux_pool_projects_edition_team` / `ux_pool_talents_edition_user` / `ux_pool_resources_edition_enterprise`） | 索引不是列，不与契约冲突；**「同一任务只能有一个有效领取」的唯一载体就是 `ux_task_claims_active`** —— 没有它，本 Task 的灵魂就塌了 |
| I-4 | `edition_id` 要不要外键 | 契约只列列名 | **不加** `REFERENCES editions(id)`（`workflows` / `pool_projects` / `pool_talents` / `pool_resources` / `public_tokens` 五张表） | 计划的 `public_tokens` 测试用例**不建 `editions` 行**就能插入 —— 一旦加外键该用例当场失败。契约 §6 也只约束列名。⚠️ 已知代价：届期维度靠应用层保证，库里可以插出指向不存在届期的行 |
| I-5 | 仓储层的额外导出 | 契约 §6 只列了**服务层** 4 个函数 + 「派生源读取」，没列仓储层函数（P0–P4 也都没列） | 额外导出：`findWorkflowByPackage`（workflows.js）/ `listClaimsByUser`（task-claims.js）/ `listPublicTokens`（public-tokens.js）/ 13 个派生源读取函数（pool-sources.js） | 这些是 Task 2/3/4 的只读入口；契约没规定仓储层导出名（P0–P4 的既有命名法：camelCase 文件名 + 函数名） |
| I-6 | `teamMembers.js` 的归属 | 契约未列仓储层 | **追加**（不重建）`hasActiveMembership` / `listMemberTeams` 到 P1 已建的 `src/db/repo/teamMembers.js` | 计划 I-3 漂移审计已定：同一张 `team_members` 只允许一个仓储文件 |
| I-7 | 测试文件的覆盖面 | 计划写「迁移 006 + 7 张表 + 部分唯一索引 + 三池唯一约束」（5 例） | 13 例：+ 真并发（两连接同时 insert）+ 仓储层 6 例 + 约束矩阵 1 例 | 原 5 例**只覆盖迁移层** → 本 Task 新建的 5 个仓储文件零覆盖，变异检验会全体存活。见文末台账 T1-1 C-1 |

### H. 本阶段的**刻意功能缺失**（不是遗漏，评审时不要当 bug 提）

| 缺什么 | 为什么 |
|---|---|
| 任何「按岗位 / 身份分配任务」的接口、函数、数据列 | **R-OPS-14 禁止岗位制**：任务书 §六「严禁按岗位和身份分工」；探月黑客松因岗位制失败（忙的忙死、闲的闲死、最后一个人说了算）。任务的唯一获得路径是 `claimTask` |
| 三池前台页面 | 设计文档 §1.2：一期只做底座；先让报名/榜单/评审跑通并可复算，三池是这些数据的自然沉淀物，单独做前台会得到「空池无内容」的死界面 |
| 三池的手工写入口 | 派生值单一来源：只能由同步服务写入，手工改一次就会与派生源口径不一致 |
| 任务清单与里程碑的任何联动 | **任务清单 ≠ 里程碑**：里程碑是企业签字的客观事实（报名时固定、不可自行新增，S10 §3.4 / R-STG-03），工作流任务是队内自主领取的工作项。两者不共享表、不共享规则 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*


---

## Task 1 父代理预审修正台账（2026-10-21）

> 执行者：P5 Task 1 实现 Agent。**规格 = 本计划 Task 1 章节**（唯一权威）。
> 本台账记三件事：① 实跑发现的规格缺陷与处置；② 与 `INTERFACES.md` §6 的逐条核对结论；
> ③ 变异检验与测试数字。**落盘文件与本计划 Task 1 的代码块逐字一致**（核验脚本见 T1-4）。

### T1-1 实跑发现的规格缺陷与处置

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| C-1 | Important | Task 1 的测试块**只覆盖迁移层**：本 Task 新建的 5 个仓储文件与 `teamMembers.js` 的两个追加函数**零覆盖** | 把 `getActiveClaim` 的 `AND released_at IS NULL` 删掉后，计划原测试**仍全绿** → 仓储层变异体全部存活 | 已补：测试 5 例 → 13 例（仓储层 6 例 + 约束矩阵 1 例 + 真并发 1 例） |
| C-2 | Important | 计划里的「并发」用例**是串行的**（同一连接先后两次 insert） | 串行的第二次必然撞唯一索引 —— 证明不了「并发下由数据库仲裁」 | 已补：真并发用例（两个 worker 线程 + 两条独立连接 + `SharedArrayBuffer` 屏障），并断言两次 INSERT 的时间区间**重叠**（实测重叠 11–16 ms，8/8 次） |
| C-3 | Important | 两条连接**同时**建立会撞 `PRAGMA journal_mode = WAL`（当时 `busy_timeout` 在它**之后**才设） | 实测 `Error: database is locked`（errcode 261）于 `src/db/sqlite.js:25` | **【已修 —— 上游，main `a6fd2db`】** 父代理在 P5 报出后定位到根因并修在 main：**切 journal_mode 需要独占锁，而别的连接持有写事务（RESERVED 锁）时 SQLite 的 busy handler 不覆盖这一步**（实测 0ms 即抛 SQLITE_BUSY，busy_timeout 对它无效 ⇒ 「只把 `busy_timeout` 提前」**不够**）。修法：busy_timeout 提前 + 切 WAL 改成「已是 `wal` 直接返回（no-op）→ 否则带**退避重试**地切」+ 预算耗尽 fail-fast。回归 4 例（`platform/test/db-concurrency.test.js`），对旧实现**有牙**。⚠️ 限定条件（P4 终审 M-2 实测纠正）：持 **EXCLUSIVE** 锁时 busy handler **仍会**等待 —— 「busy handler 一概不覆盖切 WAL」是过度泛化的说法。本 Task 当时的「握手式错开建立」变通**已不再必要**（可去掉，但保留也无害） |
| C-4 | Minor | Step 10 写「PASS（5 个测试全过）」，与补测后不符 | 实跑 13 例 | 已回写 Step 10 |
| C-5 | Minor | DDL 注释引用的「偏差章节 **D-2 / D-7**」**指向空**（偏差章节实际用 A–H 编号） | 全篇 grep：`D-2` / `D-7` 只出现在引用处，无对应条目 | 登记为知悉项；**未改 DDL 注释**（避免无意义 churn，且注释是计划原文） |
| C-6 | Minor | `TEXT PRIMARY KEY` 在 SQLite 里**允许 NULL**（历史行为）→ `public_tokens.token` **没有** NOT NULL 防线 | 实测：插入 `token = NULL` 成功、不报 NOT NULL；P0–P4 的 id 列全是同一写法 | 已在测试里**钉住**该行为 + 注释说明；沿用 P0–P4 约定，**不在本迁移单点偏离** → 登记为**上游知悉项**（建议全项目统一补 `NOT NULL`） |
| C-7 | Minor | Step 2 的 Expected 只提版本断言，实际另外 4 例也红 | 实跑：`no such table: workflows` / `no such table: public_tokens` | 已回写 Step 2 的 Expected |
| C-8 | Minor | Step 12 的 commit 写法没有 `-- <paths…>` 显式路径 | 本项目提交纪律要求显式路径 | 已回写 Step 12 |
| C-9 | Minor | 计划的围栏代码块**不含 EOF 换行**（闭合围栏另起一行）→ 直接落盘会让 6 个文件缺结尾换行 | 实测：落盘后 `tail -c 1` 为 `0a` 的只有本 Task 之外的旧文件；本 Task 复制的 6 个文件**无**结尾换行 | 已给这 6 个文件**各补一个结尾换行**（对齐仓库既有约定：`platform/src/db/repo/*.js`、`platform/db/migrations/*.sql`、`platform/test/*.js` **全部**以换行结尾）。代码块内容本身**一字未改** |
| — | 核对通过 | §E 说「必要时写 `s."key"`」：实测 `key` 在 SQLite 里**不作关键字** | `SELECT key FROM stages` / `SELECT s.key FROM stages s` 全部 OK | **无缺陷**。`pool-sources.js` 仍按计划写 `"key" AS stage_key` —— 列名映射要用（不是关键字问题） |

### T1-2 与 `INTERFACES.md` §6 的逐条核对结论

| 契约表 | 契约列 | 本 Task 实际列 | 多出的列 |
|---|---|---|---|
| `workflows` | id, edition_id, task_package_id, name, created_at | 同 | 无 |
| `workflow_tasks` | id, workflow_id, title, detail, owner_team_id, status, due_at, created_at | 同 | **`evidence_json` / `completed_at` / `completed_by`**（计划 C 节已登记；R-STG-04 完成留痕） |
| `task_claims` | id, task_id, team_id, user_id, claimed_at, released_at | 同 | 无 |
| `pool_projects` | id, edition_id, team_id, title, industry, stage_reached, tier, business_value, summary, created_at | 同 | 无 |
| `pool_talents` | id, user_id, edition_id, name, org, total_points, mba_status, stages_joined, skills_json, created_at | 同 | 无 |
| `pool_resources` | id, edition_id, enterprise_id, enterprise_name, kind, detail, created_at | 同 | 无 |
| `public_tokens` | token, scope, edition_id, expires_at, created_at | 同 | 无 |

**唯一的列级超出 = `workflow_tasks` 的 3 列。** 其余超出契约的只有**索引**（8 个，其中 4 个是唯一索引），
索引不是列、不与契约冲突 —— 而且 `ux_task_claims_active` 正是本 Task 灵魂（并发唯一领取）的载体。

### T1-3 变异检验与测试数字

| 项 | 数 |
|---|---|
| 变异体总数 | **81**（SQL 38 + workflows.js 9 + task-claims.js 6 + teamMembers.js 3 + pools.js 9 + pool-sources.js 12 + public-tokens.js 4） |
| KILLED（测试变红） | **80** |
| 等价 / 不可观测 | **1**（`L12`：`listStageResultsWithTeams` 的 `LEFT JOIN teams` → `JOIN teams`） |
| **有效缺口** | **0** |
| 锚点问题（命中数 ≠ 1） | **0** |

**`L12` 的等价实证**（不是推理，是探针差分）：`stage_results.team_id TEXT NOT NULL REFERENCES teams(id)`（003_review.sql:203）
+ `PRAGMA foreign_keys = ON` ⇒ 每条 `stage_results` 的 `team_id` 必然存在于 `teams` ⇒ `LEFT JOIN` 与 `JOIN` 等价。
探针差分：**基线快照与变异体快照逐字节相同**（`diff` 为空）。

脚本：`/tmp/p5-mutate/t1.mjs`（指向**已落地**的 `platform/test/pools-migration.test.js`）；
探针：`/tmp/p5-mutate/dump.mjs`（把本 Task 所有仓储读接口的输出打成一个确定性 JSON 快照）。
判定三态：`KILLED`（测试红）/ `SURVIVED-EQUIV`（测试绿 **且** 探针差分为空 ⇒ 等价）/ `SURVIVED-GAP`（测试绿 **但** 探针差分非空 ⇒ 有效缺口）。

| 项 | 数 |
|---|---|
| 新测试文件用例数 | **13**（`test/pools-migration.test.js`） |
| 全量用例数 | **818**（基线 805 + 13），**0 红** |
| 迁移幂等（第 1 次 / 第 2 次） | `迁移完成，当前版本 6` + 本次应用 6 个迁移 / `迁移完成，当前版本 6` + `本次无新迁移` |

### T1-4 计划块逐字核验

核验脚本 `/tmp/p5-t1-sandbox/verify-plan.mjs`：把本计划 Task 1 的每个围栏代码块与**落盘文件**逐字比对
（`whole` 判定整个文件、`suffix` 判定文件尾部追加段；围栏块不带 EOF 换行，落盘文件 = 计划块 + 一个结尾换行，
这一位**显式比对、不做静默归一化** —— 见台账 C-9）。

实跑结果：**9 / 9 个块逐字一致，不一致 0 个**。

| 块 | 目标文件 | 判定 |
|---|---|---|
| 0（javascript） | `platform/test/pools-migration.test.js` | 整个文件 = 计划块 + 结尾换行 |
| 1（sql） | `platform/db/migrations/006_pools.sql` | 整个文件 = 计划块 + 结尾换行 |
| 2（javascript） | `platform/src/db/repo/workflows.js` | 整个文件 = 计划块 + 结尾换行 |
| 3（javascript） | `platform/src/db/repo/task-claims.js` | 整个文件 = 计划块 + 结尾换行 |
| 4（javascript） | `platform/src/db/repo/teamMembers.js` | 追加段 = 文件尾部的逐字后缀（P1 已有部分**未动**） |
| 5（javascript） | `platform/src/db/repo/pools.js` | 整个文件 = 计划块 + 结尾换行 |
| 6（javascript） | `platform/src/db/repo/pool-sources.js` | 整个文件 = 计划块 + 结尾换行 |
| 7（javascript） | `platform/src/db/repo/public-tokens.js` | 整个文件 = 计划块 + 结尾换行 |
| 8（bash） | Step 12 提交命令 | 含 `-- <显式路径>`，且 `-m` 在 `--` 之前 |




---

## Task 2 父代理预审修正台账（2026-10-21）

> 执行者：P5 Task 2 实现 Agent。**规格 = 本计划 Task 2 章节**（唯一权威）。
> 本台账记三件事：① 实跑发现的规格缺陷与处置；② 变异检验结论；③ 测试数字与计划块核验。
> **落盘文件与本计划 Task 2 的代码块逐字一致**（核验见 T2-4）。

### T2-1 实跑发现的规格缺陷与处置

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T2-C1 | Important | 计划 Task 2 的 Files 段要求「Modify: `platform/src/db/repo/teamMembers.js`（本阶段只**追加** `hasActiveMembership` / `listMemberTeams`）」——但**这两个函数已经存在**（P5 Task 1 的 worker 就加好了） | 实跑：`grep -n 'hasActiveMembership\|listMemberTeams' platform/src/db/repo/teamMembers.js` → 第 76 行 / 第 85 行**已存在**。若照计划再实现一次 → 同一张 `team_members` 出现两个定义，且会与 Task 1 的版本**逐字不一致**（「P5 认为在队、P1 认为已离队」的数据分歧） | 以现状为准：**不重建、不重复实现**。Files 段已改写为「Task 1 已追加到位，本阶段不需改」；本 Task **未触碰** `teamMembers.js` |
| T2-C2 | Important | 计划 Task 2 的测试块**判别力不足**：多处期望值「恰好相同」区分不出两种实现；且 403/404/409 的**细分分支**、并发兜底、`behavior_events` 边界**零覆盖** | 实跑（变异探针）：把 `canViewWorkflow` 里 `listTeamRows` 的 `taskPackageId` 过滤删掉（变异 W12）、把 `canViewWorkflow` 的超管分支删掉（W11）、把 `resolveTeam` 的成员校验删掉（W25）—— **计划原 12 例全绿** | 已补：测试 **12 例 → 49 例**（领域纯函数 8 + 建工作流/建任务 7 + 列任务 5 + 领取 8 + 释放 2 + 完成 5 + 两条红线 2 + 真实写入方 1 + 既有 12） |
| T2-C3 | Important | 计划的「完成任务不加分」用例只断言 `points_ledger` 行数不变，**没有断言 `behavior_events`** —— 而红线 ② 写的是「⛔ **不写 `points_ledger`、不写 `behavior_events`**、不产生任何分数」 | 实跑（变异探针）：让 `completeTask` 额外写一条 `behavior_events`（变异 W43）→ **计划原 12 例全绿**（因为它压根不看这张表） | 已补：断言 `points_ledger` / `behavior_events` / `tier_records` **三张表**行数都不变；且**先用真实写入方**（`insertLedgerEntry` / `insertBehaviorEvent`）造出既存行 —— 否则「行数不变」是恒真断言（没有既存行时永远成立） |
| T2-C4 | Minor | 计划的测试种子是**手写 INSERT**，与**真实写入方**的形状不同：`teams.status` 手写成 `'active'`（真实 `insertTeam` 默认 `'forming'`）、`task_packages.status` 手写成 `'approved'`（真实 `createTaskPackage` 产出 `'submitted'`）、`team_members` **不写 `id`**（真实 `insertTeamMember` 写 randomUUID） | 实跑：新增用例里显式断言真实写入方产出的 `teams.status === 'forming'`、`task_packages.status === 'submitted'`。一份偷偷按 `status='active'` 过滤的实现，在计划原种子里**照样绿** —— 这正是本项目踩过的坑：**手造的 input 会让「一致」变成假象** | 已补：「真实写入方的数据照样跑通全链路」用例 —— 全部用仓储层真实写入函数（`createUser` / `createEdition` / `createTaskPackage` / `insertTeam` / `insertTeamMember` / `insertStage` / `insertLedgerEntry` / `insertBehaviorEvent`）造数据，并显式断言前提（forming / submitted） |
| T2-C5 | Minor | 计划原种子让 `team_members.id` 为 NULL（`TEXT PRIMARY KEY` 在 SQLite 里允许 NULL —— Task 1 台账 C-6 已登记同一现象） | 实跑：插入成功；且同一人在两支队的写法会被 P1 的 `idx_team_members_active` 挡下 | 新增用例改用真实写入方 `insertTeamMember`（写真实 UUID）。计划原 12 例的种子**保持原样**（不改动规格既有块） |
| T2-C6 | Minor | 计划的 Step 6 写「Expected: PASS（12 个测试全过：workflow-service.test.js 12）」，补测后与实际不符 | 实跑 **49** 例 | 已回写 Step 6 |
| T2-C7 | Minor | 计划的 Step 7 提交命令没有 `-- <显式路径…>` | 本项目提交纪律：先 `git add <paths…>`，再 `git commit -m "…" -- <paths…>` | 已回写 Step 7 |
| T2-C8 | Minor | 计划的 Files 段把 `teamMembers.js` 列成本 Task 的 Modify 对象，实际不需改 | 见 T2-C1 | 已回写 Files 段 |
| T2-C9 | Important | 计划原「禁止岗位制」用例用 `src.includes('R-OPS-14')` 断言溯源注释 —— 但**任何一处**出现都满足它，规格要求的「这行注释必须留着」没被钉住 | 实跑（变异 `W44`）：删掉 `// R-OPS-14：禁止岗位制，任务只能自主领取。` 这一行后，**计划原 12 例全绿**（文件里还有另外 3 处提到 R-OPS-14） | 已补：断言**整行**注释逐字存在（`src.includes('// R-OPS-14：禁止岗位制，任务只能自主领取')`）→ 复跑 `W44` **KILLED** |
| T2-C10 | Important | 领域校验里「**缺** artifactUrl」与「artifactUrl **形态不对**」是**两条不同的错误**（提示语不同），但计划原用例只断言 `field === 'artifactUrl'` → 两者混同测不出来 | 实跑（变异 `E07`）：把「缺产物」分支短路后（改由「形态不对」分支报错，字段仍是 `artifactUrl`），**计划原 12 例全绿** | 已补：分别断言提示语（缺 → 「必须给出可运行产物」；形态不对 → 「必须是 http(s) 链接」）→ 复跑 `E07` **KILLED** |
| T2-C11 | Important | 可见性的 `editionId` 过滤在**干净数据**上**不可观测** —— `task_package_id` 已经把队限定住了，正常的「跨届期队」本来就带着别的包，漏掉 `editionId` 过滤也看不出来 | 实跑（变异 `W13`）：删掉 `editionId` 过滤后，补测前的用例**仍全绿** | 已补：造一条**刻意的脏数据** —— 「挂在 ed_2 却指向 ed_1 任务包 tp_1 的队」（DDL 允许：`teams.edition_id` 与 `task_packages.edition_id` 之间没有一致性约束，真实写入方 `insertTeam` 也照样写得出来）→ 复跑 `W13` **KILLED** |

### T2-2 变异检验与测试数字

| 项 | 数 |
|---|---|
| 变异体总数 | **72**（领域纯函数 15 + 服务层 57） |
| KILLED（测试变红） | **70** |
| 等价 / 不可观测 | **2**（`W20` 前置检查冗余 / `W27` 分支不可达） |
| **有效缺口** | **0** |
| 锚点问题（命中数 ≠ 1） | **0**（第一轮 `W05` 锚点命中 2 次 → 已把锚点加长到三行 → 第二轮命中 1 次） |

脚本：`/tmp/p5-mutate/t2.mjs`（指向**已落地**的 `platform/test/workflow-service.test.js`）；
探针：`/tmp/p5-mutate/t2-probe.mjs`（把服务层的可观测输出打成一个**确定性** JSON 快照 —— 固定 id 的世界 + UUID 归一化，两次跑逐字节相同，实测 10847 字节）。
判定三态：`KILLED`（测试红）/ `SURVIVED-EQUIV`（测试绿 **且** 探针差分为空 ⇒ 等价）/ `SURVIVED-GAP`（测试绿 **但** 探针差分非空 ⇒ 有效缺口）。

**存活者的定性**（逐个带证据）：

| 变异 | 存活原因 | 证据 |
|---|---|---|
| `W20`「`claimTask` 的『已被领取』**前置检查**被删」 | **等价**（纵深防御冗余）：前置检查与「数据库部分唯一索引 `ux_task_claims_active` + catch 翻译」是**同一约束的两道闸**。删掉前者，后者照样给出**完全相同**的 `409 / TASK_ALREADY_CLAIMED`（同一句提示语），且失败的 INSERT 在 SQLite 里不留任何行（语句级回滚） | **探针差分为空**：基线快照与变异体快照**逐字节相同** —— 错误的 status/code/message 一致，`task_claims` 行集一致，`workflow_tasks.status` 一致。保留前置检查（它少一次无谓的写冲突），但**它不是正确性的来源** —— 正确性来自唯一索引 |
| `W27`「`resolveTeam` 不校验『多队歧义』」 | **不可观测**（上游约束使其不可达）：P1 的部分唯一索引 `idx_team_members_active ON team_members(user_id) WHERE left_at IS NULL` 保证**同一人同时只能在一支队** → `listMemberTeams` 恒返回 ≤ 1 行 → `teams.length > 1` 分支在 P1 约束下**永不可达** | 探针差分为空（探针造不出该状态）。**可达性证据**：`platform/db/migrations/002_registration.sql` 的 `CREATE UNIQUE INDEX idx_team_members_active ON team_members(user_id) WHERE left_at IS NULL` —— 同一 `user_id` 再插一条 `left_at IS NULL` 的成员会撞唯一索引。保留该分支作**纵深防御**（上游若放开「一人一队」，这里不会悄悄选错队） |

> ⚠️ 第一轮变异跑出过 **5 个**存活者（`E07` / `W13` / `W20` / `W27` / `W44`），
> 其中 **3 个是真缺口**，已按「判别性」纪律补测后复跑杀灭：
> `E07`（缺产物与形态不对的错误文案混同 → 补断言提示语）、`W13`（`editionId` 过滤在干净数据上不可观测 → 补造「跨届期队指向同任务包」的脏数据）、
> `W44`（`includes('R-OPS-14')` 会被任何一处出现满足 → 补断言**整行**注释逐字存在）。
> 复跑结果见上表：**有效缺口 0**。

### T2-3 测试数字

| 项 | 数 |
|---|---|
| 新测试文件用例数 | **49**（`test/workflow-service.test.js`：计划原有 12 + 补测 37） |
| 全量用例数 | **871**（基线 822 + 49），**0 红** |
| 单文件耗时 | 约 5.4 s（49 例；含 7 次 scrypt 造数 + 1 次真并发 + 1 次触发器） |

### T2-4 计划块逐字核验

核验脚本 `/tmp/p3fix/plan-blocks.mjs`（整文件块判定：落盘文件去掉结尾换行后与围栏块**逐字**相同）：

```
行  1516 | test/workflow-service.test.js          | 整文件块✅一致   | 块 994 行
行  2520 | src/domain/task-evidence.js            | 整文件块✅一致   | 块 56 行
行  2605 | src/services/workflow.js               | 整文件块✅一致   | 块 220 行
```

**3 / 3 个块逐字一致，不一致 0 个。**（核验命令：
`node /tmp/p3fix/plan-blocks.mjs docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md platform test/workflow-service.test.js src/domain/task-evidence.js src/services/workflow.js`）

> 注：`src/domain/task-evidence.js` 与 `src/services/workflow.js` **一个字都没改** ——
> 计划里的代码块直接就是实现（这两块不需要回写）。唯一被回写的是**测试块**（12 → 49 例）。
---

## Task 3 父代理预审修正台账（2026-10-21）

> 执行者：P5 Task 3 实现 Agent。**规格 = 本计划 Task 3 章节**（唯一权威）。
> 本台账记三件事：① 实跑发现的规格缺陷与处置；② 与 `INTERFACES.md` §6 的逐条核对结论；
> ③ 变异检验与测试数字。**落盘文件与本计划 Task 3 的代码块逐字一致**（核验脚本见 T3-4）。

### T3-1 实跑发现的规格缺陷与处置

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T3-C1 | **Important** | **原计划的 7 例测试盖不住实现的绝大部分行为**：inserted/updated/removed 三个计数、移除路径、列表过滤、规则口径、跨届期刷新、写后自检、rollup 口径分支、告警、`config.js` 的 pools 校验段 —— 全都零覆盖 | 用同一套 94 个变异体跑**原计划那 7 例**：**只杀掉 35 个**，**41 个存活且探针差分非空**（= 真实缺口）。例：`D18 人才池不按积分倒序`、`S05 项目池的陈旧行不删`、`S18 不同届期的同一人的行不再一起刷新`、`D01 rollup 优先被破坏` 全部存活 | **已补**：测试 7 例 → **40 例**（补的是**判别性**用例，不是"再测一遍"）。补完后同一套变异体 **88 杀 / 6 等价 / 0 缺口**（见 T3-3） |
| T3-C2 | Minor | **原计划代码块与 Global Constraints #9 自相矛盾**：约束写明「确定性排序……不用 `localeCompare`」，而 Task 3 的三个派生排序（项目池 teamId、人才池 userId、资源池 enterpriseId+kind）**全都用了 `localeCompare`** | `localeCompare` 的结果依赖运行环境的 ICU/locale —— 同一份数据在两台机器上可能排出不同顺序 ⇒ 榜单不可复算（与「破同分链必须以确定性键收尾」同一条纪律，设计文档 §6.7） | **已改**：三个排序统一走新加的 `compareIds()`（按码位逐字符比，不依赖 locale）。代码块已回写 |
| T3-C3 | Minor | **原计划代码块自建了一个事务助手 `inTransaction`（`BEGIN IMMEDIATE`），而同一份计划的偏差章节 F.2 明写「P5 消费 P4 的 `src/db/tx.js`（`withTransaction`）」** —— 同一件事两处实现 | `BEGIN IMMEDIATE` 在「调用方已经开了事务」时会抛 `cannot start a transaction within a transaction`；Task 4 的 `POST /api/pools/sync` 极可能把同步包在别的事务里。P4 的 `withTransaction` 用 SAVEPOINT（可嵌套） | **已改**：删掉自建版本，直接用 P4 的 `withTransaction`（偏差章节 F.2 的口径）。代码块已回写 |
| T3-C4 | Minor | Step 6/Step 7 的**份数与条数是按 P4 已合入 main 写的**，本分支上对不上：Step 6 说 `FILES` = 16、Step 7 说 `config.test.js` 23 条 | 本分支实测：`Object.keys(FILES).length` = **15**（P4 的 `rules.audit` 命名空间与 `rules/audit.json` **还没并进 P5 分支**）；`node --test test/config.test.js` = **27** 条 | **已回写** Step 6/Step 7 的实测数（15 份 / 27 条 / 40 条）。**份数不写进代码**（`expectedCount` 由 `Object.keys(FILES).length` 派生）⇒ P4 合回 main 时这段**不需要改** |
| T3-C5 | Minor | **写后自检（`POOL_TALENT_POINTS_MISMATCH`）在正确实现下不可达** ⇒ 原计划没给它任何测试 ⇒ 「派生值只能有一个计算点」这条本 Task 的灵魂**没有被验证过** | 可达性分析：写入用 `aggregatePersonalPoints(ledger)`，自检用**同一个**纯函数 + **同一份** ledger ⇒ 除非实现自身不一致，否则恒相等 | **已补**：用 SQLite 触发器模拟「写入路径与重算路径算出不同结果」（`AFTER UPDATE` 触发器把 `total_points` 加 1）⇒ 断言同步**抛 `POOL_TALENT_POINTS_MISMATCH`（500）**。变异体 `S20 自检被摘掉` 被这条用例杀掉 |
| T3-C6 | Minor | **原计划的幂等用例断言的是「内容一致」，而「内容一致」区分不出「重建」与「什么也不做」** —— 同步若整体退化成空操作，幂等用例照样绿 | 原计划第 4 例只 `deepEqual(snapshot)`；变异体「同步不写任何行」在该用例下**不可见** | **已补**：幂等用例改成**判别性**断言 —— 比对**第二次同步的 inserted/updated/removed 计数**、**行 id 是否稳定**、**积分是否翻倍**（23 不是 69）。「空操作」这种变异体现在会红 |
| T3-C7 | Info | `derivePoolResources` 算出了 `packageCount`，但 `pool_resources` **没有这一列**（契约的列清单如此）⇒ 该值算完即丢 | 契约 §6 的 `pool_resources` 列清单 + `006_pools.sql` 的 DDL + `insertPoolResource` 的参数表 | **保持现状**（契约的列清单优先），登记为**已知的信息损失**：`packageCount` 只能从 `detail` 里数，不单独成列 |
| T3-C8 | Minor | **确定性缺口（上游，未修）**：`listEditionTierRecords`（Task 1 的文件）排序是 `ORDER BY tr.team_id, tr.computed_at`，**没有 `tr.id` 兜底** ⇒ 同一支队若出现**同刻**的两条段位记录，取哪条取决于 SQLite 排序的稳定性（**不保证稳定**） | 变异体 `D32`（`at >= prev.at` → `at > prev.at`）在探针数据下**不可观测**（探针里没有同刻记录，差分为空）⇒ 等价/不可观测；但**同刻记录一旦出现，结果就不确定** | **未修**（`pool-sources.js` 是 Task 1 的文件，不在本 Task 范围）⇒ 登记为**上游建议**（给 `ORDER BY` 补 `tr.id`）。同 Task 1 台账 C-3 的处理方式 |
| T3-C9 | Minor | `points_ledger.user_id` 是 `NOT NULL` ⇒ 领域函数里 `if (!userId) continue;` 这道防线**在真实数据上永不触发** | 变异体 `D09`（去掉该防线）探针差分为空 | **保持现状**（纯函数不假设上游一定干净，防线留着）；标注为**不可观测（schema 约束）** |
| T3-C10 | Minor | `task_packages.pain_point` 是 `NOT NULL` ⇒ `derivePoolResources` 里 `titles.length` 与 `details.length` **恒相等**（除非痛点写成空串） | 变异体 `D34`（`packageCount` 换口径）探针差分为空 | **保持现状**；标注为**等价（schema 约束）** |

### T3-2 与 `INTERFACES.md` §6 的逐条核对结论

| 契约签名 | 本 Task 的实现 | 结论 |
|---|---|---|
| `syncPoolProjects({ db, editionId, now })` | 同名同参，**追加可选** `rules`（计划 B 节已登记的可选扩展） | 一致 |
| `syncPoolTalents({ db, editionId, now })` | 同上 | 一致 |
| `syncPoolResources({ db, editionId, now })` | 同上 | 一致 |
| `listPoolProjects({ db, filter, viewer })` → `project[]` | 同名同参；`filter` 追加 `limit`（计划 B 节已登记） | 一致 |
| `listPoolTalents({ db, filter, viewer })` → `talent[]` | 同上 | 一致 |
| `listPoolResources({ db, filter, viewer })` → `resource[]` | 同上 | 一致 |
| 领域纯函数 `derivePoolProjects / derivePoolTalents / derivePoolResources / aggregatePersonalPoints` | 落在 `src/domain/pool-derive.js`（计划 A 节已登记的新增模块） | 一致 |
| 返回结构 `{ editionId, inserted, updated, removed, total, at }` | 三个 sync 全部一致（人才池**多一个** `warnings` —— 计划已声明的告警通道） | 一致 |
| 表结构 | **本 Task 一列未动**（三张池表的 DDL 属 Task 1） | 一致 |

**唯一真源自检**：写入后用**同一个** `aggregatePersonalPoints` 重算比对，不一致抛
`POOL_TALENT_POINTS_MISMATCH`（500）。**这条路径有测试**（触发器制造不一致，见 T3-C5）。

### T3-3 变异检验与测试数字

脚本：`/tmp/p5-mutate/t3.mjs`（指向**已落地**的 `platform/test/pools-sync.test.js`）；
探针：`/tmp/p5-mutate/t3-dump.mjs`（把三池表内容 + 同步计数 + 只读列表 + 领域纯函数输出
打成一个**确定性** JSON 快照；随机 UUID 先归一化成「首次出现序号」，否则差分全是噪声）。
判定三态：`KILLED`（测试红）/ `SURVIVED-EQUIV`（测试绿 **且** 探针差分为空 ⇒ 等价）/
`SURVIVED-GAP`（测试绿 **但** 探针差分非空 ⇒ 有效缺口）。

| 项 | 数 |
|---|---|
| 变异体总数 | **94**（`pool-derive.js` 40 + `services/pools.js` 46 + `config.js` 8） |
| KILLED（测试变红） | **88** |
| 等价 / 不可观测 | **6** |
| **有效缺口** | **0** |
| 锚点问题（命中数 ≠ 1） | **0** |
| 对照：同一套变异体跑**原计划的 7 例** | 35 杀 / 18 等价 / **41 缺口** |

**6 个存活变异体的等价实证**（探针差分逐字节为空，非推理）：

| 变异体 | 为什么等价 | 探针差分 |
|---|---|---|
| `D09` 去掉 `if (!userId) continue;` | `points_ledger.user_id` 是 `NOT NULL` ⇒ 真实数据上永不触发 | 空 |
| `D25` 技能分不兜底 0（`Number(x) \|\| 0` → `Number(x)`） | 画像分是数值：`0 \|\| 0 = 0 = Number(0)`，对任意数值两者相等 | 空 |
| `D32` 同刻的段位记录取先到的那条 | 探针数据里没有同刻记录 ⇒ 不可观测（**残余风险见 T3-C8**） | 空 |
| `D33` 同刻的报名记录取先到的那条 | `registrations` 有部分唯一索引 `(user_id, edition_id) WHERE deleted_at IS NULL` ⇒ 同一人同一届**最多一条有效报名**，比较永远只有一个候选 | 空 |
| `D34` 资源池 `packageCount` 换口径 | `task_packages.pain_point` 是 `NOT NULL` ⇒ `titles.length === details.length` | 空 |
| `S45` 可见性判定不再挡空 viewer | `can()` 自身第一行就是 `if (!user) return false` ⇒ 两道防线等价 | 空 |

| 项 | 数 |
|---|---|
| 新测试文件用例数 | **40**（`test/pools-sync.test.js`；原计划 7 例 + 补测 33 例） |
| 全量用例数 | **862**（基线 822 + 40），**0 红** |
| `test/config.test.js` | **27** 条，0 红 |
| 规则配置份数 | **15** 份（`Object.keys(FILES).length`；P4 的 `rules.audit` 未并入本分支） |

### T3-4 计划块逐字核验

核验脚本 `/tmp/p5-mutate/verify-plan-t3.mjs`（另用 `/tmp/p3fix/plan-blocks.mjs` 复核）：
把本计划 Task 3 的每个围栏代码块与**落盘文件**逐字比对
（`whole` 判定整个文件 = 计划块 + 一个结尾换行；片段块要求在目标文件里**恰好命中 1 次**；
块的位置在 Task 3 章节内**自动枚举**，不写死行号 ⇒ 计划改动后仍可复验）。

实跑结果：**7 / 7 个块逐字一致，不一致 0 个**。

| 块 | 目标文件 | 判定 |
|---|---|---|
| 0（javascript） | `platform/test/pools-sync.test.js` | 整个文件 = 计划块 + 结尾换行 |
| 1（json） | `platform/rules/pools.json` | 整个文件 = 计划块 + 结尾换行 |
| 2（javascript） | `platform/src/domain/pool-derive.js` | 整个文件 = 计划块 + 结尾换行 |
| 3（javascript） | `platform/src/services/pools.js` | 整个文件 = 计划块 + 结尾换行 |
| 4（javascript） | `platform/src/config.js` 的 `FILES` 行 | 片段：在 `src/config.js` 里恰好命中 1 次 |
| 5（javascript） | `platform/src/config.js` 的 `grouped` 行 | 片段：恰好命中 1 次 |
| 6（javascript） | `platform/src/config.js` 的 `validateRules` 段 | 片段：恰好命中 1 次 |

---

## P5 Task 3 修复轮（verifier 审查修复，2026-10-21）

> 执行者：P5 Task 3 修复轮 Agent。**规格 = 本计划 Task 3 章节 + 本章**（唯一权威）。
> 触发：独立 verifier 对 P5 Task 3 交付提出 **3 条 Important + 3 条 Minor**。
> 本章编号从 `T3R-C1` 起 —— 不与 Task 1 的裸 `C-`、Task 2 的 `T2-C`、Task 3 的 `T3-C` 重号。
> **落盘文件与本计划 Task 3 的代码块逐字一致**（核验见 T3R-5）。
> 本轮**没有**改 `INTERFACES.md` 的服务层签名与 API；只追加了 §4 的 `rules/points.json` 示例
> （个人积分口径的规则来源唯一化，见 T3R-C3）与一段说明。

### T3R-1 三条 Important 的处置

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T3R-C1 | **Important（I-2）** | `src/db/repo/pool-sources.js` 的两条 ORDER BY **没有兜底键**：`listEditionTierRecords` 是 `ORDER BY tr.team_id, tr.computed_at`、`listEditionRegistrations` 是 `ORDER BY user_id, created_at` ⇒ 同刻（同 `computed_at` / 同 `created_at`）的多条记录取哪条由 SQLite 的返回顺序决定，**不保证**。消费方 `src/domain/pool-derive.js` 用 `at >= prev.at` 决胜 ⇒ 「后到的那条」本身不确定 | 对照本项目既有纪律：`src/db/repo/points.js` 的 `listLedgerByEdition` / `listBehaviorEventsByTeams` 都用 `ORDER BY created_at ASC, rowid ASC`；`src/db/repo/tiers.js` 的 `getLatestTierRecord` 用 `ORDER BY computed_at DESC, rowid DESC`。`tier_records` **没有** `(team_id, computed_at)` 唯一约束（`db/migrations/004_leaderboard.sql`）⇒ 同刻两条真实存在；`registrations` 的部分唯一索引 `(user_id, edition_id) WHERE deleted_at IS NULL` ⇒ 同一人同一届**最多一条有效报名** | **已修**：① 两处 ORDER BY 补 `rowid` 兜底键（⛔ **不用 `id` 列** —— 那三张表的 id 全是 `randomUUID()`，拿它当排序键就是「逐次运行顺序都不同」，违反硬约束「兜底排序键不得用随机 UUID」）；② 域函数**同时**用行内携带的 `rowid` 做显式比较 ⇒ **不再依赖入参顺序**；③ 补同刻并列的**判别性**用例（id 字典序与插入次序故意相反：先插 `'z-first-inserted'`、后插 `'a-second-inserted'` ⇒ 「按 id 排」与「按写入次序排」结果不同）；④ 同一纪律顺带修掉同文件里 `listEditionLedger` / `listUserLedger` 的 `id` 兜底键 |
| T3R-C2 | **Important（I-1）** | 交付报告称「变异 94 个：88 杀 / 6 等价 / 0 缺口」，但其中 **6 个「等价」里只有 S45 是真等价**；D09 / D25 / D32 / D33 / D34 是**探针固定装置缺判别输入**造成的假等价 | verifier 扩展探针实测差分：D09 ⇒ `byUser` 多出 `"null"` 键；D25 ⇒ `score: 0` → `score: null`；D32 ⇒ `tier: "A"/9` → `"B"/5`；D33 ⇒ `skills: [{b,2}]` → `[{a,1}]`；D34 ⇒ `packageCount: 1` → `0` | **已修**：① 扩展变异探针的固定装置，补入五类判别输入（空 user_id 的流水行 / 非数值维度分 / 同刻两条段位记录 / 同刻两条报名记录 / 有标题无痛点的任务包）；② 为**可观测**的行为补判别性用例（D09 / D25 / D34 各一，D32 / D33 由 T3R-C1 的修法一并覆盖）；③ 重跑变异并**如实报告**新计数（真等价 / 假等价已修 / 有效缺口 三类分开，见 T3R-4） |
| T3R-C3 | **Important（I-3）** | 同一个需求 R-RNK-10「个人积分终生上榜」有**两套独立实现**，读**不同的规则文件**：<br>· `src/domain/points.js` 的 `computePersonalPoints`（P2 立的，被 `src/services/leaderboard.js` 调用，配置 `rules/points.json` 的 `personal`）：**排除** `personal_rollup`、**任何 kind 都计入**（含未知 kind）<br>· `src/domain/pool-derive.js` 的 `aggregatePersonalPoints`（P5 Task 3 立的，被 `src/services/pools.js` 调用，配置 `rules/pools.json` 的 `talentPointKinds`）：**以 rollup 为准**、**只计白名单 kind** | verifier 实测同一份 ledger：`stage_rank=10 + personal_rollup=12` ⇒ 榜单算 **10**、人才池算 **12**；`kind=weird=99` ⇒ 榜单算 **99**、人才池算 **0** | **已修（父代理已拍板的口径）**：① 新增**唯一计算点** `src/domain/personal-points.js` 的 `computePersonalTotals({ ledger, pointsConfig })`；② 两个既有函数**都委托**它（`aggregatePersonalPoints` 输出形状逐字不变；`computePersonalPoints` 保留自己的 1224 名次与输出形状，**P2 的文件只做最小改**）；③ 规则来源唯一化到 `rules/points.json` 的 `personal.atomicKinds` / `personal.rollupKind`（`rules/pools.json` 移除 `talentPointKinds`）；④ 补**跨模块一致性**用例（同一份 ledger ⇒ 每人 total 完全相同；未知 kind 两边都不计入） |

**T3R-C3 的缓解事实（必须写明）**：`personal_rollup` **全仓没有任何写入方** ——
`points_ledger` 只有两个写入点（`src/services/leaderboard.js:327` 写 `stage_rank`、
`:408` 写 `mvp`），没有任何地方写 `personal_rollup` ⇒ 统一口径后「rollup 优先」这条分支
在生产上暂时不可达；且 Task 4 的公开榜单显示的是**队伍名次 / 段位**、不显示个人积分
⇒ 短期不影响公开面。但**设计重复是真实的**（同一需求两处实现、两个规则文件），
本轮已从结构上消除。

### T3R-2 唯一计算点与唯一规则来源（I-3 的落地）

**新增文件** `platform/src/domain/personal-points.js`（P5 建立）—— 逐字内容：

```javascript
// src/domain/personal-points.js — 个人积分的【唯一计算点】（R-RNK-10 终生上榜）
// 依据：任务书 §七 + 设计文档 §6.3 + INTERFACES.md §4
//   「points_ledger.kind: stage_rank | mvp | roadshow | personal_rollup」
//
// ⭐ 本文件是【个人积分口径的唯一实现】。
//    同一个需求 R-RNK-10「个人积分终生上榜」曾经有**两套独立实现**：
//      · src/domain/points.js 的 computePersonalPoints（读 rules/points.json 的 personal）
//        —— **排除** personal_rollup、**任何 kind 都计入**（含未知 kind）
//      · src/domain/pool-derive.js 的 aggregatePersonalPoints（读 rules/pools.json 的 talentPointKinds）
//        —— **以 rollup 为准**、**只计白名单 kind**
//    同一份流水能算出两个不同的名次（实测：stage_rank=10 + personal_rollup=12
//    ⇒ 榜单算 10、人才池算 12；kind=weird=99 ⇒ 榜单算 99、人才池算 0）。
//    现在两处都**委托本模块** ⇒ 口径只有一份、规则只有一个来源
//    （rules/points.json 的 personal 组：atomicKinds + rollupKind + includeMvpVote）。
//
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。时间与规则全部由参数传入。
//
// ── 唯一口径（唯一真源；别处不许另立一套）────────────────────────────
//   ① 有 personal_rollup 行 → total = rollup 之和。
//      rollup 是【别人算好的汇总快照】——它存在，它就是权威值；
//      再把 atomic 加上去就是**重复计分**。它不存在，才只能自己从 atomic 累加。
//      两者都在且不一致 → 产出**显式 warning**（points_ledger_kind_conflict），不静默。
//   ② 否则 → total = atomic 白名单之和（白名单 = rules.points.personal.atomicKinds）。
//   ③ 非白名单 kind → **不计入**，产出 warning（points_kind_ignored）。
//   ④ includeMvpVote === false → mvp kind 不计入。
//   ⑤ 无 userId 的行 → 跳过（⛔ 不产出 "null" 键）。
//
// ⚠️ 为什么「有 rollup 就以 rollup 为准」而不是「排除 rollup」：
//    这两条规则**互斥**，本项目选了后者（rollup 优先）——因为 R-RNK-10 要的是
//    「一个人一生累计到多少分」，而 rollup 行就是为此存在的快照。
//    选「排除 rollup」的话，rollup 存在时总额永远是 atomic 之和，
//    快照就白存了；而 rollup 与 atomic 不一致时又没有任何告警 —— 那才是真正算错。

/** 原子积分 kind 的默认白名单（rules.points.personal.atomicKinds 缺省时的兜底）。 */
export const ATOMIC_POINT_KINDS = ['stage_rank', 'mvp', 'roadshow'];
/** 汇总快照 kind 的默认名（rules.points.personal.rollupKind 缺省时的兜底）。 */
export const ROLLUP_POINT_KIND = 'personal_rollup';

function pick(row, camel, snake) {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

/**
 * 个人积分聚合（**唯一口径**，见文件头注释的五条）。
 *
 * @param {object} p
 * @param {Array} p.ledger 积分流水行（camelCase 或 snake_case 字段名都认）
 * @param {object} p.pointsConfig 规则组（通常是 rules.points；取它的 personal 组）
 * @returns {{ byUser: object, warnings: Array, excludedEntries: number }}
 *   byUser[userId] = {
 *     total,                        // 该人的积分总额（口径①②）
 *     stagesJoined,                 // 参与过的赛段数（去重）
 *     breakdown: { atomic, rollup },// 两种口径各自的和（冲突时一眼看得出）
 *     byKind,                       // 分 kind 的明细（leaderboard 的 byKind 字段）
 *   }
 *   warnings：口径外 kind / rollup 与 atomic 冲突（⛔ 不静默）
 *   excludedEntries：**完全没有被计入**的流水行数（无 userId / 口径外 kind / mvp 被关闭）。
 *     rollup 行与 atomic 行都已被计入（rollup 决定 total、atomic 进 breakdown）⇒ 不计在内。
 */
export function computePersonalTotals({ ledger = [], pointsConfig = {} } = {}) {
  const personal = pointsConfig?.personal ?? {};
  const atomicKinds = Array.isArray(personal.atomicKinds) && personal.atomicKinds.length
    ? personal.atomicKinds
    : ATOMIC_POINT_KINDS;
  const rollupKind = typeof personal.rollupKind === 'string' && personal.rollupKind
    ? personal.rollupKind
    : ROLLUP_POINT_KIND;
  const includeMvpVote = personal.includeMvpVote !== false;
  const eps = 1e-9;

  const byUser = new Map();
  const warnings = [];
  let excluded = 0;

  for (const row of Array.isArray(ledger) ? ledger : []) {
    if (!row) continue;
    // ⑤ 无 userId → 跳过（⛔ 不产出 "null" 键：那会把一个幽灵用户写进人才池/榜单）
    const userId = pick(row, 'userId', 'user_id');
    if (!userId) {
      excluded += 1;
      continue;
    }
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId, atomic: 0, rollup: 0, atomicRows: 0, rollupRows: 0, stages: new Set(), byKind: {},
      });
    }
    const acc = byUser.get(userId);
    const kind = row.kind || 'unknown';
    const points = Number(row.points) || 0;

    if (kind === rollupKind) {
      // ① rollup 行：它就是权威值
      acc.rollup += points;
      acc.rollupRows += 1;
      acc.byKind[kind] = (acc.byKind[kind] || 0) + points;
    } else if (atomicKinds.includes(kind)) {
      if (kind === 'mvp' && !includeMvpVote) {
        // ④ MVP 投决积分被关闭 → 不计入
        excluded += 1;
      } else {
        // ② atomic 白名单内的 kind
        acc.atomic += points;
        acc.atomicRows += 1;
        acc.byKind[kind] = (acc.byKind[kind] || 0) + points;
      }
    } else {
      // ③ 口径外的 kind → 不计入，但**显式告警**（不静默）
      excluded += 1;
      warnings.push({ code: 'points_kind_ignored', userId, kind });
    }

    const stageId = pick(row, 'stageId', 'stage_id');
    if (stageId) acc.stages.add(stageId);
  }

  const out = {};
  for (const acc of byUser.values()) {
    let total;
    if (acc.rollupRows > 0) {
      total = acc.rollup;
      if (acc.atomicRows > 0 && Math.abs(acc.rollup - acc.atomic) > eps) {
        warnings.push({
          code: 'points_ledger_kind_conflict',
          userId: acc.userId,
          rollup: acc.rollup,
          atomic: acc.atomic,
        });
      }
    } else {
      total = acc.atomic;
    }
    out[acc.userId] = {
      total,
      stagesJoined: acc.stages.size,
      breakdown: { atomic: acc.atomic, rollup: acc.rollup },
      byKind: { ...acc.byKind },
    };
  }
  return { byUser: out, warnings, excludedEntries: excluded };
}
```

**唯一规则来源** `platform/rules/points.json`（P3 建立，本轮**追加** `personal` 组的两个键）：

```json
{
  "id": "points",
  "version": "2026-10-20",
  "source": "任务书 §七 + S10 §3.3",
  "stagePoints": [10, 8, 5],
  "stagePointsOnlyTopN": 3,
  "mvp": { "stagesCounted": 4, "roadshowWeight": 1.0, "perPackage": 1 },
  "personal": {
    "lifetime": true,
    "includeMvpVote": true,
    "atomicKinds": ["stage_rank", "mvp", "roadshow"],
    "rollupKind": "personal_rollup"
  },
  "tieRankStyle": "1224",
  "prizeStructure": {
    "resourceToCashRatio": 1.55,
    "source": "R-OPS-12：顶层文档 §3.1 S8「以试点合同/客户资源/现金为主，荣誉类边际效用低；资源:现金 ≈ 1:1.55（CICC 实测）」",
    "note": "资源与现金的相对配比。⚠️ 具体金额未定（首届奖金总额由组委会拍板），此处只存配比与口径，金额由调用方传入 computePrizeShares 的 prizeTable。⛔ 段位权益【不解锁】任何现金（R-PTS-05）。"
  },
  "demoDayAudienceVote": {
    "enabled": false,
    "weight": null,
    "status": "待组委会确认",
    "source": "R-OPS-11：顶层文档 §3.1 S12「线上公开路演 + 企业/投资方在线 + 观众投票权重」",
    "note": "⚠️ 观众票与评审分如何合成，S7 §3.1 的总分公式**没有**这一项 —— 权重取多少、观众票是否进 A 榜、是否只作参考分，目前【无规则依据】。因此本阶段【只占位不启用】：enabled=false 且 weight=null，代码路径存在但恒不生效。启用需要组委会先拍板权重口径，否则就是凭空加一条影响奖金的规则。"
  },
  "fallbackPolicy": {
    "enabled": false,
    "rule": "R-JDG-21",
    "note": "权重回退方案：若首届发现企业给分虚高，企业确认权重回退 15%，差额补给完成度等维度。本阶段【不启用】，仅占位；启用需同时改 rules/scoring-*.json 并重算赛段。",
    "enterpriseWeight": 0.15,
    "redistributeTo": ["completeness"],
    "appliesTo": "scoring.final",
    "status": "首届后回测"
  }
}
```

**唯一口径**（写在 `computePersonalTotals` 的函数头注释里，此处摘要）：

1. 有 `personal_rollup` 行 → `total` = rollup 之和；且与 atomic 之和不一致时产出**显式 warning**
   （`points_ledger_kind_conflict`，不静默）。
2. 否则 → `total` = atomic 白名单之和（白名单 = `rules.points.personal.atomicKinds`）。
3. 非白名单 kind → **不计入**，产出 warning（`points_kind_ignored`）。
4. `includeMvpVote === false` → `mvp` kind 不计入。
5. 无 `userId` 的行 → 跳过（⛔ 不产出 `null` 键）。

**两个既有函数改为委托**：

`platform/src/domain/points.js`（P2 建立，本轮**只做最小改**：加一行 import + 换掉求和部分，
保留 1224 名次与输出形状）：

```javascript
import { computePersonalTotals } from './personal-points.js';
```

```javascript
export function computePersonalPoints({ ledger, pointsConfig }) {
  const personalCfg = pointsConfig?.personal || {};
  const lifetime = personalCfg.lifetime !== false;
  const includeMvpVote = personalCfg.includeMvpVote !== false;

  const { byUser, warnings, excludedEntries } = computePersonalTotals({ ledger, pointsConfig });

  const rows = Object.entries(byUser)
    .map(([userId, agg]) => ({ userId, total: agg.total, byKind: agg.byKind }))
    .sort((a, b) => b.total - a.total || cmpStr(a.userId, b.userId));

  let before = 0;
  let prev = null;
  let curRank = 0;
  for (const r of rows) {
    if (prev === null || r.total !== prev) {
      prev = r.total;
      curRank = before + 1;     // 1224 式：名次 = 本组之前的行数 + 1（并列占位，名次跳号）
    }
    r.rank = curRank;           // ⛔ 并列的行**也必须**拿到名次
    before += 1;
  }
  return { lifetime, includeMvpVote, rows, excludedEntries, warnings };
```

`platform/src/domain/pool-derive.js` 的 `aggregatePersonalPoints` 改为**委派**并把结果投影成
**与本 Task 最初交付时逐字一致**的形状（`{ userId, total, stagesJoined, breakdown }`），
⇒ `src/services/pools.js` 与既有测试不受影响。

**配置校验同步**（`platform/src/config.js` 的 `validateRules`，本轮新增片段）：

```javascript
    // ── 个人积分口径的**唯一规则来源**（R-RNK-10）─────────────────────
    // ⚠️ 这三项（atomicKinds / rollupKind / includeMvpVote）是个人积分口径的全部依据：
    //    缺任何一项，口径就是**未定义**的（两处实现各按各的理解算 ⇒ 两个名次）。
    //    原来 atomicKinds / rollupKind 散在 rules.pools.talentPointKinds 里，
    //    而 rules.points.personal 只有 lifetime / includeMvpVote ⇒ 规则有两份、且不一致。
    const personal = pts.personal;
    if (personal) {
      if (!Array.isArray(personal.atomicKinds) || personal.atomicKinds.length === 0) {
        errors.push('points.personal.atomicKinds 必须是非空数组（个人积分的原子 kind 白名单）');
      } else {
        for (const k of personal.atomicKinds) {
          if (!LEDGER_POINT_KINDS.has(k)) {
            errors.push(`points.personal.atomicKinds 含不存在的积分 kind：${k}（合法取值：${[...LEDGER_POINT_KINDS].join(' / ')}）`);
          }
        }
      }
      if (typeof personal.rollupKind !== 'string' || !personal.rollupKind) {
        errors.push('points.personal.rollupKind 必须是非空字符串（个人积分汇总快照的 kind）');
      } else if (!LEDGER_POINT_KINDS.has(personal.rollupKind)) {
        errors.push(`points.personal.rollupKind 引用了不存在的积分 kind：${personal.rollupKind}`);
      }
      if (personal.includeMvpVote !== undefined && typeof personal.includeMvpVote !== 'boolean') {
        errors.push('points.personal.includeMvpVote 必须是布尔值');
      }
    }
```

`rules/pools.json` 的 `talentPointKinds` **已移除**（口径不再有两份）；
`src/config.js` 的 `rules.pools` 校验段相应改为校验 `rules.points.personal`
（`atomicKinds` 非空数组、`rollupKind` 非空字符串，且两者都必须是**真实存在**的 kind）。

### T3R-3 Minor 的处置

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T3R-C4 | Minor（M-1） | `src/services/pools.js` 的写后自检在 `withTransaction` **之外** ⇒ 事务已 RELEASE 才自检，检测到不一致时**脏值已经提交** | 原实现：自检抛 `POOL_TALENT_POINTS_MISMATCH` 时，`pool_talents` 里的脏行**留在库里** | **已修**：自检挪进 `withTransaction` 回调内，不一致时**在事务内抛错** ⇒ SAVEPOINT 回滚 ⇒ 脏值一条都不落地。补判别性用例：触发器把 `total_points` 加 1 ⇒ 同步抛错 **且**库里仍是同步前的值 |
| T3R-C5 | Minor（M-2） | 同步计数不覆盖**跨届期连带写入**（`updated` 只计本届时）⇒ 「别届期被连带刷新」这件事在计数里看不见 | 原实现：同一个人别届期的行被刷新了，但 `updated` 不动 | **已修**：新增 `updatedOtherEditions` 计数（**不混进 `updated`** —— 契约的 `updated` 语义是「本届时更新了几行」）。这是**追加**字段（契约 §6 的 `{ editionId, inserted, updated, removed, total, at }` 不变） |
| T3R-C6 | Minor（M-3） | ① `rules.pools` 的 fail-fast 只校验**形状**不校验**引用真实存在**（`packageStatusFilter` 的取值写错 ⇒ 过滤掉**全部**任务包 ⇒ 资源池空掉且不报任何错）；② `pool-derive.js` 算出的 `packageCount` 在 `pool_resources` 表里**没有这一列** ⇒ 算了就丢 | `task_packages.status` 的取值域来自唯一写入方 `src/services/taskPackage.js` 的状态机（`submitted → assessed → published \| returned`）；契约 §6 的 `pool_resources` 列清单确实没有 `package_count` | **已修**：① 补交叉引用校验（`packageStatusFilter` ⊆ `TASK_PACKAGE_STATUSES`、`resourceKinds` ⊆ `RESOURCE_KINDS`、`personal.atomicKinds` / `personal.rollupKind` ⊆ 契约的 kind 域）；② `packageCount` **从派生结构去掉** —— 改表结构要么改**已发布**的 `006_pools.sql`（迁移按版本号记账，改内容不会重跑 ⇒ 老库漂移）、要么新增 007 迁移 + 改契约列清单，与「本 Task 一列未动」相悖；条数没有真丢：`detail` 里已经带着全部标题（` / ` 分隔） |
| T3R-C7 | Minor（M-4） | P6 相关，不属于本轮 | — | **不做**（越界：P6 的文件本轮一律不碰） |

`platform/src/db/repo/taskPackages.js`（P1 建立，本轮**追加**一个常量，作为 `task_packages.status`
的**唯一取值域** —— 配置校验读的就是它）：

```javascript
export const TASK_PACKAGE_STATUSES = ['submitted', 'assessed', 'returned', 'published'];
```

### T3R-3b 被改动的测试文件（**逐字**）

口径统一后，P2 的两条断言**必然**要变（不是「放宽断言」，是口径换了之后旧期望值不再成立）；
本轮把它们改成**新口径下的判别性**断言，并把计划里的代码块同步回写。

`platform/test/points.test.js`（P2 的文件，本轮改了 2 条用例）：

```javascript
test('★ computePersonalPoints：终生上榜 + MVP 投决积分可开关 + 1224 并列', () => {
  const ledger = [
    { id: 'l1', userId: 'u_1', kind: 'stage_rank', points: 10 },
    { id: 'l2', userId: 'u_1', kind: 'mvp', points: 31 },
    { id: 'l3', userId: 'u_2', kind: 'stage_rank', points: 10 },
    { id: 'l4', userId: 'u_3', kind: 'personal_rollup', points: 99 },   // 汇总快照：有它就以它为准
    { id: 'l5', userId: 'u_4', kind: 'stage_rank', points: 10 },
    { id: 'l6', userId: 'u_5', kind: 'stage_rank', points: 5 },
  ];
  const on = computePersonalPoints({ ledger, pointsConfig: P });
  assert.equal(on.lifetime, true);
  assert.equal(on.includeMvpVote, true);
  // ⚠️ 口径（P5 修复轮 I-3 统一后的**唯一**口径，见 src/domain/personal-points.js）：
  //    「有 personal_rollup 行 ⇒ 以 rollup 为准；否则 ⇒ atomic 白名单之和」。
  //    原来本函数**排除** personal_rollup、且**任何 kind 都计入** —— 与人才池那套
  //    口径算出的是两个不同的名次（同一份流水 ⇒ 两处不一致）。
  assert.equal(on.rows[0].userId, 'u_3', 'rollup 99 分排第一');
  assert.equal(on.rows[0].total, 99, '有 rollup 行时以 rollup 为准（不是 10+99 也不是 0）');
  assert.equal(on.rows[0].byKind.personal_rollup, 99, '分项来源看得见');
  const u1 = on.rows.find((r) => r.userId === 'u_1');
  assert.equal(u1.total, 41, '赛段积分 + MVP 投决积分');
  assert.equal(u1.byKind.stage_rank, 10);
  assert.equal(u1.byKind.mvp, 31);
  assert.equal(on.excludedEntries, 0, 'rollup 行与 atomic 行都已被计入（rollup 决定 total、atomic 进 breakdown）');
  // 1224 式并列：u_2 与 u_4 都是 10 分 → 并列第 3；下一个（u_5，5 分）名次跳到 5
  assert.deepEqual(on.rows.map((r) => r.rank), [1, 2, 3, 3, 5], '同分并列 → 1224（并列后名次跳号）');

  const off = computePersonalPoints({
    ledger, pointsConfig: { ...P, personal: { ...P.personal, lifetime: true, includeMvpVote: false } },
  });
  const u1off = off.rows.find((r) => r.userId === 'u_1');
  assert.equal(u1off.total, 10, '关闭 MVP 投决积分后只剩赛段积分');
  assert.equal(off.excludedEntries, 1, '只有被关掉的 mvp 那一行没被计入');
  assert.equal(off.includeMvpVote, false);
  // 关掉 MVP 投决后 u_1 / u_2 / u_4 都是 10 分 → 三方并列第 2，u_5（5 分）名次跳到 5
  assert.deepEqual(off.rows.map((r) => r.rank), [1, 2, 2, 2, 5], '三方并列 → 同名次，下一名跳号');
});
```

```javascript
test('computePersonalPoints：无 userId 的条目不参与累加；口径外的 kind 不计入并告警', () => {
  const out = computePersonalPoints({
    ledger: [
      { id: 'l1', kind: 'stage_rank', points: 5 },          // 没有 userId → 跳过
      { id: 'l2', userId: 'u_1', points: 7 },              // 没有 kind → unknown（不在白名单里）
      { id: 'l3', userId: 'u_2' },                         // 缺 points → 按 0 计
    ],
    pointsConfig: P,
  });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].userId, 'u_1');
  // ⚠️ 口径（P5 修复轮 I-3 统一后）：口径外的 kind **不计入**（原来本函数是「任何 kind 都计入」）
  assert.equal(out.rows[0].total, 0, 'unknown 不在白名单里 ⇒ 不计入（不是 7）');
  assert.deepEqual(out.rows[0].byKind, {}, '没被计入的 kind 不进 byKind');
  assert.equal(out.rows[1].userId, 'u_2');
  assert.equal(out.rows[1].total, 0, '缺 points 按 0 计（不产生 NaN）');
  assert.equal(out.excludedEntries, 3, '三行都没被计入：l1 无 userId、l2 与 l3 的 kind 是 unknown');
  assert.ok(
    out.warnings.some((w) => w.code === 'points_kind_ignored' && w.userId === 'u_1' && w.kind === 'unknown'),
    '口径外的 kind 必须显式告警（不静默），且 kind 要能看出是什么',
  );
});
```

`platform/test/leaderboard-migration.test.js`（P3 的文件，`rules.points.personal` 的 deepEqual 跟随新键）：

```javascript
  // ⚠️ personal 组在 P5 修复轮（I-3）里多了两项：atomicKinds / rollupKind ——
  //    个人积分口径的**唯一规则来源**（原来散在 rules.pools.talentPointKinds 与
  //    rules.points.personal 两处，两处口径还不一样）。
  assert.deepEqual(rules.points.personal, {
    lifetime: true,
    includeMvpVote: true,
    atomicKinds: ['stage_rank', 'mvp', 'roadshow'],
    rollupKind: 'personal_rollup',
  });
```

### T3R-4 变异检验的新计数（I-1 的重做）

脚本：`/tmp/p5-mutate/t3r.mjs`（**新**建，不依赖 verifier 的临时目录）→
每个变异体在**独立副本**上跑（`cp -R` 造工作副本，变异只改副本）；
探针：`/tmp/p5-mutate/t3r-dump.mjs`（**扩展**后的固定装置）；
核验：`/tmp/p5-mutate/verify-plan-t3r.mjs`（计划块逐字核验）。

判定三态：`KILLED`（测试红）/ `SURVIVED-EQUIV`（测试绿 **且** 探针差分为空 ⇒ 等价）/
`SURVIVED-GAP`（测试绿 **但** 探针差分非空 ⇒ 有效缺口）。

| 项 | 数 |
|---|---|
| 变异体总数 | **135**（`personal-points.js` 22 + `pool-derive.js` 34 + `pool-sources.js` 8 + `points.js` 3 + `services/pools.js` 49 + `config.js` 15 + `rules/points.json` 2 + `rules/pools.json` 2） |
| KILLED（测试变红） | **133** |
| **真等价**（探针差分**逐字节为空**） | **1**（`S45`） |
| **有效缺口**（探针差分非空） | **0** |
| 已退役（该行为本轮被删除 ⇒ 锚点 0 命中，单独报出） | **1**（`D34`） |
| 锚点问题（命中数 ≠ 1） | **0** |

**上一轮被记成「等价」的 6 个变异体，逐个重判（三类分开，不许混写）**：

| 变异体 | 上一轮的判定 | 本轮的判定 | 依据（实跑） |
|---|---|---|---|
| `D09` 空 user_id 的流水行不再跳过 | 等价（理由：`user_id` 是 `NOT NULL`） | **假等价 → 已修（KILLED）** | 上一轮的理由**事实错误**：`db/migrations/004_leaderboard.sql` 里 `points_ledger.user_id` 是 `TEXT REFERENCES users(id)`，**没有 NOT NULL**；而且真实写入方 `src/db/repo/points.js` 的 `insertLedgerEntry` 写的就是 `userId ?? null` ⇒ 这行流水**真实存在**。不跳过 ⇒ 榜单上多出一个 `userId=null` 的幽灵用户 |
| `D25` 技能分不再兜底 0 | 等价（理由：画像分是数值） | **假等价 → 已修（KILLED）** | 探针固定装置里没有非数值画像分。补一条**纯函数契约用例**：画像分不是数字时按 0 计（不产生 `NaN`）⇒ 变异体变红 |
| `D32` 同刻的段位记录取先到的那条 | 等价（理由：探针里没有同刻记录） | **假等价 → 已修（KILLED）** | `tier_records` 没有 `(team_id, computed_at)` 唯一约束 ⇒ 同刻两条**真实存在**。修法见 T3R-C1，用例见「同刻的段位记录」 |
| `D33` 同刻的报名记录取先到的那条 | 等价（理由：部分唯一索引） | **假等价 → 已修（KILLED）** | 索引那条理由**只对数据库路径成立**（同一人同一届最多一条**有效**报名）；但 `derivePoolTalents` 是**公开纯函数**，直接喂两条同刻记录时结果会随入参顺序变。修法见 T3R-C1：域函数用行内 `rowid` 显式比较 ⇒ 与入参顺序无关；另补一条用例钉住那个唯一索引 |
| `D34` 资源池 `packageCount` 换口径 | 等价（理由：`pain_point` 是 `NOT NULL`） | **真等价 + 已退役** | 等价成立：`task_packages.pain_point` 是 `TEXT NOT NULL`，且唯一写入方 `src/services/taskPackage.js` 的 `submitTaskPackage` 要求痛点**非空** ⇒ `titles.length === details.length` 恒相等。本轮按 M-3 把该字段**从派生结构去掉**（契约的 `pool_resources` 没有这一列 ⇒ 算了就丢）⇒ 变异体**退役**（锚点 0 命中，单独报出，不混进「等价」计数） |
| `S45` 可见性判定不再挡空 viewer | 等价 | **真等价**（维持） | `src/auth/permissions.js:83` 的 `can()` 第一行就是 `if (!user) return false` ⇒ 两道防线等价。**探针差分逐字节为空**（实证） |

**新出现的 4 个「等价」也是逐个判过的**（不是「探针测不到就写等价」）：

| 变异体 | 判定 | 依据 |
|---|---|---|
| `X01` / `X02` 去掉 ORDER BY 的 `rowid` 兜底 | 真等价（**当前引擎**） | SQLite 对相等排序键**恰好**按 rowid 顺序返回 ⇒ 差分为空。但这是**实现细节不是保证** —— 正是本轮要买的那条保证。已用**源码扫描用例**把「必须带 rowid 兜底键」这条纪律本身钉住（`X01`/`X02` 因此变红） |
| `X05` / `X06` 不把 `rowid` 带出来 | 真等价（**当前组合下**） | 域函数退回「按入参顺序」时，结果仍与正确实现相同 —— 因为仓储层的 ORDER BY 仍按 rowid 排。已用「派生源读取必须把 rowid 带出来」的用例钉住（`X05`/`X06` 因此变红） |
| `P11` `rollupKind` 不读配置 | 假等价 → **已修（KILLED）** | 上一轮探针里 `rollupKind` 的配置值与默认值相同 ⇒ 看不出差别。补一条用例：换一个**合法**的 kind（`mvp`）当 rollupKind，口径必须跟着变 |

**变异覆盖的新增面**（本轮每个改动点都有独立变异体）：
`pool-sources.js` 的 4 条 ORDER BY（`X01`–`X04`）与 2 个 SELECT 的 `rowid`（`X05`/`X06`）、
`rowid` 当兜底键（`X07`/`X08`）、域函数的兜底比较（`D32`/`D33`/`D41`/`D42`）、
唯一计算点的 12 条分支（`P01`–`P12`）、规则文件的 4 处取值（`R01`–`R04`）、
`config.js` 的 8 条 fail-fast（`C08`–`C15`）、M-1 的事务边界（`S49`）、M-2 的计数（`S47`/`S48`）。

### T3R-5 计划块逐字核验与实跑数字

核验脚本 `/tmp/p5-mutate/verify-plan-t3r.mjs`（另用 `/tmp/p3fix/plan-blocks.mjs` 复核）：
把本计划 Task 3 的每个围栏代码块与**落盘文件**逐字比对（整文件块 = 计划块 + 一个结尾换行；
片段块要求在目标文件里**恰好命中 1 次**；块的位置按**路径**定位，不写死行号）。
`rules/pools.json` 另用 python **逐字**比对字节（`plan-blocks.mjs` 的 hint 正则只认
`(?:js|html|css|sql|json)`，`.json` 规则文件走单独比对）。

实跑结果：**本轮改动涉及的计划块 4/4 逐字一致**（`src/db/repo/pool-sources.js`、
`test/pools-sync.test.js`、`src/domain/pool-derive.js`、`src/services/pools.js`），
`rules/pools.json` 逐字一致，`src/config.js` 的 3 个片段块逐字命中。

> 说明：核验脚本同时报出 4 个**与本轮无关**的既有不一致
> （`src/db/repo/teams.js`、`src/services/workflow.js` 的小片段块，以及尚未落地的
> Task 4/5/6 的 `src/server.js` / `web/app.js`）—— 它们不在本轮改动范围内，未动。

| 项 | 数 |
|---|---|
| 全量用例数 | **1021**（基线 1007 + 本轮 14），**0 红**（1020 通过 / 1 跳过） |
| `test/pools-sync.test.js` | **54** 条，0 红（原计划 40 例 + 本轮补测 14 例） |
| `test/points.test.js` | **27** 条，0 红（本轮改了 2 条用例的断言 + 加强了 1 条告警断言） |
| 变异体 | **135**（133 杀 / 1 真等价 / 0 缺口 / 1 退役 / 0 锚点问题） |

### T3R-6 本轮**判断为不需要改**的项（含理由）

| 项 | 判断 | 理由 |
|---|---|---|
| `INTERFACES.md` §6 的服务层签名与 API | **不改** | 本轮没有改任何服务层函数名、参数或返回结构的主键字段（`updatedOtherEditions` 是**追加**字段，契约要求的 6 个字段一个没动） |
| `INTERFACES.md` §6 的 `pool_resources` 列清单 | **不改** | 契约的列清单是「只多列」的基线；本轮选择**不增列**（M-3）⇒ 列清单与实现**仍然一致**，不需要记偏差 |
| `db/migrations/006_pools.sql` | **不改** | 迁移按版本号记账、**改内容不会重跑** ⇒ 改它会让已建的库漂移。本轮因此不走「增列」这条路 |
| `src/services/leaderboard.js`（P3 的文件） | **不改** | `computePersonalPoints` 现在会多返回一个 `warnings` 字段，但 P3 的榜单 payload 的 `warnings` 通道是它自己的事 —— 改它属于 P3 的范围（越界）。已在 `src/domain/points.js` 的注释里写明告警的来源 |
| `src/services/taskPackage.js`（P1 的文件） | **不改** | 它的 `ASSESSABLE` / `APPROVABLE` 是 `TASK_PACKAGE_STATUSES` 的**子集**（不冲突）。取值域清单放在仓储层（`src/db/repo/taskPackages.js`）是因为那是表结构的归属地；服务层若要统一引用，属于 P1 的范围 |
| `stage_results` 的 `ORDER BY sr.stage_id, sr.rank, sr.team_id` | **不改** | `(stage_id, rank, team_id)` 不是全序（同队同赛段同名次可能并列），但消费方 `derivePoolProjects` 取的是「最远赛段」的**最大赛段序**，与并列行的先后**无关** ⇒ 不产生不确定性。登记为观察项 |
| `listEditionStages` 的 `ORDER BY starts_at, id` | **不改** | `stages.id` 是**唯一**键 ⇒ 该 ORDER BY 已是全序，不存在并列 |

### T3R-7 本轮改动的文件清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `platform/src/domain/personal-points.js` | **新建**（P5） | 个人积分的唯一计算点 |
| `platform/src/domain/pool-derive.js` | Modify | 委派唯一计算点；同刻并列的 `rowid` 兜底；去掉 `packageCount`；导出 `RESOURCE_KINDS` |
| `platform/src/domain/points.js` | Modify（P2，**最小改**） | `computePersonalPoints` 改为委派取每人总额，保留 1224 名次与输出形状 |
| `platform/src/db/repo/pool-sources.js` | Modify（P5 Task 1 的文件） | 4 条 ORDER BY 补 `rowid` 兜底；2 个 SELECT 带出 `rowid` |
| `platform/src/db/repo/taskPackages.js` | Modify（P1，**追加**） | 新增 `TASK_PACKAGE_STATUSES` |
| `platform/src/services/pools.js` | Modify | 规则来源改 `rules.points`；自检挪进事务（M-1）；`updatedOtherEditions`（M-2） |
| `platform/src/config.js` | Modify | `rules.points.personal` 的 fail-fast；`rules.pools` 的交叉引用校验（M-3） |
| `platform/rules/points.json` | Modify（P3，**追加**） | `personal` 组追加 `atomicKinds` / `rollupKind` |
| `platform/rules/pools.json` | Modify | 移除 `talentPointKinds`（口径的规则来源唯一化） |
| `platform/test/pools-sync.test.js` | Modify | 本轮补测 14 例（判别性用例 + 回归） |
| `platform/test/points.test.js` | Modify（P2） | 口径统一后必然变化的 2 条断言 + 1 条加强断言 |
| `platform/test/leaderboard-migration.test.js` | Modify（P3） | `rules.points.personal` 的 deepEqual 跟随新键 |
| `docs/superpowers/plans/INTERFACES.md` | Modify | §4 的 `rules/points.json` 示例 + 一段说明（口径唯一化） |
| `docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md` | Modify | 计划代码块逐字回写 + 本章台账 |

---

## P5 Task 4 实施台账（2026-10-21）

> 执行者：P5 Task 4 实现 Agent。**规格 = 本计划 Task 4 章节**（唯一权威）。
> 本台账记六件事：① 实施方法（先跑后派）；② 实跑发现的规格缺陷与处置；③ 逐字回写位置；
> ④ 实跑证据；⑤ 变异检验；⑥ 计划块逐字核验；⑦ 遗留需上游注意。
> **落盘文件与本计划 Task 4 的代码块逐字一致**（核验脚本见 T4-F）。

### T4-A 实施方法（先跑后派：规格改动必须先在独立工程实跑通过）

| 步骤 | 动作 | 证据 |
|---|---|---|
| A-1 | 把 Task 4 的 **11 个围栏代码块**抽到独立工程 `/tmp/p5-t4/`（`extract.mjs` 按块号落盘，保留计划行号） | `/tmp/p5-t4/blocks/00..10-*.txt` |
| A-2 | 独立工程 = `cp -R` worktree 的 `platform/` ⇒ `/tmp/p5-t4/platform`（**不在仓库里试错**） | — |
| A-3 | **Step 2 期望失败实跑**：只落测试块 → `node --test test/public-api.test.js` | `ERR_MODULE_NOT_FOUND: .../src/services/public-api.js`（与计划 Expected 逐字一致） |
| A-4 | 落 4 个实现块 + 按计划改 `server.js`（3 处） | 见 T4-B 的实跑缺陷 |
| A-5 | 规格缺陷**先在独立工程里修好并跑通**，再把修正内容**逐字回写**计划对应代码块 | T4-C |
| A-6 | 独立工程全量绿后，才把文件落进 worktree | `/tmp/p5-t4/platform` → worktree |
| A-7 | 变异检验在 **`cp -R` 副本** `/tmp/p5-mutate/work` 上跑（变异会改文件 ⇒ 绝不能污染 worktree）；变异脚本**不进仓库** | `/tmp/p5-mutate/t4.mjs` |

> ⛔ **A-3 的顺序纪律**：先跑「Step 2 期望失败」，再落实现 —— 否则「测试通过」不能证明
> 「测试对被测行为有判别力」。

### T4-B 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T4-C1 | **Important** | 三个路由文件的**相对导入深度错了一层**：计划写 `from '../errors.js'`，但文件在 `src/http/routes/` ⇒ 解析到 `src/http/errors.js`（不存在）。同款错误还有 `'../auth/permissions.js'`、`'../services/*.js'` | 把计划块**逐字**落盘后跑 `node --test test/server.test.js` 当场红：`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/tmp/p5-t4/platform/src/http/errors.js' imported from .../src/http/routes/workflow.js` | 改为 `../../errors.js` / `../../auth/permissions.js` / `../../services/*.js`（与 P1/P2 既有路由文件 `src/http/routes/team.js:3-6` **逐字同款**）；**回写计划三个路由块** |
| T4-C2 | **Important** | 计划的测试块**只覆盖服务层**（10 例）⇒ 本 Task 新建的 **3 个路由文件 + `server.js` 的原文响应分支零覆盖**（与 Task 1 的 T1-1 C-1 同款病根：机制写下来了，测试却没接线） | 变异检验实测：路由与 `server.js` 的变异体若不补测将**全体存活**；实测「`__rawText` 分支删掉」在原 10 例下**测试全绿** | 补测：测试块 **10 → 55 例**（服务层 25 例 + HTTP 层 30 例）。补的判别性数据：段位记录 `tr_0`(更早,活) / `tr_1` / `tr_3`(更晚,**软删除**)、`points_ledger` 一行、三个能力点、组委会超管账号 |
| T4-C3 | Minor | Step 9 的提交命令**没有 `-- <paths…>` 显式路径**，且 `git add` 给了**目录**（`src/http/routes`）而不是文件 | 本项目提交纪律（见 T1-1 C-8） | 改为逐文件显式路径 + `--` |
| T4-C4 | Minor | Step 2 / Step 8 的测试命令缺 `--disable-warning=ExperimentalWarning`（`package.json` 四个 scripts 都带这个 flag，计划里是旧口径） | — | 两处补上 |
| T4-C5 | Minor | Step 8 的 Expected 写「10 个测试全过」，与补测后的实际数字不符 | 实跑 55 例 / 全量 1076 例 | 回写为 `55` / `1076`（见 T4-C 的逐字回写位置） |
| T4-C6 | Minor（知悉） | `server.js` 的「原文引用」块（4 行：`const result = …` + I7-4 三行）在插入 `__rawText` 段后**按设计不再连续出现在实现里** | 计划自己的措辞是「**找到**下面这段**原文**」⇒ 它是**定位锚点**；紧随其后的「插入后该段应是」（19 行）才是逐字契约 | **不改计划**：19 行块已逐字命中（见 T4-F）。父代理评审时不必把 4 行块的「不命中」当缺陷 |

> **编号说明**：本 Task 的台账条目一律用 `T4-C*` 前缀（Task 1 用裸 `C-*`、Task 2 用 `T2-C*`、
> Task 3 用 `T3-C*`、Task 3 修复轮用 `T3R-C*`）⇒ **不重号**。

### T4-C 逐字回写位置（计划文档 → 实际文件）

| 计划的代码块 | 实际文件 | 回写内容 |
|---|---|---|
| Task 4 Step 1 的测试块（计划行 4732 起） | `platform/test/public-api.test.js` | 整块替换为 55 例（10 例原文**逐字保留** + 45 例新增）；种子补 3 行（`tr_0` / `tr_3` / `points_ledger`）与 2 条夹具（能力点、组委会超管） |
| Task 4 Step 3 的服务块（计划行 5443 起） | `platform/src/services/public-api.js` | **逐字未改**（实跑无缺陷） |
| Task 4 Step 4 的路由块（计划行 5661 起） | `platform/src/http/routes/workflow.js` | 仅改 2 行导入深度（`../` → `../../`） |
| Task 4 Step 5 的路由块（计划行 5730 起） | `platform/src/http/routes/pools.js` | 仅改 3 行导入深度 |
| Task 4 Step 6 的路由块（计划行 5794 起） | `platform/src/http/routes/public.js` | 仅改 1 行导入深度 |
| Task 4 Step 7 的 3 个 `server.js` 片段 | `platform/src/server.js` | **逐字未改**（实测插入点全部命中；I7-4 块整段保留） |
| Task 4 Step 2 / Step 8 / Step 9 的文字 | 计划正文 | 补 `--disable-warning=ExperimentalWarning`；Expected 数字回写；提交命令补 `--` 与显式路径 |

### T4-D 实跑证据

| 环节 | 命令 | 结果 |
|---|---|---|
| Step 2 期望失败 | `cd platform && node --disable-warning=ExperimentalWarning --test test/public-api.test.js` | `ERR_MODULE_NOT_FOUND`（`/…/src/services/public-api.js`）✅ 与计划 Expected 逐字一致 |
| 本 Task 单文件 | `cd platform && node --disable-warning=ExperimentalWarning --test test/public-api.test.js` | **55 例 / 通过 55 / 失败 0 / 跳过 0** |
| **全量** | `cd platform && node --disable-warning=ExperimentalWarning --test` | **1076 例 / 通过 1075 / 失败 0 / 跳过 1**（跳过的 1 例是 P0–P4 既有的） |
| 禁用表述扫描 | `cd platform && node scripts/audit-scan.js; echo "退出码=$?"` | **退出码 0**（扫描 152 个文件，11 条词条，未发现禁用表述） |
| 计划块核验 | `node /tmp/p3fix/plan-blocks.mjs <计划> platform` | Task 4 的 5 个整文件块全部 `✅一致`；`src/server.js` 为 `片段块（实现含此片段）` |
| 片段核验 | `node /tmp/p4-proof/fragment-check.mjs <计划> platform <6 个文件>` | `核验 6 个片段块，不一致 0 个` |

> ⚠️ 唯一一处「整文件块❌不一致」是 `web/app.js`（计划行 6661，Task 6 的 1 行片段）——
> **本 Task 之前就已存在**（用改前备份 `plan-blocks.mjs` 复跑确认同样报不一致），**与本 Task 无关**。

### T4-E 变异检验（`/tmp/p5-mutate/t4.mjs`，**不进仓库**）

**69 个变异体 → 杀 60 / 真等价 3 / 不可观测 6 / 缺口 0**（锚点命中 0 次的 0 个；命中次数 ≠ 1 的 0 个）。

| 类别 | 编号 | 为什么能判成这一类（**必须有探针差分实证**） |
|---|---|---|
| **真等价**（3） | T4-M43 | `filterOk = false` → `true`：catch 分支里 `visibleRows` 恒为 `null` ⇒ `if (filterOk && visibleRows)` 两边都假 ⇒ 标志位**恒为冗余**，任何输入都不可分辨 |
| | T4-M44 | `if (Array.isArray(visible.teams)) return visible.teams;` → 删掉：P3 的 `applyVisibility` **恒**返回 `out.rows` ⇒ 该分支是**死代码**（保留作形状变化的防御） |
| | T4-M68 | `registerWorkflowRoutes(router, { db, rules })` → `{ db }`：`workflow.js` 的路由**根本不用** `rules` ⇒ 参数未被读取 |
| **不可观测**（6）<br>（当前配置/测试集下测不出，但**见证探针证明它会改变行为**） | T4-M29 | `?? 'C'` → `?? 'D'`：`validateRules` **强制** `visibility.rank.publicFromTier` 必填 ⇒ 兜底在正常配置下不可达；**见证**（放宽校验器 + 删掉该键）⇒ 隐藏队伍数 `2` vs `1` |
| | T4-M31 | 段位未知兜底 `-1` → `0`：**见证**（把门槛降到 `'D'`）⇒ 隐藏队伍数不同（`-1` 是 fail-closed 兜底，**不要**改成 `0`） |
| | T4-M39 | 删掉「身份集合求交」：**见证**（让 P3 的 `scope='rank'` 分支开始删行）⇒ 公开行数 `0` vs `1` |
| | T4-M40 | `extractRows` 的 `return visible.rows` → `return raw.rows`：**见证**（同上）⇒ 公开行数 `0` vs `1` |
| | T4-M60 | `syncPoolProjects({ db, editionId, rules })` → 不传 rules：**见证**（`packageStatusFilter` 改成非空）⇒ 项目标题 `一队` vs `零售风控助手` |
| | T4-M69 | `registerPoolsRoutes(router, { db, rules })` → `{ db }`：**见证**（同上）⇒ 同步结果不同 |
| **杀死**（60） | T4-M01…M67 中其余 60 个 | 覆盖：token 只存哈希 / 四种 403 / 缺规则 500 / 缺 editionId 400 / scope 白名单 / TTL 推算 / 段位下限与 fail-closed / 字段白名单投影 / warning / 赛段元信息 / 可见性过滤抛错兜底 / 三个路由文件的每条分支 / `__rawText` 原文响应 / 路由挂载 |

**探针差分方法**（`/tmp/p5-mutate/probe.mjs`）：对「全绿但存活」的变异体，跑一个**全表面快照**
（公开榜单 + 5 条公开/工作流/三池 HTTP 调用），归一化掉时间戳与 UUID 后与基线**逐字节**比较；
相同 ⇒ 等价/不可观测，不同 ⇒ 存活（要归类）。**见证脚本** `/tmp/p5-mutate/t4-witness.mjs`：
对判为「不可观测」的 6 个变异体，**再叠加一个场景改动**（放宽配置校验 / 改门槛 / 让 P3 删行 /
改 `packageStatusFilter`），证明 base ≠ mutant ⇒ 它们**不是逻辑等价**，只是当前空间测不出。
**见证成立 6 / 6**。

### T4-F 计划块逐字核验

| 文件 | 核验结果 |
|---|---|
| `platform/test/public-api.test.js` | 整文件块 ✅一致（701 行） |
| `platform/src/services/public-api.js` | 整文件块 ✅一致（213 行） |
| `platform/src/http/routes/workflow.js` | 整文件块 ✅一致（64 行） |
| `platform/src/http/routes/pools.js` | 整文件块 ✅一致（59 行） |
| `platform/src/http/routes/public.js` | 整文件块 ✅一致（14 行） |
| `platform/src/server.js` | 片段块（导入段 / 挂载段 / `__rawText` 插入段 / 插入后整段）**逐字命中**；I7-4 块整段保留、未被删改 |

### T4-G 遗留需上游注意

| # | 事项 | 说明 |
|---|---|---|
| G-1 | **「身份集合求交」在 P3 当前实现下是空操作** | P3 的 `scope='rank'` 分支**只剔字段、不删行** ⇒ `visible.rows` 与 `raw.rows` 的身份集合恒等 ⇒ 公开榜里的求交过滤不产生任何差异（T4-M39 见证）。它是**纵深防御**：P3 一旦改成会删行，求交立刻生效。**不要**因为「看起来没用」就删掉它 |
| G-2 | `projectPublicRows` 的 `?? 'C'` 兜底**在正常配置下不可达** | `validateRules` 强制 `visibility.rank.publicFromTier` 必填 ⇒ 兜底只在「绕过 `loadRules` 手搓 rules」时生效。它是那时的 fail-closed 保护，**不要**改成 `'D'` |
| G-3 | `extractRows` 的 `visible.teams` 分支是**死代码** | 保留作形状变化的防御；**不要**当它有效，也不要在没有 P3 形状变更证据时删它 |
| G-4 | **`registerXRoutes` 有两套参数风格并存** | P5 的三个路由用**位置参数** `registerXRoutes(router, { db, rules })`（与计划的 Step 7 一致）；P1 的五个路由用**对象参数** `registerXRoutes({ router, db, rules })`。本 Task **按计划逐字实现**，未擅自统一。若上游要统一口径，**建议在 P5 收尾时统一**（会动 P1–P4 的 5 个路由文件） |
| G-5 | 公开 token 走 **query 串**（契约如此） | 部署时须在 nginx 层关掉 query 串访问日志（P6 负责）；否则 token 会落进访问日志 |
| G-6 | `pool:write` 目前**只由 admin 角色**授予 | `POST /api/pools/sync` 的 `can()` 判定走 `scopeType:'edition'`；非 admin 用户即便被授予 `pool:write`，也需带 `scopeId=editionId` 才通过 |
| G-7 | Task 5 可直接用 `__rawText` | `server.js` 的原文响应分支已挂好并有测试（`原文响应（__rawText）走 text() 而不是 json()`）⇒ Task 5 只需在 `src/http/routes/public.js` 追加 `GET /api/public/calendar.ics` 路由并返回 `{ __rawText: true, body, contentType }` |
| G-8 | `public_tokens.token` 无 `NOT NULL` | Task 1 台账 T1-1 C-6 已登记（沿用 P0–P4 约定），本 Task 未单点偏离 |
| G-9 | 公开榜的**段位门槛**目前是**双写**的 | `rules.visibility.rank.publicFromTier` 同时被 P3 的 `scope='tier'` 分支与 P5 的 `projectPublicRows` 读取；两者读的是**同一个**配置键 ⇒ 当前不会漂移。若将来 P3 改用自己的段位表，两层口径会分叉（P3 段位表是 `DEFAULT_TIER_ORDER = ['D','C','B','A','S']`，P5 用 `rules.ranks.tiers` 的顺序）⇒ **建议上游确认这两张表恒等** |

### T4-H 本 Task 改动的文件清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `platform/src/services/public-api.js` | **新建**（P5） | `createPublicToken` / `resolvePublicToken` / `getPublicLeaderboard` / `PUBLIC_NOTICE` / `hashPublicToken` |
| `platform/src/http/routes/workflow.js` | **新建**（P5） | 任务清单 API 6 条（建工作流 / 建任务 / 列任务 / 领取 / 释放 / 完成） |
| `platform/src/http/routes/pools.js` | **新建**（P5） | 三池只读 API 3 条 + 同步 1 条 |
| `platform/src/http/routes/public.js` | **新建**（P5） | 公开榜单 1 条（无需登录，token 鉴权） |
| `platform/src/server.js` | Modify（P0 建立，**本 Task 只追加**） | 导入段 + 3 条路由挂载 + `__rawText` 原文响应分支；I7-4 块**整段保留** |
| `platform/test/public-api.test.js` | **新建**（P5） | 55 例（服务层 25 + HTTP 层 30） |
| `docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md` | Modify | Task 4 代码块逐字回写 + 本章台账 |

---

## P5 Task 5 实施台账（2026-10-21）

> 执行者：P5 Task 5 实现 Agent。**规格 = 本计划 Task 5 章节**（唯一权威）。
> 本台账记七件事：① 实施方法（先跑后派）；② 规格缺陷与处置；③ 逐字回写位置；
> ④ 实跑证据；⑤ 变异检验；⑥ 计划块逐字核验；⑦ 遗留需上游注意；⑧ 改动文件清单。
> **落盘文件与本计划 Task 5 的代码块逐字一致**（核验脚本见 T5-F）。
>
> **溯源 ID 订正**：派单时给的「R-PTS-08」有误 —— R-PTS-08 是「行为分 ≤10% 且只做垫底排序」，
> 与日历无关。iCal 导出赛程日历的正确落点是 **R-STG-01（5 赛段时间轴与交付物）**
> （`docs/requirements-traceability.md:41` 全表里没有独立的「日历订阅」条目）。
> 已按上游订正写成 `// R-STG-01：赛段时间轴（iCal 导出）—— 依据 INTERFACES.md §6 / 设计文档 §8`。

### T5-A 实施方法（先跑后派：规格改动必须先在独立工程实跑通过）

| 步骤 | 动作 | 证据 |
|---|---|---|
| A-1 | 把 Task 5 的 **7 个围栏代码块**抽到独立工程 `/tmp/p5-t5/`（`extract.mjs` 按块号落盘，保留计划行号） | `/tmp/p5-t5/blocks/00..06-*.txt` |
| A-2 | 独立工程 = `cp -R` worktree 的 `platform/` ⇒ `/tmp/p5-t5/platform`（**不在仓库里试错**） | — |
| A-3 | **Step 2 期望失败实跑**：只落测试块 → `node --disable-warning=ExperimentalWarning --test test/icalendar.test.js` | `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/tmp/p5-t5/platform/src/domain/icalendar.js' imported from .../test/icalendar.test.js`（与计划 Expected 逐字一致） |
| A-4 | 落 4 个实现块（领域层 / 服务层追加 / 路由追加 / 路由导入） | 见 T5-B 的实跑缺陷 |
| A-5 | 规格缺陷**先在独立工程里修好并跑通**，再把修正内容**逐字回写**计划对应代码块 | T5-C |
| A-6 | 独立工程全量绿（1101 例 / 失败 0）后，才把文件落进 worktree | `/tmp/p5-t5/platform` → worktree |
| A-7 | 变异检验在 **`cp -R` 副本** `/tmp/p5-mutate/t5work` 上跑（变异会改文件 ⇒ 绝不能污染 worktree）；变异脚本**不进仓库** | `/tmp/p5-mutate/t5.mjs` |

> ⛔ **A-3 的顺序纪律**：先跑「Step 2 期望失败」，再落实现 —— 否则「测试通过」不能证明
> 「测试对被测行为有判别力」。

### T5-B 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T5-C1 | **Important** | Step 5 的路由导入行**相对深度错了一层**：计划写 `from '../services/public-api.js'`，但文件在 `src/http/routes/` ⇒ 解析到 `src/http/services/public-api.js`（不存在）。**与 Task 4 的 T4-C1 同款**（计划作者按 `src/services/` 的深度写，而文件在 `src/http/routes/`） | 把计划块**逐字**落盘后跑全量，当场红 **13 个测试文件**：`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/tmp/p5-t5/platform/src/http/services/public-api.js' imported from .../src/http/routes/public.js` | 改为 `../../services/public-api.js`（与 P1/P2 既有路由文件 `src/http/routes/team.js:3-6` **逐字同款**）；**回写计划 Step 5 的导入块** |
| T5-C2 | **Important** | 计划的测试块**只覆盖领域层与服务层**（8 例）⇒ 本 Task 新建的 **`GET /api/public/calendar.ics` 路由零覆盖**（与 Task 4 的 T4-C2 同款病根：机制写下来了，测试却没接线）。零覆盖 ⇒ 路由的 token 鉴权、`__rawText` 原文响应、`Content-Type`、CRLF 是否被 JSON 转义 —— 全部没有回归保护 | 变异检验实测：路由相关变异体（`T5-M45`…`T5-M50`）在原 8 例下**全体存活** | 补测：测试块 **8 → 29 例**（领域层 13 + 服务层 3 + HTTP 层 13）。补的判别性数据：赛段名含 `,` `;` `\`、超长中文赛段名（触发服务层折叠）、跨届期 token / 过期 token / scope 不符、无赛段届期（200 + 空集）、企业名不外泄 |
| T5-C3 | Minor | Step 2 / Step 6 的测试命令缺 `--disable-warning=ExperimentalWarning`（`package.json` 四个 scripts 都带这个 flag，计划里是旧口径） | — | 两处补上 |
| T5-C4 | Minor | Step 7 的提交命令**没有 `-- <paths…>` 显式路径**，且 `git add` 给的是 `src/…` 相对路径（在 `platform/` 目录下执行时才对，但与本项目「从仓库根 + 显式路径」的纪律不符） | 本项目提交纪律（见 T1-1 C-8 / T4-C3） | 改为从仓库根执行的逐文件显式路径 + `--` |
| T5-C5 | Minor | Step 6 的 Expected 写「8 个测试全过」，与补测后的实际数字不符 | 实跑 29 例 / 全量 1105 例 | 回写为 `29` / `1105`（见 T5-C 的逐字回写位置） |
| T5-C6 | Minor | **溯源 ID 缺失且派单给的 ID 有误**：计划正文未给 iCal 的溯源 ID；派单提示的 `R-PTS-08` 实为「行为分 ≤10% 且只做垫底排序」（`requirements-traceability.md:103`），与日历无关 | 核对 `docs/requirements-traceability.md` 全表 | 落 `// R-STG-01：赛段时间轴（iCal 导出）—— 依据 INTERFACES.md §6 / 设计文档 §8`（`R-STG-01` = 5 赛段时间轴与交付物，`:41`）；**回写计划的三处代码块** |
| T5-C7 | Minor（知悉） | `buildICalendar` 的 `end: s.ends_at ?? addOneDay(s.starts_at)` 里的 `addOneDay` **在当前 schema 下不可达** —— `stages.ends_at` 是 `TEXT NOT NULL`（`db/migrations/003_review.sql:29`）⇒ `??` 的左操作数恒非空 | 变异检验 `T5-M44`（把 +1 天改成 +2 天）在全表面探针下**无差别**；见证探针（把仓储的 `ends_at` 改成 `NULL AS ends_at`）⇒ base ≠ mutant | **不改代码**：保留作防御（上游若放开 `ends_at` 可空，它立刻生效）；登记为 T5-G-5（不可观测 + 见证成立） |
| T5-C8 | Minor（知悉） | `URL` 用的是**相对路径**（`/leaderboard?stageId=…`），而 RFC 5545 的 `URL` 属性要求**绝对 URI** | 计划原块如此；`buildICalendar` 的签名里**没有** base URL 参数 | **不改代码**（加 baseUrl 参数会改 `INTERFACES.md` §6 的签名，超出本 Task 范围）；登记为 T5-G-6（若上游要绝对 URL，须先扩签名） |
| T5-C9 | **Important** | **领域层用了 Node 专属全局 `Buffer`**（`src/domain/icalendar.js` 的 `Buffer.from(text,'utf8')` 与 `bytes.subarray(...).toString('utf8')`）—— 违反「领域层要在**浏览器**里跑同一套引擎」的硬约束 | ① P6 的演示版把 `src/domain/*.js` **原样拷进浏览器产物**（`<out>/src/domain/*.js`）⇒ 浏览器里 `Buffer is not defined` ⇒ 整个模块 **ReferenceError**；② 全仓扫描：`Buffer` 在 `src/domain/**` 里**只此一处**（`src/auth/`、`src/http/` 的 `Buffer` 不在领域层，不受此约束）；③ ⛔ `build-demo.js` 的 `assertDomainIsBrowserSafe` **只查 import 说明符、不查 Node 全局** ⇒ 这类违规它**查不出来** | 改用 **WHATWG Web 标准** `TextEncoder` / `TextDecoder`（Node ≥ 11 起也是全局 ⇒ 两端通用，且**不需要 import 任何 Node 内置模块**）：`ENCODER.encode(text)` 取代 `Buffer.from(text,'utf8')`；`DECODER.decode(bytes.subarray(start,end))` 取代 `bytes.subarray(start,end).toString('utf8')`；encoder/decoder 提到**模块级常量**。⚠️ **多字节回退那段逻辑一个字未动**（diff 实证：只有上述两行字节 API 变化）。补 2 条测试（静态扫描 + 折叠行为）；**回写计划的两处代码块**；变异检验新增 6 个变异体（见 T5-E） |

> **编号说明**：本 Task 的台账条目一律用 `T5-C*` 前缀（Task 1 用裸 `C-*`、Task 2 用 `T2-C*`、
> Task 3 用 `T3-C*`、Task 3 修复轮用 `T3R-C*`、Task 4 用 `T4-C*`）⇒ **不重号**。

### T5-C 逐字回写位置（计划文档 → 实际文件）

| 计划的代码块 | 实际文件 | 回写内容 |
|---|---|---|
| Task 5 Step 1 的测试块（计划行 6010 起） | `platform/test/icalendar.test.js` | 整块替换为 31 例（计划原 8 例**逐字保留** + 23 例新增：21 例首轮 + 2 例 T5-C9 修复轮）；`setup()` 增 `loadRules` + `createApp`（HTTP 层用例需要） |
| Task 5 Step 3 的领域块（计划行 6455 起） | `platform/src/domain/icalendar.js` | 加 1 行 `// 溯源：R-STG-01…`；**T5-C9 修复轮**：把 `Buffer.from` / `.toString('utf8')` 换成 `TextEncoder` / `TextDecoder`（模块级常量）+ 浏览器安全的注释；**多字节回退逻辑逐字未动** |
| Task 5 Step 4 的服务追加块（计划行 6510 起） | `platform/src/services/public-api.js` | 仅在 `buildICalendar` 的文档注释里加 1 行 `// 溯源：R-STG-01…` |
| Task 5 Step 5 的路由导入块（计划行 6552 起） | `platform/src/http/routes/public.js` | **导入深度 `../services/` → `../../services/`**（T5-C1）；**回写计划** |
| Task 5 Step 5 的路由追加块（计划行 6558 起） | `platform/src/http/routes/public.js` | 仅加 1 行 `// 溯源：R-STG-01…` |
| **Task 4 Step 3** 的 `src/services/public-api.js` 整文件块（计划行 5443 起） | `platform/src/services/public-api.js` | 同步为 Task 5 之后的终态（250 行）：原 213 行**逐字保留** + Task 5 的 1 行导入 + 追加段 |
| **Task 4 Step 6** 的 `src/http/routes/public.js` 整文件块（计划行 5831 起） | `platform/src/http/routes/public.js` | 同步为 Task 5 之后的终态（23 行）：原 14 行**逐字保留**（仅导入行按 T5-C1 改）+ Task 5 的路由段 |
| Task 5 Step 2 / Step 6 / Step 7 的文字 | 计划正文 | 补 `--disable-warning=ExperimentalWarning`；Expected 数字回写；提交命令补 `--` 与显式路径 |

> ⚠️ **为什么 Task 4 的整文件块也要动**：`plan-blocks.mjs` 对「整文件块」要求**逐字等于实现文件全文**。
> Task 5 是**追加**（文件归属：最早建立者 owns，后续阶段 Modify-追加）⇒ Task 4 的整文件块
> 若不同步，`plan-blocks.mjs` 就会报 `src/services/public-api.js` / `src/http/routes/public.js`
> 两处 `整文件块❌不一致`。**Task 5 自己的块仍是片段块**（导入行 / 追加段），与 Task 4 对
> `src/server.js` 的处理方式同款（Task 4 台账 T4-C6 已记这条纪律）。

### T5-D 实跑证据

| 环节 | 命令 | 结果 |
|---|---|---|
| Step 2 期望失败 | `cd platform && node --disable-warning=ExperimentalWarning --test test/icalendar.test.js` | `ERR_MODULE_NOT_FOUND: …/src/domain/icalendar.js` ✅ 与计划 Expected 逐字一致 |
| 本 Task 单文件 | `cd platform && node --disable-warning=ExperimentalWarning --test test/icalendar.test.js` | **31 例 / 通过 31 / 失败 0 / 跳过 0**（29 例 + T5-C9 修复轮新增 2 例） |
| **全量** | `cd platform && node --disable-warning=ExperimentalWarning --test` | **1107 例 / 通过 1106 / 失败 0 / 跳过 1**（跳过的 1 例是 P0–P4 既有的） |
| 禁用表述扫描 | `cd platform && node scripts/audit-scan.js; echo "退出码=$?"` | **退出码 0**（未发现禁用表述） |
| 计划块核验 | `node /tmp/p3fix/plan-blocks.mjs <计划> platform` | Task 5 的 2 个整文件块 + Task 4 的 2 个被同步的整文件块全部 `✅一致` |
| 片段核验 | `node /tmp/p4-proof/fragment-check.mjs <计划> platform <4 个文件>` | `核验 4 个片段块，不一致 0 个`（退出码 0） |
| 按路径核验 | `node /tmp/p3fix/block-by-path.mjs <计划> platform <4 个文件>` | `共核验 4 个文件，不一致 0 个`（退出码 0） |

> ⚠️ 唯一一处「整文件块❌不一致」是 `web/app.js`（计划行 6971，Task 6 的 1 行片段）——
> **本 Task 之前就已存在**（Task 4 台账 T4-D 已记同样一条），**与本 Task 无关**，由 Task 6 处置。
>
> ⚠️ **一次未能复现的偶发失败（诚实记录）**：全量跑的第 1 次出现过 **1 例失败**（当时**未捕获失败用例名**），
> 随后的 **19 次连续全量跑全部为 1104/0**（本 Task 侧 3 + 6 + 10 次；Task 5 之前的基线 `HEAD` 侧另跑 8 次也全绿）。
> 候选嫌疑是 `test/db-concurrency.test.js`（**唯一**按墙钟时间断言的用例：`waited >= 300` / `elapsed < 2500`，
> 且会起 worker 线程）—— 新增一个测试文件会抬高 `node --test` 的并行负载 ⇒ 放大了这个**既有**用例的抖动窗口。
> **本 Task 未改动 `db-concurrency` 或任何并发/超时相关代码**（只新增 1 个测试文件 + 追加 2 处实现）。
> 若上游要消除该抖动，须单独收紧 `db-concurrency.test.js` 的时间断言（**不在本轮范围**）。

### T5-E 变异检验（`/tmp/p5-mutate/t5.mjs`，**不进仓库**）

**56 个变异体 → 杀 52 / 真等价 2 / 不可观测 2 / 缺口 0**（锚点命中异常 0 个：每个锚点都恰好命中 1 次）。
（其中 T5-M51…M56 是 **T5-C9 修复轮**新增的 `TextEncoder`/`TextDecoder` 变异体。）

| 类别 | 编号 | 为什么能判成这一类（**必须有探针差分实证**） |
|---|---|---|
| **真等价**（2） | T5-M34 | `if (bytes.length <= ICAL_LINE_MAX_OCTETS) return text;` → `<`：**恰好 75 octet 的行**在两条路径下产出**同一串字节** —— 折叠分支里 `end = min(0+75, 75) = 75`，而回退多字节边界的条件要求 `end < bytes.length`（75 < 75 为假）⇒ 首块就是整行，`start = 75` 后循环结束 ⇒ 恒等。**探针差分实证**：探针覆盖了「恰好 75 octet 且末字符是多字节」（`'x'×72 + '赛'`）等 5 组边界输入 + 全表面快照，base 与 mutant **逐字节相同** |
| | T5-M56 | `bytes.subarray(start, end)` → `bytes.slice(start, end)`：`subarray` 返回**视图**、`slice` 返回**拷贝** —— 但本模块只把结果**读一次**（`DECODER.decode(...)`）⇒ 两者产出同一串字符串。**探针差分实证**：全表面快照 base 与 mutant **逐字节相同** |
| **不可观测**（2）<br>（当前 schema/测试集下测不出，但**见证探针证明它会改变行为**） | T5-M08 | `pad(d.getUTCFullYear(), 4)` → `pad(…, 2)`：**见证**（把年份推到 999）⇒ `09990101T000000Z` vs `990101T000000Z` ⇒ base ≠ mutant。正常业务日期（年份 ≥ 1000）下 `padStart` 不截断 ⇒ 恒等 ⇒ 当前测不出 |
| | T5-M44 | `addOneDay` 的 `+ 86400000` → `+ 172800000`：**见证**（把仓储的 `ends_at` 改成 `NULL AS ends_at`，即「赛段没有结束日期」这个场景）⇒ DTEND 不同 ⇒ base ≠ mutant。当前 `stages.ends_at` 是 `NOT NULL` ⇒ 该分支**不可达** ⇒ 当前测不出（T5-C7） |
| **杀死**（52） | T5-M01…M56 中其余 52 个 | 覆盖：折叠上限（±1 octet）/ 折叠宽度用满 75 / 续行前导空格 / 续行宽度扣减 / 多字节边界回退 / 转义四类（`\` `,` `;` 换行）与其**顺序** / 年月日时分秒各位 / UTC 与本地时区 / `Z` 后缀 / CRLF 行尾与结尾 CRLF / `now` 必填与「不读时钟」/ 域层纯度（不 import `node:`、不用 `Date.now()`）/ 五个日历头字段 / `UID`·`DTSTAMP`·`DTEND`·`DESCRIPTION`·`LOCATION`·`URL` / `SUMMARY` 转义 / 服务层 `editionId` 必填 / `UID`·`SUMMARY`·`DESCRIPTION`·`DTEND`·`LOCATION`·`X-WR-CALNAME`·`URL` / 路由 `scope`·`届期`·`Content-Type`·`参数透传`·`鉴权`·`路径` / **T5-C9 新增**：`TextEncoder` 编码内容被改·`TextDecoder` 丢掉 `end`·解码器用错编码·**退回 `Buffer`**（浏览器里 ReferenceError）·编码多一个尾随空格 |

**探针差分方法**（`/tmp/p5-mutate/t5.mjs` 内置 `PROBE`）：对「全绿但存活」的变异体，跑一个**全表面快照**——
领域层（转义 / 折叠 / 时间戳，各 20+ 组输入，含「恰好 75 octet」「末字符是多字节」等边界）
**+ 服务层**（`buildICalendar` 对 3 个赛段：普通中文 / 含 `,;\` / 超长中文名，产出整份 ics）。
归一化后与基线**逐字节**比较：相同 ⇒ 等价/不可观测，不同 ⇒ 存活（要归类）。
⚠️ **第一版探针只覆盖领域层** ⇒ 服务层变异体 `T5-M42`（`DESCRIPTION` 不带赛段代号）被**误判**成「真等价」。
已把探针扩到服务层，并据此补了一条断言（`DESCRIPTION 必须带赛段代号`）⇒ `T5-M42` 改为**被杀**。
**见证脚本**：对判为「不可观测」的 2 个变异体，**再叠加一个场景改动**（年份推到 999 / 仓储返回空 `ends_at`），
证明 base ≠ mutant ⇒ 它们**不是逻辑等价**，只是当前空间测不出。**见证成立 2 / 2**。

### T5-F 计划块逐字核验

| 文件 | 核验结果 |
|---|---|
| `platform/test/icalendar.test.js` | 整文件块 ✅一致（435 行） |
| `platform/src/domain/icalendar.js` | 整文件块 ✅一致（98 行） |
| `platform/src/services/public-api.js` | 整文件块 ✅一致（250 行；Task 4 的块已同步为终态） |
| `platform/src/http/routes/public.js` | 整文件块 ✅一致（23 行；Task 4 的块已同步为终态） |

### T5-G 遗留需上游注意

| # | 事项 | 说明 |
|---|---|---|
| G-1 | **`addOneDay` 在当前 schema 下不可达** | `stages.ends_at` 是 `TEXT NOT NULL`（`db/migrations/003_review.sql:29`）⇒ `s.ends_at ?? addOneDay(s.starts_at)` 的右操作数恒不生效。保留作防御（上游若放开 `ends_at` 可空，它立刻生效）。**不要**因为「看起来没用」就删掉它（T5-C7 / 变异体 `T5-M44` 见证成立） |
| G-2 | **iCal 的 `URL` 是相对路径** | RFC 5545 的 `URL` 属性要求**绝对 URI**，本实现给的是 `/leaderboard?stageId=…`（没有 base URL 可拼）。主流客户端会忽略这条属性，**不影响订阅**；若上游要绝对 URL，须先给 `buildICalendar` 扩 `baseUrl` 参数（会动 `INTERFACES.md` §6 的签名 ⇒ 须上游裁决） |
| G-3 | **`.ics` 路由的 `editionId` 必填** | 契约没有「当届期」的默认解析口径（本 Task 未擅自引入）⇒ 不传 `editionId` 返回 400 `EDITION_REQUIRED`。若上游希望「不传即当届」，须在 `src/http/routes/public.js` 里接 `pickCurrentEdition`（P0/P1 已有该函数）—— **本轮不改**（会引入新的口径） |
| G-4 | **公开 token 走 query 串**（沿用 Task 4 的 G-5） | `GET /api/public/calendar.ics?editionId=…&token=…` ⇒ token 会进 nginx 访问日志。P6 部署时须在 nginx 层关掉 query 串访问日志 |
| G-5 | `resolvePublicToken` 的 `requiredScope: 'calendar'` | `rules/pools.json` 的 `publicScopes` 含 `calendar` ⇒ 可签发日历专用令牌；`scope='all'` 的令牌同样可用（`resolvePublicToken` 放行 `all`） |
| G-6 | **`X-WR-CALNAME` 取届期名** | 届期名含中文与 `·` 等字符时按 RFC 5545 的 TEXT 规则转义（`escapeICalText`）；`·` 不在需转义之列 ⇒ 原样输出 |
| G-7 | **iCal 不泄露企业名与内部身份** | 公开日历只含赛段时间轴（赛段名/代号/赛点/榜单跳转），**不含**企业名、任务包标题、用户 id —— 有专门用例守着 |
| G-8 | **`build-demo.js` 的 `assertDomainIsBrowserSafe` 只查 import 说明符，不查 Node 专属全局** | ⛔ 本仓的领域层硬约束是「**不得 import 任何 Node 内置模块**（P6 的演示版要在浏览器里跑同一套引擎）」，但该检查器只看 `import … from 'node:…'` ⇒ **`Buffer` / `process.` / `require(` / `__dirname` 这类 Node 专属全局它查不出来**（T5-C9 就是这样溜进去的）。`build-demo.js` 属 P6 Task 6 的文件（**本轮未改**）⇒ **建议上游把检查范围扩到 Node 全局**，并把本轮补的静态扫描（`test/icalendar.test.js` 的「★ 领域层不含 Node 专属全局」）推广到整个 `src/domain/**`（现已覆盖该目录全部 22 个文件） |

### T5-H 本 Task 改动的文件清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `platform/src/domain/icalendar.js` | **新建**（P5） | RFC 5545 纯函数：`escapeICalText` / `formatICalTimestamp` / `foldICalLine` / `buildICalendarText` / `ICAL_LINE_MAX_OCTETS`；⛔ 无 IO、无 `Date.now()`、无 `Math.random()`、`now` 必填；⛔ **无 Node 专属全局**（用 `TextEncoder`/`TextDecoder`，浏览器可跑，T5-C9） |
| `platform/src/services/public-api.js` | Modify（Task 4 建立，**本 Task 只追加**） | 追加 `buildICalendar` + 1 行导入 + `addOneDay` 私有辅助；原 213 行逐字未改 |
| `platform/src/http/routes/public.js` | Modify（Task 4 建立，**本 Task 只追加**） | 追加 `GET /api/public/calendar.ics`（token 鉴权 + `__rawText` 原文响应）；导入行按 T5-C1 修正深度 |
| `platform/test/icalendar.test.js` | **新建**（P5） | 31 例（领域层 15 + 服务层 3 + HTTP 层 13） |
| `docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md` | Modify | Task 5 代码块逐字回写 + Task 4 两处整文件块同步为终态 + 本章台账 |

---

## P5 Task 6 实施台账（2026-10-21）

> 执行者：P5 Task 6 实现 Agent。**规格 = 本计划 Task 6 章节**（唯一权威）。
> 本台账记七件事：① 实施方法（先跑后派）；② 规格缺陷与处置；③ 逐字回写位置；
> ④ 实跑证据；⑤ 变异检验；⑥ 计划块逐字核验；⑦ 遗留需上游注意；⑧ 改动文件清单。
> **落盘文件与本计划 Task 6 的代码块逐字一致**（核验脚本见 T6-F）。
>
> **溯源**：`R-OPS-13`（任务清单工作流拆解：任务包 → 工作流 → 任务清单 → 队员自主领取任务完成）
> ＋ `R-OPS-14`（禁止岗位制：严禁按岗位和身份分工，任务只能自主领取）。

### T6-A 实施方法（先跑后派：规格改动必须先在独立工程实跑通过）

| 步骤 | 动作 | 证据 |
|---|---|---|
| A-1 | 把 Task 6 的 **6 个围栏代码块**抽到独立工程 `/tmp/p5-t6/`（`extract.mjs` 按块号落盘，保留计划行号） | `/tmp/p5-t6/blocks/00..05-*.txt` |
| A-2 | 独立工程 = `cp -R` worktree 的 `platform/` ⇒ `/tmp/p5-t6/platform`（**不在仓库里试错**） | — |
| A-3 | **Step 2 期望失败实跑**：只落测试块 → `node --disable-warning=ExperimentalWarning --test test/workflow-e2e.test.js` | ⚠️ **没有失败 —— 当场通过（1/1 绿）**：Task 4 已把 workflow 路由挂进 `src/server.js` ⇒ 计划写的 Expected（「`POST /api/workflows` 返回 404」）**不成立**（见 T6-C1） |
| A-4 | 落 4 个实现块（视图 / app.js 导入 / app.js 路由注册 / app.js 透传） | 见 T6-B 的实跑缺陷 |
| A-5 | 规格缺陷**先在独立工程里修好并跑通**，再把修正内容**逐字回写**计划对应代码块 | T6-C |
| A-6 | 独立工程全量绿（1118 例 / 失败 0）后，才把文件落进 worktree | `/tmp/p5-t6/platform` → worktree |
| A-7 | 变异检验在 **`cp -R` 副本** `/tmp/p5-mutate/t6work` 上跑；变异脚本**不进仓库** | `/tmp/p5-mutate/t6.mjs` |

### T6-B 规格缺陷清单

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| T6-C1 | **Important** | **Step 2 的「期望失败」不成立**：计划写「`POST /api/workflows` 返回 404（`src/http/routes/workflow.js` 未在 `src/server.js` 挂载，或视图文件不存在）」—— 但 Task 4 已经把 `registerWorkflowRoutes` 挂进 `src/server.js`（`src/server.js:187`）⇒ 只落测试块就**当场通过** | 实跑：`# tests 1 / # pass 1 / # fail 0`（计划 Expected 与实跑**相反**） | 回写 Step 2 的 Expected；**更重要的是这个「假失败」暴露了真问题** ⇒ 见 T6-C2 |
| T6-C2 | **Important** | 计划的测试块**只覆盖后端闭环**（1 例）⇒ **前端交付物零覆盖**：`web/views/tasks.js` 的三段渲染、「无任何指派/岗位控件」、`web/app.js` 注册路由并把 `params` 透传给视图 —— 全都没有测试。与 Task 4 的 T4-C2 / Task 5 的 T5-C2 **同款病根**（机制写下来了，测试却没接线） | P5-10 的判据有两半（「`web/views/tasks.js` 渲染三段」+「端到端闭环」），计划只覆盖了后端那一半 | 补测：测试块 **1 → 12 例**（后端闭环 1 + 视图纯函数 8 + 前端接线 3） |
| T6-C3 | **Important** | 计划的 `web/views/tasks.js` **只导出 `renderTasks(ctx)`**（依赖 `document`）⇒ 无法测试。本仓前端惯例是「视图导出**纯函数**，DOM 只做接线」—— P1 的 `web/views/team.js` 就导出 `summarizeTeam` / `canLeaveTeam` / `buildTeamCards`（其注释明写「抽成纯函数后，这条**渲染路径**能被直接断言」） | P1 的 `test/p1-frontend.test.js` 直接 import 视图的纯函数断言；计划的视图没有任何可 import 的纯函数 | 抽出 5 个纯函数：`taskMode` / `classifyTasks` / `taskActions` / `buildTaskItem` / `buildTaskSections`；`renderTasks` 只做 DOM 接线（与 `buildTeamCards` 同款做法） |
| T6-C4 | Minor | 计划的视图里**自建**了一个局部 `escapeHtml` ⇒ 与 `web/escape.js` 重复。该文件头明确写「把转义收成一个工具，所有插值统一走它」 | `web/escape.js:10` | 改为 `import { escapeHtml } from '../escape.js';`（删掉局部副本） |
| T6-C5 | Minor | Step 4 的第三处改动（「把 `const el = await found.view(ctx);` 改成 `{ ...ctx, params: found.params }`」）**已经是 P0 终态** —— 实际是 `{ ...ctx, params: found.params, query: currentQuery() }` ⇒ 计划块与实现**不一致**（这就是 `plan-blocks.mjs` 长期报 `web/app.js` `整文件块❌不一致` 的那一处；Task 4 台账 T4-D 已记「本 Task 之前就已存在」） | `plan-blocks.mjs` 报 `行 7027 | web/app.js | 整文件块❌不一致`；Task 4 台账 T4-D 明确记了它与 Task 4 无关 | 回写该块为**实现里的真实那一行**（含 `query`），并把 Step 4 的文字从「改成」改为「**已经是终态，本步不用改；下面是核验用**」⇒ **全计划 60 个块现在零不一致** |
| T6-C6 | Minor | 计划的路由注册写成 `route('/tasks/:workflowId', (ctx) => renderTasks(ctx));` —— 形参 `ctx` **遮蔽**模块级的 `const ctx`（能跑，但与既有 `route('/flags', (c) => renderFlags(c));` 的写法不一致）；且**追加位置**有坑：追加到文件**末尾**（`render()` 之后）⇒ 首屏渲染时路由还没注册 ⇒ 先渲染一次「页面不存在」 | 既有 `web/app.js` 的 9 条路由一律用 `(c) => renderX(c)` | 改为 `route('/tasks/:workflowId', (c) => renderTasks(c));`，并追加在**既有路由注册之后、末尾 `render()` 之前** |
| T6-C7 | Minor | 计划的测试块**逐字抄了一份** `call`（进程内 HTTP 调用器）⇒ 与 `test-helpers/http-call.js` 重复。该文件头明写「此前在三个 API 测试文件里各抄了一份（**逐字相同**）—— 改一处要改三处，必然漂移」 | `test-helpers/http-call.js:9-16` | 删掉本地副本，改用共享 helper `import { call } from '../test-helpers/http-call.js';` |
| T6-C8 | Minor | Step 5 的 Expected 写「1 个端到端用例通过」；且 **Task 6 Step 5 的全量数字被本轮早先的 Task 5 回写误改成 1101**（那是 Task 5 独立工程当时的数字，不是全量） | `grep` 计划文档：`Expected: 全部通过（P0–P5 累计：**1101** 例 …）` 出现在 Task 6 Step 5 | 两处一起订正为 `12` 例 / 全量 `1119` 例 |
| T6-C9 | Minor | Step 7 的提交命令**没有 `-- <paths…>` 显式路径**，且 `git add` 给的是 `platform/` 下的相对路径 | 本项目提交纪律（见 T1-1 C-8 / T4-C3 / T5-C4） | 改为从仓库根执行的逐文件显式路径 + `--` |

> **编号说明**：本 Task 的台账条目一律用 `T6-C*` 前缀（Task 1 用裸 `C-*`、Task 2 用 `T2-C*`、
> Task 3 用 `T3-C*`、Task 3 修复轮用 `T3R-C*`、Task 4 用 `T4-C*`、Task 5 用 `T5-C*`）⇒ **不重号**。

### T6-C 逐字回写位置（计划文档 → 实际文件）

| 计划的代码块 | 实际文件 | 回写内容 |
|---|---|---|
| Task 6 Step 1 的测试块（计划行 6675 起） | `platform/test/workflow-e2e.test.js` | 整块替换为 12 例（计划原 1 例的**断言逐字保留** + 11 例新增）；删掉本地 `call` 副本（T6-C7） |
| Task 6 Step 3 的视图块（计划行 7046 起） | `platform/web/views/tasks.js` | 整块替换：**抽出 5 个纯函数**（T6-C3）+ 改用共享 `escapeHtml`（T6-C4）+ 补 `R-OPS-13`/`R-OPS-14` 溯源注释 |
| Task 6 Step 4 的导入块（计划行 7261 起） | `platform/web/app.js` | **逐字未改**（`import { renderTasks } from './views/tasks.js';`） |
| Task 6 Step 4 的路由块（计划行 7270 起） | `platform/web/app.js` | 形参 `(ctx)` → `(c)`（T6-C6） |
| Task 6 Step 4 的 `found.view` 块（计划行 7280 起） | `platform/web/app.js` | 回写为**实现里的真实那一行**（4 空格缩进 + 带 `query`）⇒ 消掉全计划唯一的 `❌`（T6-C5） |
| Task 6 Step 2 / Step 4 / Step 5 / Step 7 的文字 | 计划正文 | Step 2 的 Expected 订正；Step 4 的三处核验锚点 + 文字；Step 5 的 Expected 数字；Step 7 的提交命令补 `--` 与显式路径 |
| **核验锚点**（`web/app.js` 的 3 个片段块） | 计划正文 | `fragment-check.mjs` 的 hint 启发式只认「`**Step N: 修改 `path``」或「**行首**就是 `` `path` ``」两种形状 ⇒ 在三个块前各加一行行首锚点（`` `web/app.js`（…行 · 核验锚点） ``）⇒ 三个块**全部**纳入机器核验 |

### T6-D 实跑证据

| 环节 | 命令 | 结果 |
|---|---|---|
| Step 2 期望失败 | `cd platform && node --disable-warning=ExperimentalWarning --test test/workflow-e2e.test.js` | ⚠️ **当场通过（1/1）**，计划 Expected 不成立（T6-C1）；实跑证据本身就是缺陷证据 |
| 本 Task 单文件 | `cd platform && node --disable-warning=ExperimentalWarning --test test/workflow-e2e.test.js` | **12 例 / 通过 12 / 失败 0 / 跳过 0** |
| **全量** | `cd platform && node --disable-warning=ExperimentalWarning --test` | **1119 例 / 通过 1118 / 失败 0 / 跳过 1**（跳过的 1 例是 P0–P4 既有的） |
| 禁用表述扫描 | `cd platform && node scripts/audit-scan.js; echo "退出码=$?"` | **退出码 0** |
| 计划块核验 | `node /tmp/p3fix/plan-blocks.mjs <计划> platform` | **全计划 60 个块零不一致**（Task 6 的 2 个整文件块 ✅ + `web/app.js` 的 3 个片段块 ✅）；**Task 5 之前就存在的那一处 `web/app.js` ❌ 一并消除** |
| 片段核验 | `node /tmp/p4-proof/fragment-check.mjs <计划> platform web/views/tasks.js web/app.js test/workflow-e2e.test.js` | `核验 5 个片段块，不一致 0 个`（退出码 0） |
| 按路径核验 | `node /tmp/p3fix/block-by-path.mjs <计划> platform web/views/tasks.js test/workflow-e2e.test.js` | `共核验 2 个文件，不一致 0 个`（退出码 0） |
| 接线判别性自检 | 手工把 `web/app.js` 的路由注册删掉 / 把 `params` 透传删掉，各跑一次 | 两次都让「★ web/app.js 注册了 /tasks/:workflowId 且把 workflowId 透传给视图」**当场变红**（10/11 → 11/11）⇒ 该用例**不是恒绿** |

### T6-E 变异检验（`/tmp/p5-mutate/t6.mjs`，**不进仓库**）

**23 个变异体 → 杀 23 / 真等价 0 / 不可观测 0 / 缺口 0**（锚点命中异常 0 个：每个锚点都恰好命中 1 次）。

| 类别 | 编号 | 覆盖 |
|---|---|---|
| **杀死**（23） | T6-M01…M23 全体 | 模式判定（done / claimable / mine vs taken）/ 三段分类的每一条分支（落错段）/ **前端丢任务**（可见性过滤的同款病根）/ 可用操作（自主领取入口消失 / 提交完成消失 / **冒出一个「指派」操作**）/ 标题与详情的转义（存储型 XSS）/ 完成时间与领取人显示 / 路由参数取错 / 请求路径写错 / 「自主领取」按钮不挂上 / 按钮文案被改 / 领取请求打错接口 / app.js 不注册路由 / 路由参数被吃掉 / 不导入 `renderTasks` / `render()` 不透传 `params` |

**探针差分方法**（`/tmp/p5-mutate/t6.mjs` 内置 `PROBE`）：快照 = 5 个纯函数在 3 个登录人身份下的输出
（分类 / 操作 / 模式 / 行 HTML / 三段 HTML）**+** 起一个最小 DOM 桩跑**真实前端**后的
（请求序列 / 页面骨架 HTML / 任务行的 class 与子节点文案）。
⚠️ **第一版探针只覆盖纯函数** ⇒ 会漏掉「DOM 接线」层的变异（`T6-M17`…`T6-M19`）；
已把探针扩到**真实 DOM 行为**，并据此补了 3 条接线用例（按钮存在 / 按钮文案 / 点击后发对接口）。
**本轮 23 个变异体**全部被杀 ⇒ 纯函数层与 DOM 接线层**都**有判别力。

### T6-F 计划块逐字核验

| 文件 | 核验结果 |
|---|---|
| `platform/test/workflow-e2e.test.js` | 整文件块 ✅一致（361 行） |
| `platform/web/views/tasks.js` | 整文件块 ✅一致（206 行） |
| `platform/web/app.js` | 片段块 ×3 全部 ✅一致（导入行 / 路由注册行 / `render()` 透传行） |

### T6-G 遗留需上游注意

| # | 事项 | 说明 |
|---|---|---|
| G-1 | **「我领取的」段里会混入他人已领的任务** | 计划的分类只有三段（可领取的 / 我领取的 / 已完成的），且**他人已领**的任务既不属于「可领取」也不属于「已完成」⇒ 只能落进第二段（渲染上标记为 `task-taken`、**不给任何操作按钮**）。这是**计划原设计**，本轮未改（改了就是三段变四段，与 P5-10 的判据冲突）。若上游觉得语义别扭，须先改判据再改实现 |
| G-2 | **完成任务的证据表单在前端是「可运行版本」默认值** | 计划原设计：`kind: 'runnable'` + 产物链接 + 版本号。⛔ 前端**不提供** `kind: 'blocked'`（明确阻塞点）的入口 —— 但服务端 `completeTask` 支持 `kind='blocked'`（R-STG-04 要求「可运行状态**或**明确阻塞点」）。⇒ **「被卡住」的任务在前端无法提交**。本轮未改（超出计划范围），**建议上游补一个 blocked 入口** |
| G-3 | **`web/app.js` 与 P6 Task 6 冲突** | P6 Task 6 也改 `web/app.js`（两边在**不同分支**上）。本轮改动**最小且靠后**：只加了 1 行导入 + 2 行路由注册（`git diff --stat` = `3 insertions(+)`，**零删除、零重排**）⇒ 合并冲突面只有这 3 行 |
| G-4 | **前端路由用 hash（`#/tasks/<workflowId>`）** | 与既有 P0–P4 前端一致（`web/router.js` 是哈希路由）⇒ 部署时无需服务端 rewrite；计划 Step 6 的 `http://127.0.0.1:8080/#/tasks/<workflowId>` 写法正确 |
| G-5 | **任务的可见性完全在 API 层** | `GET /api/workflows/:id/tasks` 对无权者返回**空集**（200 + 空数组，三态状态码）⇒ 前端拿到空列表 ⇒ 页面三段都空。视图**不做任何过滤**（分桶恒等式：每个任务恰好落进一段，一个都不丢） |

### T6-H 本 Task 改动的文件清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `platform/web/views/tasks.js` | **新建**（P5） | 任务清单页：5 个纯函数（`taskMode` / `classifyTasks` / `taskActions` / `buildTaskItem` / `buildTaskSections`）+ `renderTasks(ctx)` 的 DOM 接线；⛔ 无指派/岗位控件（R-OPS-14）；⛔ 无前端过滤 |
| `platform/web/app.js` | Modify（P0 建立，**本 Task 只追加**） | 1 行导入 + 2 行路由注册（`route('/tasks/:workflowId', (c) => renderTasks(c));`）；`render()` 的 `params`/`query` 透传**本轮未改**（P0 终态已具备） |
| `platform/test/workflow-e2e.test.js` | **新建**（P5） | 12 例（后端闭环 1 + 视图纯函数 8 + 前端接线 3） |
| `docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md` | Modify | Task 6 代码块逐字回写 + Step 2/4/5/7 文字订正 + 三个核验锚点 + 本章台账 |
## P5 并发用例修复轮（父代理，2026-10-21 · 长期偶发失败的根因定位与处置）

> **背景**：本仓有一条**长期存在、多次排查未果**的偶发失败 —— 全量测试偶发红 1 例，
> 早先几次连跑全绿、未能复现，一直被记为「未定位」。
> 本轮把它**定位到了**（不是靠反复重跑碰运气，而是靠读断言 + 实跑观测数据），
> 并做了**结构性**修复。
>
> **编号约定**：本计划已有 `T2-C*` / `T3-C*` / `T3R-C*` / `T4-C*` / `T5-C*` / `T6-C*` 六套前缀；
> 本轮用 **`PC-*`**（Pools Concurrency），不与任何既有编号重号。

### A. 症状

```
not ok 484 - 真并发：两个连接同时领取同一任务，数据库只放行一个（放行权在数据库，不在应用层）
  error: '两次 INSERT 必须重叠才叫并发，实际区间 36170370~36170370'
```

复现条件：**负载相关**（本机空闲时连跑 20 轮不复发；8 个忙循环压满 CPU 时 30 轮复现 1 次）。

### B. 根因（两层，缺一不可）

**第一层：谓词写错了 —— 两个方向都错。**
原断言是 `Math.min(ra.t0, rb.t0) < Math.max(ra.t1, rb.t1)`（「min < max ⇒ 区间重叠」）。
这个写法**不蕴含重叠**：

| 真实情形 | 期望 | 旧谓词 | 结论 |
|---|---|---|---|
| A 完全在 B 之前（**根本没并发**） | 不重叠 | **判为重叠** | ⛔ **假通过** —— 恰好放过了本用例要防的那件事 |
| 真并发，但两次 INSERT 全程落在同一毫秒 | 重叠 | **判为不重叠** | ⛔ **假失败** —— 这就是现场那条 |
| 真并发且纳秒级交错 | 重叠 | 重叠 | ✅ |
| 真并发但两端相接 | 不重叠 | **判为重叠** | ⛔ 假通过 |

⇒ 正确的**区间重叠**判定是 `a0 < b1 && b0 < a1`。

**第二层：时间戳被截断到毫秒。**
worker 里是 `Number(process.hrtime.bigint() / 1000000n)` ⇒ 纳秒被砍成毫秒整数。
两次 INSERT 若快到落在同一毫秒（`t0 === t1 === 同一毫秒`），`min === max` ⇒ 断言必假。

**第三层（实跑才暴露）：即使把时间戳换成纳秒，两次 INSERT 仍可能整体错开。**
把时间戳改成纳秒后重跑，**40/40 必红**，现场数据是
`[36479482064708, 36479482133750] 与 [36479474365916, 36479474591041]` ——
B 整体比 A 早约 **7.7 ms**，两者**根本没重叠**。
原因：`Atomics.wait` 放行屏障后，线程从「被唤醒」到「真正跑起来」有**调度延迟**，
本机实测可达数毫秒 ⇒ 两个 worker 的 INSERT **不在同一时刻**发生。
⇒ 「两次 INSERT 的区间重叠」这件事，**靠时间戳是保证不了的**，必须**靠结构**保证。

### C. 处置（结构性改法，不是调参）

把「并发」从「靠时钟证明」改成「**靠共享标志位排定顺序**」：

```
holder:  BEGIN IMMEDIATE（取写锁）→ INSERT（成功）→ 置标志[1]
         → 等标志[2]（waiter 已准备发起 INSERT）→ 才 COMMIT
waiter:  等标志[1]（holder 已持锁）→ 置标志[2] → 才发起 INSERT
         ⇒ 此刻它必然**阻塞在 holder 的写锁上** → holder 提交后被唯一索引拒绝
```

于是恒有 `holder.t0 < waiter.t0 < holder.t1` 且 `waiter.t1 > holder.t1`
⇒ **区间重叠由构造保证**，与操作系统调度无关。
时间戳同时改成**纳秒**（`process.hrtime.bigint()` 是 `CLOCK_MONOTONIC`，
同一进程内的多个 worker 线程**基点相同** ⇒ 可直接跨线程比较），
谓词改成 `a0 < b1 && b0 < a1`。

### D. 实跑证据

| 对照 | 结果 |
|---|---|
| 旧实现 · CPU 负载下 30 轮 | **失败 1 轮**，错误信息 `实际区间 36977315~36977315`（与最初现场**完全一致**） |
| 旧实现 · 空闲 20 轮 | 失败 0 轮（说明是**负载相关**的偶发，不是每次必错） |
| 新实现 · CPU 负载下 30 轮 | **失败 0 轮** |
| 新实现 · 空闲 25 轮 | **失败 0 轮** |
| 谓词判别性探针（4 个构造区间） | 旧谓词判错 **3/4**；新谓词 **0/4** |

### E. 变异检验（本轮改的测试代码也要有牙）

| 变异体 | 内容 | 结果 |
|---|---|---|
| **M1**（产品侧） | 删掉 `006_pools.sql` 里的 `CREATE UNIQUE INDEX ux_task_claims_active` | **杀** —— 3 条用例红（本条 + 「部分唯一索引挡住重复有效领取」+ 「task-claims 仓储」） |
| **M3**（测试侧） | 把重叠断言改成恒假 | **杀** —— 本条用例红 |

⇒ 本用例不是「恒绿摆设」：它**真的**依赖数据库的唯一索引，也**真的**在检查并发。

### F. 处置后剩余的诚实边界

1. 本用例现在**确定性地**制造并发（holder 持写锁时 waiter 发起 INSERT），
   比原来「靠屏障祈祷它们撞上」**更强**，不是更弱。
2. ⚠️ **holder 恒为赢家、waiter 恒为输家** —— 这是构造决定的，不是「谁快谁赢」。
   本用例要验的是「**放行权在数据库，不在应用层**」，这个性质与谁赢无关。
3. 本轮**没有**改动任何产品代码 —— 缺陷全在**测试的断言与并发构造**里。

### G. 与既有台账的关系

- 本轮**不**改 P5 Task 2 的原始规格块语义（Task 2 建立的用例名与目的不变），
  只把**实现**换成结构化并发 ⇒ 计划块已按「真重写」口径**逐字同步**回本计划。
- P5 Task 5 / Task 6 的台账（`T5-*` / `T6-*`）与本轮**无交叉**。


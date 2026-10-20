# P5 工作流与三池 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「任务包 → 工作流 → 任务清单 → 队员自主领取任务完成」这条链路落成可运行的代码（R-OPS-13），并在**不提供岗位制**的前提下保证任务只能被自主领取（R-OPS-14）；在此之上建三池**底座**——项目池 / 人才池 / 资源池的派生同步与只读 API（R-POOL-01/02/03），以及增长飞轮闭环的最小可观测形态（R-POOL-04）；最后给出**无需登录**的公开榜单 API（token 鉴权 + 可见性过滤）与赛程 iCal 订阅，并配套个人积分终生上榜（R-RNK-10）。

**Architecture:** 延续 P0 的单进程零依赖架构。`src/domain/` 放纯函数（三池派生 / 任务完成证据校验 / iCal 生成，无 IO、无 `Date.now()`、无 `Math.random()`）；`src/services/` 放用例编排（workflow / pools / public-api）；所有 SQL 收在 `src/db/repo/`；`src/routes/` 挂 P5 的 9 条 API；`web/views/tasks.js` 是唯一的本阶段前端视图。**本阶段的灵魂是「一个派生值只有一个计算点、一条任务只有一个有效领取、一个公开接口只给该给的字段」**：三池同步是幂等重建（不是增量累加），任务领取靠数据库唯一约束兜底（不是应用层先查再插），公开接口显式过 `applyVisibility` 再做字段白名单投影（不是"默认给全量"）。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

> **上游依赖（执行前确认）**：本阶段消费 P0（基础设施 / `users` / `can()` / `audit_log`）、**P1**（`teams` / `team_members` / `task_packages` / `registrations`）、**P2**（`stage_results` / `stages`，**只读**）、**P3**（`points_ledger` / `tier_records` / `applyVisibility`）、**P4**（`src/errors.js` 的 `appError` / `src/db/tx.js` 的 `withTransaction`）。
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
│   │   ├── team-membership.js       只读 P1 的 team_members / teams（不依赖 P1 仓储的导出名）
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
    ├── workflow-service.test.js      领取唯一性 / 释放 / 完成证据 / 禁止岗位制 / 完成不加分
    ├── pools-sync.test.js            三池派生正确性 + 幂等（连跑两次一致）+ 积分唯一真源自检
    ├── public-api.test.js            token 鉴权 4 种失败 + 可见性过滤 + 公开字段白名单
    ├── icalendar.test.js             RFC 5545：VEVENT 数 / 折叠 / 转义 / CRLF / UTC 时间戳
    └── workflow-e2e.test.js          端到端：工作流 → 任务 → 领取 → 完成 → 同步三池 → 公开 API 拉榜单
```

**本阶段修改**

```
platform/src/config.js                加载并校验 rules/pools.json（新增 rules.pools 命名空间）
platform/src/server.js                挂载 src/routes/workflow.js + pools.js + public.js；响应支持原文输出（.ics）
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
- Create: `platform/src/db/repo/team-membership.js`
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
  - 仓储函数：`insertWorkflow` / `getWorkflow` / `listWorkflowsByEdition` / `insertWorkflowTask` / `getWorkflowTask` / `listWorkflowTasksByWorkflow` / `updateWorkflowTaskStatus` / `completeWorkflowTask` / `insertTaskClaim` / `getActiveClaim` / `releaseTaskClaim` / `countActiveClaims` / `isActiveMember` / `listMemberTeams` / `listTeamsByPackage` / `insertPoolProject` / `updatePoolProject` / `deletePoolProject` / `listPoolProjectRows` / `insertPoolTalent` / `updatePoolTalent` / `deletePoolTalent` / `listPoolTalentRows` / `insertPoolResource` / `updatePoolResource` / `deletePoolResource` / `listPoolResourceRows` / 派生源读取 / `insertPublicToken` / `findPublicToken` / `deletePublicToken`

> **⚠️ 本 Task 的灵魂（并发安全）**
> **「同一任务不能被两人同时领取」必须由数据库保证，不能由应用层保证。**
> 依据：设计文档 §6.4「加时陈述用独立表 + 唯一约束……**为什么用唯一约束而不是应用层判断**：一人一票必须由数据库保证。应用层的"先查再插"在并发下会插出两票」。
> → 落法：`CREATE UNIQUE INDEX ux_task_claims_active ON task_claims(task_id) WHERE released_at IS NULL;`
> → **部分唯一索引**的好处：列清单与契约逐字一致（不新增 `status` 列），且"释放后可以再领"天然成立（释放 = 写 `released_at`，旧行退出索引，新行入索引）。

- [ ] **Step 1: 写失败的测试**

`platform/test/pools-migration.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/pools-migration.test.js`
Expected: FAIL —— `assert.equal(result.version, 6)` 失败（当前迁移版本是 5，`006_pools.sql` 不存在，七张表一张都没建出来）

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

- [ ] **Step 6: 创建 `src/db/repo/team-membership.js`**

```javascript
// src/db/repo/team-membership.js — 队成员与队-任务包关系（只读 P1 的表）
// 依据：R-OPS-13 / R-OPS-14（自主领取的人必须是某个队的成员）
// ⚠️ 不依赖 P1 仓储层的导出名（契约未规定），本阶段自建只读入口，避免跨阶段撞名。
export function isActiveMember(db, teamId, userId) {
  const row = db
    .prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL')
    .get(teamId, userId);
  return row !== undefined;
}

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

export function listTeamsByPackage(db, editionId, taskPackageId) {
  return db
    .prepare('SELECT * FROM teams WHERE edition_id = ? AND task_package_id = ? AND deleted_at IS NULL ORDER BY id')
    .all(editionId, taskPackageId);
}
```

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
export function listEditionTierRecords(db, editionId) {
  return db
    .prepare(
      `SELECT tr.team_id, tr.tier, tr.milestone_count, tr.business_signoff_count, tr.computed_at, tr.deleted_at
         FROM tier_records tr
         JOIN teams t ON t.id = tr.team_id
        WHERE t.edition_id = ?
        ORDER BY tr.team_id, tr.computed_at`,
    )
    .all(editionId);
}

export function listEditionLedger(db, editionId) {
  return db
    .prepare(
      `SELECT id, edition_id, stage_id, team_id, user_id, kind, points, created_at
         FROM points_ledger WHERE edition_id = ? ORDER BY user_id, created_at, id`,
    )
    .all(editionId);
}

// 终生累计（R-RNK-10）：个人积分跨届期累加
export function listUserLedger(db, userId) {
  return db
    .prepare(
      `SELECT id, edition_id, stage_id, team_id, user_id, kind, points, created_at
         FROM points_ledger WHERE user_id = ? ORDER BY created_at, id`,
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
      `SELECT id, user_id, dimension_scores_json, level, created_at, deleted_at
         FROM registrations WHERE edition_id = ? ORDER BY user_id, created_at`,
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
Expected: PASS（5 个测试全过）

- [ ] **Step 11: 实跑迁移**

Run: `cd platform && node scripts/migrate.js`
Expected: 输出 `迁移完成，当前版本 6`，本次应用包含 `006_pools.sql`

- [ ] **Step 12: 提交**

```bash
cd platform && git add db/migrations/006_pools.sql src/db/repo test/pools-migration.test.js
git commit -m "feat(P5): 工作流与三池数据模型（006_pools.sql）+ 领取唯一约束 + 仓储层

对应 R-OPS-13 / R-OPS-14 / R-POOL-01 / R-POOL-02 / R-POOL-03：
- task_claims 用部分唯一索引保证同一任务同时只有一个人领取
- 三池表只提供仓储，不提供手工写入口（派生值单一来源）
- 任务清单与里程碑不共享表"
```

---

### Task 2: 任务清单与自主领取（禁止岗位制）

**Files:**
- Create: `platform/src/domain/task-evidence.js`
- Create: `platform/src/services/workflow.js`
- Modify: `platform/src/db/repo/team-membership.js`（追加 `getTeamById`）
- Test: `platform/test/workflow-service.test.js`

**Interfaces:**
- Consumes: Task 1 的 `workflows` / `workflow_tasks` / `task_claims` 与仓储；P0 的 `getUserById`（`src/db/repo/users.js`）；P4 的 `appError`（`src/errors.js`）
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
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import * as workflow from '../src/services/workflow.js';

const here = dirname(fileURLToPath(import.meta.url));
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

- [ ] **Step 4: 追加 `getTeamById` 到 `src/db/repo/team-membership.js`**

```javascript
// 追加到 src/db/repo/team-membership.js 末尾
export function getTeamById(db, id) {
  return db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}
```

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
import { isActiveMember, listMemberTeams, listTeamsByPackage, getTeamById } from '../db/repo/team-membership.js';

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
  const teams = listTeamsByPackage(db, workflow.edition_id, workflow.task_package_id);
  return teams.some((t) => isActiveMember(db, t.id, viewer.id));
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
  const teams = listTeamsByPackage(db, editionId, taskPackageId);
  const allowed = actor.is_superadmin === 1 || teams.some((t) => isActiveMember(db, t.id, actorId));
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
    const team = getTeamById(db, ownerTeamId);
    if (!team) throw appError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    if (actor.is_superadmin !== 1 && !isActiveMember(db, ownerTeamId, actorId)) {
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
    const team = getTeamById(db, teamId);
    if (!team) throw appError(404, 'TEAM_NOT_FOUND', '队伍不存在');
    if (!isActiveMember(db, teamId, userId)) {
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
Expected: PASS（11 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/domain/task-evidence.js src/services/workflow.js src/db/repo/team-membership.js test/workflow-service.test.js
git commit -m "feat(P5): 任务清单与自主领取（禁止岗位制，R-OPS-14）

对应 R-OPS-13 / R-OPS-14 / R-STG-04：
- 唯一获得任务的路径是 claimTask；不提供任何按岗位分配任务的出口
- 完成必须给可运行状态或明确阻塞点，纯文字进度说明被拒
- 完成任务不写积分（任务完成 ≠ 赛段交付物得分）"
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  syncPoolProjects, syncPoolTalents, syncPoolResources,
  listPoolProjects, listPoolTalents, listPoolResources,
} from '../src/services/pools.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
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

function syncAll(db, now = '2026-10-20T00:00:00.000Z') {
  syncPoolProjects({ db, editionId: 'ed_1', now });
  syncPoolTalents({ db, editionId: 'ed_1', now });
  syncPoolResources({ db, editionId: 'ed_1', now });
}

test('项目池从 teams + stage_results + tier_records 派生', () => {
  const { db, close, dataDir } = setup();
  syncPoolProjects({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
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
  const t2 = rows.find((r) => r.teamId === 'tm_2');
  assert.equal(t2.stageReached, 's1');
  assert.equal(t2.tier, 'D');
  cleanup(db, close, dataDir);
});

test('人才池从 points_ledger 聚合，且积分是终生累计（R-RNK-10）', () => {
  const { db, close, dataDir } = setup();
  syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  const rows = listPoolTalents({
    db, filter: { editionId: 'ed_1' }, viewer: { id: 'u_a', is_superadmin: 1, active: 1 },
  });
  assert.equal(rows.length, 1, '没有积分记录的人不进人才池');
  const t = rows[0];
  assert.equal(t.userId, 'u_a');
  assert.equal(t.totalPoints, 23, '10 + 5 + 8（含第二届）= 终生累计 23');
  assert.equal(t.stagesJoined, 3, '参与过的赛段数按 distinct stage 算');
  assert.equal(t.skills.length, 3, '技能来自报名画像维度分');
  assert.equal(t.mbaStatus, 'mba');
  cleanup(db, close, dataDir);
});

test('资源池从 task_packages 按（企业 × 类型）分组', () => {
  const { db, close, dataDir } = setup();
  syncPoolResources({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
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
  syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
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
  syncPoolTalents({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/pools-sync.test.js`
Expected: FAIL —— `Cannot find module '../src/services/pools.js'`

- [ ] **Step 3: 创建 `rules/pools.json`**

```json
{
  "id": "pools",
  "version": "2026-10-20",
  "source": "任务书 §九 三池沉淀 + §二 增长飞轮闭环 + S10 §3.3 个人积分终生上榜（R-RNK-10）+ S10 §3.4 反作弊第 3 条",
  "packageStatusFilter": [],
  "talentPointKinds": { "atomic": ["stage_rank", "mvp", "roadshow"], "rollup": "personal_rollup" },
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

export const ATOMIC_POINT_KINDS = ['stage_rank', 'mvp', 'roadshow'];
export const ROLLUP_POINT_KIND = 'personal_rollup';

function pick(row, camel, snake) {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

/**
 * 个人积分聚合（R-RNK-10 终生上榜）。
 * ledger: [{ userId, kind, points, stageId }]
 * 口径：
 *   · 有 personal_rollup 行 → 以 rollup 为准（它就是"已汇总"的行）
 *   · 否则累加 atomic 行（stage_rank / mvp / roadshow）
 *   · 两者都存在且不一致 → 以 rollup 为准，并产出显式 warning（不静默）
 * 返回：{ byUser: { [userId]: { total, stagesJoined, breakdown } }, warnings: [] }
 */
export function aggregatePersonalPoints({ ledger = [], pointsConfig = {} } = {}) {
  const atomicKinds = pointsConfig?.talentPointKinds?.atomic ?? ATOMIC_POINT_KINDS;
  const rollupKind = pointsConfig?.talentPointKinds?.rollup ?? ROLLUP_POINT_KIND;
  const eps = 1e-9;
  const byUser = new Map();
  const warnings = [];

  for (const row of ledger) {
    const userId = pick(row, 'userId', 'user_id');
    if (!userId) continue;
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId, atomic: 0, rollup: 0, atomicRows: 0, rollupRows: 0, stages: new Set(),
      });
    }
    const acc = byUser.get(userId);
    const points = Number(row.points) || 0;
    if (row.kind === rollupKind) {
      acc.rollup += points;
      acc.rollupRows += 1;
    } else if (atomicKinds.includes(row.kind)) {
      acc.atomic += points;
      acc.atomicRows += 1;
    } else {
      warnings.push({ code: 'points_kind_ignored', userId, kind: row.kind });
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
      userId: acc.userId,
      total,
      stagesJoined: acc.stages.size,
      breakdown: { atomic: acc.atomic, rollup: acc.rollup },
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
    if (ax === bx) return String(a.id).localeCompare(String(b.id));
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
    const prev = latestTier.get(teamId);
    if (!prev || at >= prev.at) {
      latestTier.set(teamId, {
        at,
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
  rows.sort((a, b) => String(a.teamId).localeCompare(String(b.teamId)));
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
    const prev = latestReg.get(userId);
    if (!prev || at >= prev.at) latestReg.set(userId, { at, reg: r });
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
  rows.sort((a, b) => b.totalPoints - a.totalPoints || String(a.userId).localeCompare(String(b.userId)));
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
      packageCount: g.titles.length,
    });
  }
  rows.sort((a, b) => String(a.enterpriseId).localeCompare(String(b.enterpriseId)) || a.kind.localeCompare(b.kind));
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

function nowIso(now) {
  return now ?? new Date().toISOString();
}

/** 事务：单写者约束下，同步必须整体成功或整体回滚（设计文档 §11「事务回滚，无部分写入」）。 */
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
    throw err;
  }
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

  return inTransaction(db, () => {
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
  const pointsConfig = rules?.pools;

  const editionUsers = srcRepo.listEditionUsers(db, editionId);
  const ledger = [];
  for (const u of editionUsers) ledger.push(...srcRepo.listUserLedger(db, u.id));

  const { rows, warnings } = derivePoolTalents({
    users: editionUsers,
    ledger,
    registrations: srcRepo.listEditionRegistrations(db, editionId),
    pointsConfig,
  });

  const result = inTransaction(db, () => {
    const allRows = poolRepo.listPoolTalentRows(db, null);
    const rowsOfUser = new Map();
    for (const r of allRows) {
      if (!rowsOfUser.has(r.user_id)) rowsOfUser.set(r.user_id, []);
      rowsOfUser.get(r.user_id).push(r);
    }
    let inserted = 0;
    let updated = 0;
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
    return { editionId, inserted, updated, removed, total: rows.length, at, warnings };
  });

  // ⭐ 唯一真源自检：写入后用【同一个】纯函数重算比对
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
  return result;
}

/** 资源池同步：task_packages → pool_resources（按企业 × 类型分组）。 */
export function syncPoolResources({ db, editionId, now, rules }) {
  const at = nowIso(now);
  requireEdition(editionId);
  const packages = srcRepo.listEditionPackages(db, editionId, { statuses: packageStatuses(rules) });
  const rows = derivePoolResources({ packages });

  return inTransaction(db, () => {
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
    const kinds = pools.talentPointKinds;
    if (!kinds || !Array.isArray(kinds.atomic) || !kinds.atomic.length || !kinds.rollup) {
      errors.push('pools.talentPointKinds 必须给出 atomic 数组与 rollup 名称');
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
Expected: PASS（8 个测试全过）

Run: `cd platform && node --test test/config.test.js`
Expected: PASS（仓库自带的 9 份 + 本阶段的 `pools.json` 一起通过校验）

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
- Create: `platform/src/routes/workflow.js`
- Create: `platform/src/routes/pools.js`
- Create: `platform/src/routes/public.js`
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
import { createPublicToken, resolvePublicToken, getPublicLeaderboard } from '../src/services/public-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5pub-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000031', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z'),
           ('u_sign', '签字人丁', '13900000032', 'x', 'other', '某银行', 0, 1, '2026-10-01T00:00:00.000Z');
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
           ('tm_ghost', 'ed_1', '幽灵队', 'u_a', 'tp_1', 'C', 'active', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO team_members (team_id, user_id, role, joined_at, left_at)
    VALUES ('tm_1', 'u_a', 'captain', '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed');
    INSERT INTO stage_results (id, stage_id, team_id, rank, total, seat_p, seat_e, tied_with, points, computation_id, created_at)
    VALUES ('sr_1', 'st_1', 'tm_1', 1, 90.0, 88.0, 95.0, 0, 10, NULL, '2026-10-10T00:00:00.000Z'),
           ('sr_2', 'st_1', 'tm_2', 2, 80.0, 82.0, 76.0, 0, 8, NULL, '2026-10-10T00:00:00.000Z');
    INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
    VALUES ('tr_1', 'tm_1', 'C', 2, 1, '[]', '2026-10-12T00:00:00.000Z', NULL),
           ('tr_2', 'tm_2', 'D', 0, 0, '[]', '2026-10-12T00:00:00.000Z', NULL);
    INSERT INTO peer_reviews (id, stage_id, from_team_id, to_team_id, score, request_id, created_at)
    VALUES ('pr_1', 'st_1', 'tm_ghost', 'tm_1', 7.5, 'req_1', '2026-10-10T00:00:00.000Z');
  `);
  return { db, close, dataDir, rules };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/public-api.test.js`
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
import * as tokenRepo from '../db/repo/public-tokens.js';
import * as srcRepo from '../db/repo/pool-sources.js';

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
```

- [ ] **Step 4: 创建 `src/routes/workflow.js`**

```javascript
// src/routes/workflow.js — 任务清单 API
// 依据：INTERFACES.md §6 的 P5 API 清单；R-OPS-13 / R-OPS-14
// ⛔ R-OPS-14：禁止岗位制，任务只能自主领取 —— 这里【没有】任何"按岗位分配任务"的端点。
import { appError } from '../errors.js';
import {
  createWorkflow, createWorkflowTask, listWorkflowTasks,
  claimTask, releaseTask, completeTask,
} from '../services/workflow.js';

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

- [ ] **Step 5: 创建 `src/routes/pools.js`**

```javascript
// src/routes/pools.js — 三池只读 API + 同步
// 依据：INTERFACES.md §6 的 P5 API 清单；R-POOL-01/02/03/04
// ⚠️ 一期【不做三池前台页面】（设计文档 §1.2）：这里只提供只读 API 与同步入口。
import { appError } from '../errors.js';
import { can } from '../auth/permissions.js';
import {
  syncPoolProjects, syncPoolTalents, syncPoolResources,
  listPoolProjects, listPoolTalents, listPoolResources,
} from '../services/pools.js';

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

- [ ] **Step 6: 创建 `src/routes/public.js`**

```javascript
// src/routes/public.js — 公开接口（无需登录，token 鉴权）
// 依据：INTERFACES.md §6 的 P5 API 清单
// ⚠️ token 走 query 参数（契约如此）：部署时应在 nginx 层关掉 query 串的访问日志（P6 负责）。
import { getPublicLeaderboard } from '../services/public-api.js';

export function registerPublicRoutes(router, { db, rules }) {
  router.add('GET', '/api/public/leaderboard', async ({ query }) =>
    getPublicLeaderboard({
      db,
      token: query.token,
      editionId: query.editionId,
      rules,
    }));
}
```

- [ ] **Step 7: 修改 `src/server.js`（挂载路由 + 支持原文响应）**

在 `src/server.js` 顶部的导入区加入：

```javascript
import { json, error, text } from './http/respond.js';
import { registerWorkflowRoutes } from './routes/workflow.js';
import { registerPoolsRoutes } from './routes/pools.js';
import { registerPublicRoutes } from './routes/public.js';
```

（把原来那行 `import { json, error } from './http/respond.js';` 替换成上面这行。）

在 `createApp()` 里、`router.add('GET', '/api/me', ...)` 之后加入：

```javascript
  // ── P5 路由 ────────────────────────────────────────────────
  registerWorkflowRoutes(router, { db, rules });
  registerPoolsRoutes(router, { db, rules });
  registerPublicRoutes(router, { db, rules });
```

在 `handle()` 里，把

```javascript
        const result = await match.handler(ctx);
        json(res, 200, result ?? { ok: true });
```

替换成：

```javascript
        const result = await match.handler(ctx);
        // 原文响应（.ics 等）：P0 的 handler 统一 json() 序列化，这里走 text()
        if (result && typeof result === 'object' && result.__rawText === true) {
          text(res, 200, String(result.body ?? ''), result.contentType || 'text/plain; charset=utf-8');
          return;
        }
        json(res, 200, result ?? { ok: true });
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd platform && node --test test/public-api.test.js`
Expected: PASS（10 个测试全过）

Run: `cd platform && node --test`
Expected: 全部通过（P0–P5 累计）

- [ ] **Step 9: 提交**

```bash
cd platform && git add src/services/public-api.js src/routes src/server.js test/public-api.test.js
git commit -m "feat(P5): 公开榜单 API（token 鉴权 + 显式可见性过滤）与 P5 路由挂载

对应 R-RNK-04 / R-RNK-10 / R-POOL-01~04：
- 无 token / 过期 / 跨届期 / scope 不符一律 403
- 公开响应显式过 applyVisibility + 字段白名单投影，D 段队伍不公示
- 补齐任务清单与三池的 HTTP 入口"
```

---

### Task 5: iCal 日历导出（手写 RFC 5545，零依赖）

**Files:**
- Create: `platform/src/domain/icalendar.js`
- Modify: `platform/src/services/public-api.js`（追加 `buildICalendar`）
- Modify: `platform/src/routes/public.js`（追加 `GET /api/public/calendar.ics`）
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
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  buildICalendarText, formatICalTimestamp, escapeICalText, foldICalLine,
} from '../src/domain/icalendar.js';
import { buildICalendar } from '../src/services/public-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5ics-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  db.exec(`
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届 · 杭州', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '任务', 'initial', '2026-10-10', '2026-10-13', NULL, 'initial', 'computed'),
           ('st_3', 'ed_1', 's3', '开发', 'initial', '2026-10-13', '2026-10-25', NULL, 'initial', 'open');
  `);
  return { db, close, dataDir };
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/icalendar.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/icalendar.js'`

- [ ] **Step 3: 创建 `src/domain/icalendar.js`**

```javascript
// src/domain/icalendar.js — RFC 5545 日历文本生成（纯函数）
// 依据：设计文档 §8「公开榜单 API + 赛程 iCal 订阅」；INTERFACES.md §6 `buildICalendar`
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
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= ICAL_LINE_MAX_OCTETS) return text;

  const parts = [];
  let start = 0;
  let limit = ICAL_LINE_MAX_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // 回退到字符边界：bytes[end] 若是续接字节（10xxxxxx）说明劈开了多字节字符
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
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

- [ ] **Step 5: 在 `src/routes/public.js` 追加日历路由**

把导入区改成：

```javascript
import { getPublicLeaderboard, buildICalendar, resolvePublicToken } from '../services/public-api.js';
```

在 `registerPublicRoutes` 里追加：

```javascript
  // 赛程日历（iCal）。⛔ 同样要 token：公开 ≠ 无鉴权。
  router.add('GET', '/api/public/calendar.ics', async ({ query }) => {
    resolvePublicToken({
      db, token: query.token, requiredScope: 'calendar', editionId: query.editionId,
    });
    const body = buildICalendar({ db, editionId: query.editionId });
    return { __rawText: true, body, contentType: 'text/calendar; charset=utf-8' };
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/icalendar.test.js`
Expected: PASS（8 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/domain/icalendar.js src/services/public-api.js src/routes/public.js test/icalendar.test.js
git commit -m "feat(P5): iCal 日历导出（手写 RFC 5545，零依赖）

对应设计文档 §8 公开日历订阅：
- 行折叠 ≤75 octets、逗号/分号/反斜杠转义、CRLF 行尾、UTC 时间戳
- 日历接口同样要 token（scope=calendar）"
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
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { createPublicToken } from '../src/services/public-api.js';

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

function call(app, method, path, { token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const headers = {};
    if (token) headers.cookie = `hk_session=${token}`;
    if (body) headers['content-type'] = 'application/json';
    const req = {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
      on() {},
    };
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/workflow-e2e.test.js`
Expected: FAIL —— `POST /api/workflows` 返回 404（`src/routes/workflow.js` 未在 `src/server.js` 挂载，或视图文件不存在）

- [ ] **Step 3: 创建 `web/views/tasks.js`**

```javascript
// web/views/tasks.js — 任务清单页
// 依据：设计文档 §9 前端信息架构「赛段与任务清单 + 自主领取任务」；R-OPS-13 / R-OPS-14
// R-OPS-14：页面只有「自主领取」一个入口，⛔ 不出现"指派给某人""按岗位分工"这类控件。
// ⚠️ 前端不做可见性过滤：过滤在 API 层完成（前端隐藏 = 数据已泄露）。
export function renderTasks(ctx) {
  const { api } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'card tasks';
  const workflowId = ctx.params?.workflowId ?? '';

  wrap.innerHTML = `
    <h1>任务清单</h1>
    <p class="muted">任务只能自主领取 —— 严禁按岗位和身份分工（R-OPS-14）</p>
    <section>
      <h2>可领取的</h2>
      <ul class="task-list" id="task-claimable"></ul>
    </section>
    <section>
      <h2>我领取的</h2>
      <ul class="task-list" id="task-mine"></ul>
    </section>
    <section>
      <h2>已完成的</h2>
      <ul class="task-list" id="task-done"></ul>
    </section>
    <p class="err" id="task-err"></p>
  `;

  const errBox = wrap.querySelector('#task-err');
  const listClaimable = wrap.querySelector('#task-claimable');
  const listMine = wrap.querySelector('#task-mine');
  const listDone = wrap.querySelector('#task-done');

  function showError(message) {
    errBox.textContent = message || '';
  }

  function reload() {
    return load();
  }

  async function load() {
    showError('');
    try {
      const res = await api.get(`/api/workflows/${encodeURIComponent(workflowId)}/tasks`);
      const tasks = res.tasks ?? [];
      const me = ctx.getState?.().user?.id ?? null;
      listClaimable.replaceChildren();
      listMine.replaceChildren();
      listDone.replaceChildren();

      for (const t of tasks) {
        if (t.status === 'done') {
          listDone.appendChild(renderTask(t, 'done', me));
        } else if (t.claim && t.claim.userId === me) {
          listMine.appendChild(renderTask(t, 'mine', me));
        } else if (!t.claim) {
          listClaimable.appendChild(renderTask(t, 'claimable', me));
        } else {
          listMine.appendChild(renderTask(t, 'taken', me));
        }
      }
    } catch (e) {
      showError(e.message || '加载任务清单失败');
    }
  }

  function renderTask(t, mode, me) {
    const li = document.createElement('li');
    li.className = `task task-${mode}`;
    const who = t.claim ? `领取人：${t.claim.userId}` : '无人领取';
    li.innerHTML = `
      <span class="task-title">${escapeHtml(t.title)}</span>
      <span class="task-meta">${escapeHtml(t.detail || '')} · ${escapeHtml(who)} · 状态 ${escapeHtml(t.status)}</span>
    `;

    if (mode === 'claimable') {
      const btn = document.createElement('button');
      btn.textContent = '自主领取';
      btn.addEventListener('click', async () => {
        try {
          await api.post(`/api/tasks/${encodeURIComponent(t.id)}/claim`, {});
          await reload();
        } catch (e) {
          showError(e.message || '领取失败');
        }
      });
      li.appendChild(btn);
    }

    if (mode === 'mine') {
      const url = document.createElement('input');
      url.placeholder = '可运行产物链接（如仓库地址）';
      const ver = document.createElement('input');
      ver.placeholder = '版本号（如 v0.1）';
      const done = document.createElement('button');
      done.textContent = '提交完成状态';
      done.addEventListener('click', async () => {
        try {
          await api.post(`/api/tasks/${encodeURIComponent(t.id)}/complete`, {
            evidence: {
              kind: 'runnable',
              summary: url.value.trim() ? `已提交可运行版本 ${ver.value.trim() || '未标注版本'}` : '已提交可运行版本',
              artifactUrl: url.value.trim(),
              version: ver.value.trim(),
            },
          });
          await reload();
        } catch (e) {
          showError(e.message || '提交失败');
        }
      });
      const release = document.createElement('button');
      release.textContent = '释放任务';
      release.addEventListener('click', async () => {
        try {
          await api.post(`/api/tasks/${encodeURIComponent(t.id)}/release`, {});
          await reload();
        } catch (e) {
          showError(e.message || '释放失败');
        }
      });
      li.appendChild(url);
      li.appendChild(ver);
      li.appendChild(done);
      li.appendChild(release);
    }

    if (mode === 'done') {
      const at = document.createElement('span');
      at.className = 'task-meta';
      at.textContent = `完成于 ${t.completedAt || ''}`;
      li.appendChild(at);
    }

    return li;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  load();
  return wrap;
}
```

- [ ] **Step 4: 修改 `web/app.js`（注册路由 + 透传路由参数）**

在导入区加一行：

```javascript
import { renderTasks } from './views/tasks.js';
```

在 `route('/', ...)` 附近加一行：

```javascript
route('/tasks/:workflowId', (ctx) => renderTasks(ctx));
```

把 `const el = await found.view(ctx);` 改成：

```javascript
      const el = await found.view({ ...ctx, params: found.params });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/workflow-e2e.test.js`
Expected: PASS（1 个端到端用例通过）

Run: `cd platform && node --test`
Expected: 全部通过

- [ ] **Step 6: 人工验收任务清单页**

Run: `cd platform && node scripts/migrate.js && node scripts/seed.js && node src/server.js &`
Expected: 输出 `heikesong-platform 启动于 http://127.0.0.1:8080（规则版本 2026-10-20）`

Run: 浏览器打开 `http://127.0.0.1:8080/#/tasks/<workflowId>`（workflowId 来自 `POST /api/workflows` 的返回）
Expected: 页面分三段显示「可领取的 / 我领取的 / 已完成的」；点「自主领取」后任务移入「我领取的」；页面**没有**任何指派/岗位控件

- [ ] **Step 7: 提交**

```bash
cd platform && git add web/views/tasks.js web/app.js test/workflow-e2e.test.js
git commit -m "feat(P5): 任务清单前端页 + 端到端验收（工作流→任务→领取→完成→同步→公开榜）

对应 R-OPS-13 / R-OPS-14 / R-POOL-01~04 / R-RNK-10：
- 页面只有自主领取入口，无任何按岗位指派的控件
- 端到端跑通公开 API 拉榜，D 段队伍不公示"
```

---

## P5 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P5-1 | 迁移 006 建出七张表 | `cd platform && node --test test/pools-migration.test.js` 通过；`node scripts/migrate.js` 输出「迁移完成，当前版本 6」 |
| P5-2 | **同一任务不能被两人同时领取** | `node --test test/workflow-service.test.js` 通过：甲领取成功后乙领取返回 409 `TASK_ALREADY_CLAIMED`，且 `SELECT count(*) FROM task_claims WHERE task_id=? AND released_at IS NULL` 恒为 1；绕过应用层直接第二次 INSERT 被数据库拒绝（部分唯一索引） |
| P5-3 | 完成必须给可运行状态或明确阻塞点，**且不加分** | 同上文件：只传 `summary` → 400 `EVIDENCE_REQUIRED` 且任务状态不变；`kind=runnable` 且带链接+版本 → 200 且状态 `done`、证据落库；`kind=blocked` 且写明阻塞点与解除条件 → 状态 `blocked`；完成一个任务后 `SELECT count(*) FROM points_ledger` 不变（任务完成 ≠ 赛段交付物得分） |
| P5-4 | **禁止岗位制**（刻意缺失） | `grep -nE "assignTask\|assignByRole\|assignTaskByPosition\|dispatchTask\|allocateTask" platform/src/services/workflow.js platform/src/routes/workflow.js` 无命中；服务层导出里只有 `claimTask` 能让人拿到任务；`rules/pools.json` 的 `workflow.claimMode` = `self_claim_only`，改成别的值启动即失败 |
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
| `src/routes/workflow.js` / `pools.js` / `public.js` | P4 已建议 P1–P6 统一采用 `src/routes/*.js`（P1/P2 用的是 `src/http/routes/`）。本阶段跟随 P4（更晚 = 更接近终态）；若 P6 决定统一回 `src/http/routes/`，只需移动文件 |
| `src/db/repo/team-membership.js` | 只读 P1 的 `team_members` / `teams`。契约未规定 P1 仓储层的导出名，自建只读入口可避免跨阶段撞名 |
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
| 错误模块的位置与签名 | P1/P4 建 `src/errors.js`（`appError(status, code, message, detail)`），P3 建 `src/errors/app-error.js`（`appError(code, message, status, detail)`）——**两处并存、参数顺序相反**。P5 只用 `src/errors.js`（执行顺序上 P4 在 P5 之后，其版本为准）。**建议 P6 统一**，本阶段不擅自改动他人文件 | P3 / P4 |

### F. 与契约 §8「阶段间依赖一览」的两处出入

1. **§8 写「P5 ← P0 + P1 + P3」，但 §6 要求 `pool_projects` 从 `stage_results` 派生**——而 `stage_results` 是 **P2** 建的表（契约 §3）。→ **P5 额外只读 P2 的 `stages` 与 `stage_results`**（只读，不写）。
2. **§8 未列 P4，但 P5 消费 P4 的 `src/errors.js`（`appError`）**。执行顺序上 P4 在 P5 之前，可用。若 P1/P4 的 `src/errors.js` 最终导出名不是 `appError`，P5 只需改一行 import。

### G. 一处口径调和（不是冲突，是把两句话的适用边界写清楚）

- **R-STG-04「纯文字进度说明不给分」** 原文针对的是**赛段交付物打分**（P2/P3 的评审对象）。本阶段只把它用来约束**任务清单的完成记录**：`completeTask` 只写 `workflow_tasks` 的状态与证据，⛔ **不写 `points_ledger`、不写 `behavior_events`、不产生任何分数**。→ **任务完成 ≠ 赛段交付物得分**（有测试断言）。
- **「列表不满足 → 200 + 空集」** 与 **R-AUD-05「空结果必须显式报错」** 适用范围不同：读取类列表（三池、任务清单）仍按三态返回 200 + 空集；**写入/同步类**（同步三池、提交完成状态）返回空才是危险场景 → 一律抛错或 4xx，不返回空成功。

### H. 本阶段的**刻意功能缺失**（不是遗漏，评审时不要当 bug 提）

| 缺什么 | 为什么 |
|---|---|
| 任何「按岗位 / 身份分配任务」的接口、函数、数据列 | **R-OPS-14 禁止岗位制**：任务书 §六「严禁按岗位和身份分工」；探月黑客松因岗位制失败（忙的忙死、闲的闲死、最后一个人说了算）。任务的唯一获得路径是 `claimTask` |
| 三池前台页面 | 设计文档 §1.2：一期只做底座；先让报名/榜单/评审跑通并可复算，三池是这些数据的自然沉淀物，单独做前台会得到「空池无内容」的死界面 |
| 三池的手工写入口 | 派生值单一来源：只能由同步服务写入，手工改一次就会与派生源口径不一致 |
| 任务清单与里程碑的任何联动 | **任务清单 ≠ 里程碑**：里程碑是企业签字的客观事实（报名时固定、不可自行新增，S10 §3.4 / R-STG-03），工作流任务是队内自主领取的工作项。两者不共享表、不共享规则 |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

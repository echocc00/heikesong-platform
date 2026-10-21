# P4 审计与防作弊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每一次发榜都能被复算、让每一次异常都能被看见。具体交付：计算快照（带规则版本）+ 复算 diff、落库的三层限频 + 幂等键、四个防作弊检测器 + 复核队列、复核与申诉状态机、审计 API 与前端 trace 抽屉，以及一个「清单为空即报错」的发布前扫描闸。

**Architecture:** 延续 P0 的单进程零依赖架构。`src/domain/` 放纯函数（diff / anticheat / evidence / field-dictionary，无 IO、无 `Date.now()`、无 `Math.random()`）；`src/services/` 放用例编排（audit / rate-limit / idempotency / review-state / anticheat）；所有 SQL 收在 `src/db/repo/`；`src/http/routes/audit.js` 挂 7 个 P4 路由；`web/views/audit.js`（trace 抽屉）与 `web/views/flags.js`（复核队列）是两个原生 ESM 视图，无构建。**本阶段的灵魂不是"加日志"，而是"让空结果与降级必须显式暴露"**：批量返回空 → 4xx；限频超限 → 429 + `retryAfterSeconds`；复算不一致 → diff 出现在 API 响应与前端（不是只写一条日志）；禁用清单为空 → 扫描闸直接报错退出。

**Tech Stack:** Node ≥22.16.0（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

> **上游依赖（执行前确认）**：本阶段消费 P0（基础设施 / `audit_log` 表 / 权限与 `can()`）、**P2**（`src/domain/scoring.js` 的 `scoreStage` 纯函数、`computation_snapshots` 表）、**P3**（`tier_records` 表，用于申诉范围判定）。若 P2/P3 尚未落地，P4 的测试会以「找不到模块 / 缺表」失败——这是依赖缺失，不是本阶段的 bug。

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
────────── 以下为 P4 追加 ──────────────────────────────────────────
空结果      ⛔ 批量接口 / 批处理返回空 → 4xx，绝不返回空成功（R-AUD-05）。
            ⛔ 与「三态状态码」不冲突：列表【读取】仍按三态返回 200+空集；
               批量【写入/处理】返回空才是 R-AUD-05 说的危险场景。
降级可见    降级/告警一律进 warnings，并在 API 响应与前端【置顶】呈现。
            ⛔ 只写一条日志 = 没写（复算 diff 必须能被看见）。
检测≠处罚   ⛔ 防作弊检测器只产出 flag 进复核队列：不改分、不封号、不自动裁决。
            「告警但不自动处罚」的边界要同时写进代码注释与验收标准。
限频落库    限频计数必须落 rate_limit_events。⛔ 只在内存计数 = 进程重启即失效 = 等于没有限频。
限频响应    触发限频 → 429 + retryAfterSeconds + Retry-After 响应头。⛔ 绝不静默丢包。
幂等键      同一 request_id 重复提交【只生效一次】，且重复请求返回【首次的响应】（不重新算）。
快照三件套  computation_snapshots 必含 rule_version / input / output / trace（设计文档 §12）。
规则版本    复算时若规则版本已变更 → 必须在 warnings 显式说明「无法严格复算」，
            ⛔ 不得静默当作 identical=true。
字段字典    所有审计明细的字段名以 src/domain/field-dictionary.js 为唯一来源；
            未知字段名 / 互斥字段名 / 非法的置信度标签在【写入前】拒绝（R-AUD-06）。
证据三列    证据必含 URL / 发行方 / 独立性；【按发行方去重，不按 URL 计数】（R-AUD-04）。
追加式      评分/签字/审计记录只增不改；重算走 revision + 1，旧 revision 保留供复盘（R-JDG-17）。
留档 6 月   审计与打分明细赛后 6 个月可查（R-JDG-17 / S7 §4.2）→ 归档月数进 rules/audit.json。
```

## File Structure

**本阶段创建**

```
platform/
├── rules/
│   └── audit.json                  限频配额 / 防作弊阈值 / 复核与申诉 / 留档月数 / TOP10 回访
├── db/migrations/
│   └── 005_audit.sql               flagged_reviews / idempotency_keys / rate_limit_events / appeals
├── src/
│   ├── errors.js                   AppError 构造（status + code + message + detail）
│   ├── db/
│   │   ├── tx.js                   withTransaction（SAVEPOINT，可嵌套）
│   │   └── repo/
│   │       ├── audit-log.js        audit_log（P0 建表；**P2 Task 4 已建**，本阶段只追加两个只读查询）
│   │       ├── computations.js     computation_snapshots（读 + revision 递增）
│   │       ├── flags.js            flagged_reviews
│   │       ├── idempotency.js      idempotency_keys
│   │       ├── rate-limit.js       rate_limit_events
│   │       ├── appeals.js          appeals
│   │       └── tiers.js            tier_records 读（P3 建表，本阶段只读）
│   ├── audit/
│   │   └── log.js                  审计日志门面（**P2 Task 4 已建**，本阶段只复用）
│   ├── domain/
│   │   ├── diff.js                 结构化差异比对（纯函数，带可定位 path）
│   │   ├── anticheat.js            4 个检测器 + 1 个同分互投率检测（纯函数）
│   │   ├── evidence.js             证据三列规范化 + 按发行方去重（纯函数）
│   │   └── field-dictionary.js     审计字段字典（唯一字段名来源）
│   ├── services/
│   │   ├── audit.js                快照记录 / 读取 / 复算 diff / 审计日志
│   │   ├── rate-limit.js           三层限频 + 评委级每小时配额
│   │   ├── idempotency.js          幂等键执行器（只生效一次 + 返回首次响应）
│   │   ├── review-state.js         复核与申诉状态机 + 分数可见性过滤
│   │   └── anticheat.js            检测编排：跑检测器 → 落 flagged_reviews → 裁决
│   └── http/routes/
│       └── audit.js                7 个 P4 路由（与 P1/P2 的 src/http/routes/ 同一目录）
├── scripts/
│   └── audit-scan.js               发布前证据链扫描闸（清单为空即报错）
├── web/views/
│   ├── audit.js                    trace 抽屉（原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分）
│   └── flags.js                    复核队列
└── test/
    ├── audit-repo.test.js          迁移 005 + 仓储读写 + 事务回滚
    ├── audit-snapshot.test.js      快照记录 / 复算 diff / 规则版本变更 / 审计日志
    ├── rate-limit.test.js          三层限频 + 评委级配额 + 429 + 幂等键
    ├── anticheat.test.js           4+1 个检测器 + flag 落库 + 裁决 + 证据去重
    ├── field-dictionary.test.js    字段字典：未知字段 / 互斥字段 / 置信度标签
    ├── review-state.test.js        状态机 / 幂等守卫 / 申诉范围 / 可见性过滤
    ├── audit-api.test.js           7 个 API + 429 + 404 + 空列表
    ├── audit-scan.test.js          扫描闸：能拦下 / 豁免语境 / 清单为空报错
    └── recompute-e2e.test.js       端到端复算：改一个原始分 → diff 非空
```

**本阶段修改**

```
platform/src/config.js              加载并校验 rules/audit.json（新增 rules.audit 命名空间）
platform/src/server.js              挂载 src/http/routes/audit.js；错误响应带上 detail 与 Retry-After
platform/src/http/respond.js        error() 增加可选 extraHeaders（第 6 参，向后兼容）
platform/scripts/seed.js            新增能力点 audit:write / appeal:write 并授权
platform/scripts/forbidden.txt      补齐真实词条（原 P0 计划只声明"不得为空"，未给内容）
platform/package.json               scripts 增加 "audit": "node scripts/audit-scan.js"
platform/web/app.js                 注册 /audit 与 /flags 路由 + 导航入口
```

---

### Task 1: 审计数据模型与迁移 `005_audit.sql`

**Files:**
- Create: `platform/db/migrations/005_audit.sql`
- Create: `platform/src/db/tx.js`
- Modify: `platform/src/db/repo/audit-log.js`（**P2 Task 4 已建**；本阶段只**追加** `queryAuditLog` / `findLatestTransition`，**不重建文件**、不改 P2 已有的 `insertAuditLogRow` / `queryAuditLogRows`）
- Create: `platform/src/db/repo/flags.js`
- Create: `platform/src/db/repo/idempotency.js`
- Create: `platform/src/db/repo/rate-limit.js`
- Create: `platform/src/db/repo/appeals.js`
- Modify: `platform/src/errors.js`（**P0 Task 4 已建**（归属从 P1 提前到 P0）；本阶段只**追加**快捷函数，**不重建** `AppError` 类、不改 `appError(status, code, message, detail?)` 的签名）
- Reuse: `platform/src/audit/log.js`（**P2 Task 4 已建**；本阶段**一行不改** —— `writeAuditLog(db, { actorId, action, entity, entityId, detail, now })` 的签名**已经**符合本阶段需要，且它已把 SQL 委托给 `src/db/repo/audit-log.js`；本阶段**不再**定义第二个写入口）
- Modify: `platform/src/db/repo/computations.js`（**P2 Task 6 已建**；本阶段只**追加** `nextRevision` / `listComputationRows`，不重建文件）
- Test: `platform/test/audit-repo.test.js`

**Interfaces:**
- Consumes: P0 的 `openDatabase()` / `applyMigrations()`（Task 2）、`audit_log` 表（P0 `001_init.sql`）
- Produces:
  - `appError(status, code, message, detail?)` → 带 `status` / `code` / `detail` 的 Error；另有 `notFound` / `badRequest` / `forbidden` / `conflict` / `rateLimited` 快捷函数
  - `withTransaction(db, fn)` → 在 SAVEPOINT 内执行 `fn()`；抛错则回滚
  - `writeAuditLog(db, { actorId, action, entity, entityId, detail, now })` → audit_log 行 id
  - 仓储：`insertAuditLog` / `queryAuditLog` / `findLatestTransition`、`insertComputation` / `getComputationRow` / `nextRevision` / `listComputationRows`、`createFlag` / `findOpenFlag` / `listFlagRows` / `resolveFlagRow`、`findIdempotency` / `insertIdempotency`、`countBucket` / `incrementBucket` / `slidingWindowCount` / `slidingWindowEvents` / `acquireLock`、`insertAppeal` / `getAppeal` / `listAppealRows` / `updateAppeal`

- [ ] **Step 1: 写失败的测试**

`platform/test/audit-repo.test.js`：

```javascript
// platform/test/audit-repo.test.js —— P4 审计数据模型与仓储层
//
// 规则溯源：
//   - 限频计数必须落库（只在内存计数 = 进程重启即失效 = 等于没有限频）→ 全局约束「限频落库」
//   - 幂等键唯一约束必须在数据库层，不能靠「先查再插」→ 设计文档 §11.1
//   - 只增不改：重算走 revision + 1，旧 revision 保留供复盘 → 设计文档 §11.1
//   - 检测 ≠ 处罚：flagged_reviews 只记录「有疑问」→ 设计文档 §11.1
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { queryAuditLog, findLatestTransition } from '../src/db/repo/audit-log.js';
import { writeAuditLog } from '../src/audit/log.js';
import { createFlag, findOpenFlag, listFlagRows, resolveFlagRow } from '../src/db/repo/flags.js';
import { findIdempotency, insertIdempotency } from '../src/db/repo/idempotency.js';
import {
  countBucket, incrementBucket, slidingWindowCount, slidingWindowEvents, acquireLock,
} from '../src/db/repo/rate-limit.js';
import { insertAppeal, getAppeal, listAppealRows, updateAppeal } from '../src/db/repo/appeals.js';
import { insertSnapshot, getSnapshot, nextRevision, listComputationRows } from '../src/db/repo/computations.js';
import { withTransaction } from '../src/db/tx.js';
import { appError, AppError, badRequest, unauthenticated, forbidden, notFound, conflict, rateLimited } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4repo-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  seedRefs(db);
  return { db, close, dataDir };
}

/**
 * 造出被外键引用的行。
 * ⚠️ 规格原写法直接用 'u_admin' / 'st1' 写审计日志与计算快照，
 *    但 audit_log.actor_id REFERENCES users(id)、computation_snapshots.stage_id
 *    REFERENCES stages(id) —— **不建被引用的行就会 FOREIGN KEY constraint failed**。
 *    这不是测试写得随意，是规格自带缺陷：照抄必然红。
 */
function seedRefs(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000999','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1','第一届','上海','2026-10-01','2099-12-31','2026-10-20T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st1','ed_1','S1','调研赛段','initial','2026-10-01','2026-10-10','2026-10-11','initial','closed');
    INSERT INTO teams (id, edition_id, name, captain_id, tier, status, created_at)
    VALUES ('t1','ed_1','甲队','u_admin','D','active','2026-10-20T00:00:00.000Z'),
           ('t2','ed_1','乙队','u_admin','D','active','2026-10-20T00:00:00.000Z');
  `);
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
}

test('迁移 005 建出 P4 的四张表，且 P0 的 audit_log 仍在', () => {
  const { db, close, dataDir } = setup();
  const tables = tableNames(db);
  for (const t of ['flagged_reviews', 'idempotency_keys', 'rate_limit_events', 'appeals', 'audit_log']) {
    assert.ok(tables.includes(t), `缺表 ${t}`);
  }
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('writeAuditLog 把 action / entity / entity_id / detail_json 写进去', () => {
  const { db, close, dataDir } = setup();
  writeAuditLog(db, {
    actorId: 'u_admin',
    action: 'review_state.transition',
    entity: 'stage_result',
    entityId: 'st1',
    detail: { from: 'SUBMITTED', to: 'PENDING_REVIEW', reason: '待复核', at: '2026-10-20T00:00:00.000Z' },
    now: '2026-10-20T00:00:00.000Z',
  });
  const { rows, total } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(total, 1);
  assert.equal(rows[0].entity, 'stage_result');
  assert.equal(rows[0].entity_id, 'st1');
  assert.equal(rows[0].actor_id, 'u_admin');
  assert.equal(JSON.parse(rows[0].detail_json).to, 'PENDING_REVIEW');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('queryAuditLog 能按 entity + entityId 过滤，总数与行数一致', () => {
  const { db, close, dataDir } = setup();
  writeAuditLog(db, { action: 'a', entity: 'stage_result', entityId: 'st1', now: '2026-10-20T00:00:00.000Z' });
  writeAuditLog(db, { action: 'b', entity: 'stage_result', entityId: 'st1', now: '2026-10-20T00:00:01.000Z' });
  writeAuditLog(db, { action: 'a', entity: 'stage_result', entityId: 'st2', now: '2026-10-20T00:00:02.000Z' });
  const { rows, total } = queryAuditLog(db, { entity: 'stage_result', entityId: 'st1' });
  assert.equal(total, 2);
  assert.equal(rows.length, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('findLatestTransition 返回最后一次迁移的 to_state', () => {
  const { db, close, dataDir } = setup();
  writeAuditLog(db, {
    action: 'review_state.transition', entity: 'stage_result', entityId: 'st1',
    detail: { from: 'SUBMITTED', to: 'PENDING_REVIEW' }, now: '2026-10-20T00:00:00.000Z',
  });
  writeAuditLog(db, {
    action: 'review_state.transition', entity: 'stage_result', entityId: 'st1',
    detail: { from: 'PENDING_REVIEW', to: 'CONFIRMED' }, now: '2026-10-20T00:00:01.000Z',
  });
  const latest = findLatestTransition(db, 'stage_result', 'st1');
  assert.equal(latest.to, 'CONFIRMED');
  assert.equal(latest.from, 'PENDING_REVIEW');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等键：同一 (key, scope) 只能插入一次，第二次返回 false', () => {
  const { db, close, dataDir } = setup();
  const first = insertIdempotency(db, {
    key: 'req_abc', scope: 'review.submit', requestId: 'req_abc', response: { ok: 1 }, now: '2026-10-20T00:00:00.000Z',
  });
  const second = insertIdempotency(db, {
    key: 'req_abc', scope: 'review.submit', requestId: 'req_abc', response: { ok: 2 }, now: '2026-10-20T00:00:01.000Z',
  });
  assert.equal(first, true);
  assert.equal(second, false, '重复插入必须被拒绝（否则重复提交会生效两次）');
  const found = findIdempotency(db, { key: 'req_abc', scope: 'review.submit' });
  assert.equal(JSON.parse(found.response_json).ok, 1, '必须保留首次的响应');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ 幂等键的兜底只认「唯一约束」：其它约束错必须继续往上抛（不得被当成「重复请求」）', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 若用 `INSERT OR IGNORE`，NOT NULL 违规会被静默吞掉 → 返回 false（=「重复请求」）
  //    → 调用方以为写成功了，实际一条都没落库（P1 的 T-7 踩过同款坑）。
  assert.throws(
    () => insertIdempotency(db, { key: null, scope: 'review.submit', now: '2026-10-20T00:00:00.000Z' }),
    /NOT NULL/i,
    'NOT NULL 违规不得被当成「重复请求」',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('限频计数落库：同一 bucket 递增，滑动窗口只数窗口内的', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 判别性数据集：**两个 bucket 必须落在窗口内外两侧**。
  //    规格原写法给两个 bucket 传了同一个 now（都在窗口外），
  //    那样「滑动窗口计数」与「全量计数」结果相同 → 测不出窗口过滤有没有生效。
  //    这里：s:100 在窗口内（count 2）、s:050 在窗口外（count 1）。
  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100', now: '2026-10-20T00:01:00.000Z' });
  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100', now: '2026-10-20T00:01:00.000Z' });
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100' }), 2);

  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:050', now: '2026-10-20T00:00:00.000Z' });
  // 窗口 60 秒：now=00:01:20 → 窗口 = [00:00:20, 00:01:20]
  //   → s:100（00:01:00 起，2 次）在窗口内；s:050（00:00:00 起，1 次）在窗口外
  const n = slidingWindowCount(db, {
    subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', now: '2026-10-20T00:01:20.000Z', windowSeconds: 60,
  });
  assert.equal(n, 2, '只有窗口内的 2 次算数（窗口外的 1 次必须被排除）');
  const events = slidingWindowEvents(db, {
    subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', now: '2026-10-20T00:01:20.000Z', windowSeconds: 60,
  });
  assert.equal(events.length, 1, '窗口外的事件不出现在事件列表里');
  assert.equal(events[0].bucket, 's:100');
  // 全量口径（不做窗口过滤）应当是 3 —— 与窗口口径 2 不同 ⇒ 数据集有判别力
  assert.equal(
    countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100' })
    + countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:050' }),
    3,
    '窗口内 2 + 窗口外 1 = 3（若实现不按窗口过滤，这里与上面的 2 无法区分）',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交锁：同一 subject 连续取锁第二次失败，锁过期后可再取', () => {
  const { db, close, dataDir } = setup();
  const a = acquireLock(db, { subjectKey: 'judge:u1', rule: 'lock:reviewSubmit', now: '2026-10-20T00:00:00.000Z', lockSeconds: 5 });
  assert.equal(a.acquired, true);
  const b = acquireLock(db, { subjectKey: 'judge:u1', rule: 'lock:reviewSubmit', now: '2026-10-20T00:00:01.000Z', lockSeconds: 5 });
  assert.equal(b.acquired, false);
  assert.ok(b.retryAfterSeconds >= 1);
  const c = acquireLock(db, { subjectKey: 'judge:u1', rule: 'lock:reviewSubmit', now: '2026-10-20T00:00:06.000Z', lockSeconds: 5 });
  assert.equal(c.acquired, true, '锁过期后必须能重新获取');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('flagged_reviews：可建、可按 kind+维度查未决、可裁决', () => {
  const { db, close, dataDir } = setup();
  const id = createFlag(db, {
    stageId: 'st1', teamId: 't1', judgeId: 'j1', kind: 'low_variance',
    detail: { judgeId: 'j1', dimension: 'innovation', stdev: 1.2 }, now: '2026-10-20T00:00:00.000Z',
  });
  const open = findOpenFlag(db, { kind: 'low_variance', stageId: 'st1', teamId: 't1', judgeId: 'j1' });
  assert.equal(open.id, id);
  assert.equal(open.status, 'open');
  assert.equal(resolveFlagRow(db, { id, status: 'confirmed', reviewedBy: 'u_admin', reviewedAt: '2026-10-20T01:00:00.000Z' }), 1);
  // ⚠️ 判别性数据集：库里同时存在**一条未决**与**一条已裁决**的 flag。
  //    只放一条的话，「按 status 过滤」与「不过滤」结果相同 ⇒ 测不出过滤有没有生效。
  const otherId = createFlag(db, {
    stageId: 'st1', teamId: 't2', judgeId: 'j2', kind: 'low_variance',
    detail: { judgeId: 'j2', dimension: 'innovation', stdev: 0.4 }, now: '2026-10-20T02:00:00.000Z',
  });
  const { rows } = listFlagRows(db, { status: 'confirmed' });
  assert.equal(rows.length, 1, '按 status 过滤后只剩已裁决的那一条');
  assert.equal(rows[0].reviewed_by, 'u_admin');
  assert.equal(rows[0].id, id);
  // 已裁决的 flag 不得再被「未决查询」找到（否则同一个问题会被重复送审）
  const stillOpen = findOpenFlag(db, { kind: 'low_variance', stageId: 'st1', teamId: 't1', judgeId: 'j1' });
  assert.equal(stillOpen, null, '已裁决的 flag 不再是 open');
  const otherOpen = findOpenFlag(db, { kind: 'low_variance', stageId: 'st1', teamId: 't2', judgeId: 'j2' });
  assert.equal(otherOpen?.id, otherId, '未裁决的那一条仍应能被查到');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('appeals：建档 → 查 → 裁决', () => {
  const { db, close, dataDir } = setup();
  const id = insertAppeal(db, {
    subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T00:00:00.000Z',
  });
  const row = getAppeal(db, id);
  assert.equal(row.status, 'submitted');
  assert.equal(row.subject_id, 'st1:t1');
  updateAppeal(db, { id, status: 'accepted', decidedBy: 'u_admin', decidedAt: '2026-10-20T02:00:00.000Z', decisionNote: '成立，重算' });
  const after = getAppeal(db, id);
  assert.equal(after.status, 'accepted');
  assert.equal(after.decision_note, '成立，重算');
  assert.equal(listAppealRows(db, { status: 'accepted' }).rows.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computation_snapshots：revision 递增，旧 revision 保留（不覆盖历史）', () => {
  const { db, close, dataDir } = setup();
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 1);
  insertSnapshot(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 1 }, output: { total: 80 }, trace: {}, revision: 1, now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 2);
  insertSnapshot(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 2 }, output: { total: 81 }, trace: {}, revision: 2, now: '2026-10-20T01:00:00.000Z',
  });
  assert.equal(getSnapshot(db, 'c1').revision, 1, '旧 revision 必须保留供复盘');
  assert.equal(getSnapshot(db, 'c2').revision, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ nextRevision 传 teamId 时按队伍收窄，不传时行为与 P2 一致（不得重定义 P2 的函数）', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 判别性数据集：两支队的 revision **必须不对称**。
  //    若两队都是 1，则「按队伍收窄」与「赛段级」算出的下一轮都是 2 ⇒ 测不出差异。
  insertSnapshot(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', teamId: 't1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 3, now: '2026-10-20T00:00:00.000Z',
  });
  insertSnapshot(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', teamId: 't2', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 1, now: '2026-10-20T00:00:01.000Z',
  });
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1', teamId: 't1' }), 4, 't1 自己的下一轮是 4');
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1', teamId: 't2' }), 2, 't2 自己的下一轮是 2（不受 t1 影响）');
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 4, '不传 teamId → 赛段级口径（P2 原样）');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ listComputationRows：按 kind/stageId 过滤 + 最近优先 + 带总数', () => {
  const { db, close, dataDir } = setup();
  insertSnapshot(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 1, now: '2026-10-20T00:00:00.000Z',
  });
  insertSnapshot(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 2, now: '2026-10-20T01:00:00.000Z',
  });
  insertSnapshot(db, {
    id: 'c3', kind: 'recompute', stageId: 'st1', ruleVersion: 'v1',
    input: {}, output: {}, trace: {}, revision: 1, now: '2026-10-20T02:00:00.000Z',
  });
  const all = listComputationRows(db, {});
  assert.equal(all.total, 3);
  assert.equal(all.rows.length, 3);
  assert.deepEqual(all.rows.map((r) => r.id), ['c3', 'c2', 'c1'], '必须最近优先（倒序）');
  const byKind = listComputationRows(db, { kind: 'stage_score' });
  assert.equal(byKind.total, 2, '按 kind 过滤');
  const byStage = listComputationRows(db, { stageId: 'st1' });
  assert.equal(byStage.total, 3);
  const paged = listComputationRows(db, { limit: 1 });
  assert.equal(paged.total, 3, '总数不受 limit 影响');
  assert.equal(paged.rows.length, 1, '但行数受 limit 限制');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('★ 错误快捷函数的状态码必须逐个正确（notFound=404 / badRequest=400 / conflict=409 / rateLimited=429 …）', () => {
  assert.equal(notFound('没有').status, 404);
  assert.equal(notFound('没有').code, 'NOT_FOUND');
  assert.equal(badRequest('不合法').status, 400);
  assert.equal(forbidden('不许').status, 403);
  assert.equal(conflict('冲突').status, 409);
  assert.equal(rateLimited('太快').status, 429);
  assert.equal(unauthenticated().status, 401);
  assert.equal(unauthenticated().message, '未登录');
  // 快捷函数必须返回 AppError 实例（下游 e instanceof AppError 分支才有效）
  assert.ok(notFound('没有') instanceof AppError, '必须是 AppError 实例');
  assert.equal(notFound('没有', { id: 'x' }).detail.id, 'x', 'detail 必须透传');
});

test('★ 005 迁移的 NOT NULL / DEFAULT 符合契约（kind 与 status 必填，status 有默认值）', () => {
  const { db, close, dataDir } = setup();
  const cols = (table) => Object.fromEntries(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name, c]),
  );
  const flags = cols('flagged_reviews');
  assert.equal(flags.kind.notnull, 1, 'flagged_reviews.kind 必须 NOT NULL');
  assert.equal(flags.status.notnull, 1, 'flagged_reviews.status 必须 NOT NULL');
  assert.equal(flags.status.dflt_value, "'open'", "flagged_reviews.status 默认 'open'");
  assert.equal(flags.detail_json.notnull, 0, 'detail_json 可空');

  const appeals = cols('appeals');
  assert.equal(appeals.status.notnull, 1, 'appeals.status 必须 NOT NULL');
  assert.equal(appeals.status.dflt_value, "'submitted'", "appeals.status 默认 'submitted'");
  assert.equal(appeals.reason.notnull, 1, 'appeals.reason 必须 NOT NULL');

  const idem = cols('idempotency_keys');
  assert.equal(idem.key.notnull, 1, 'idempotency_keys.key 必须 NOT NULL');
  assert.equal(idem.scope.notnull, 1, 'idempotency_keys.scope 必须 NOT NULL');

  const rl = cols('rate_limit_events');
  assert.equal(rl.count.notnull, 1, 'rate_limit_events.count 必须 NOT NULL');
  assert.equal(rl.count.dflt_value, '0', 'rate_limit_events.count 默认 0');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('withTransaction 抛错时整体回滚，不留半写', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => withTransaction(db, () => {
      writeAuditLog(db, { action: 'x', entity: 'e', entityId: '1', now: '2026-10-20T00:00:00.000Z' });
      throw appError(500, 'BOOM', '中途失败');
    }),
    // ⚠️ 规格原写法断言 /BOOM/（匹配 message），但 AppError 的 message 是「中途失败」、
    //    code 才是 'BOOM' ⇒ 照抄必然红。改为按 **code** 断言。
    (err) => err.code === 'BOOM' && err.status === 500,
  );
  const { total } = queryAuditLog(db, { action: 'x' });
  assert.equal(total, 0, '失败事务里的写入必须全部回滚');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('appError 带上 status / code / detail', () => {
  const err = appError(429, 'RATE_LIMITED', '太频繁', { retryAfterSeconds: 7 });
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.detail.retryAfterSeconds, 7);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/audit-repo.test.js`
Expected: FAIL —— `Cannot find module '../src/db/repo/audit-log.js'`

- [ ] **Step 3: 创建迁移 `db/migrations/005_audit.sql`**

```sql
-- 005_audit.sql — 审计与防作弊
-- 依据：INTERFACES.md §5（P4 产出）+ 设计文档 §11 / §12
-- ⚠️ 表名与列名逐字对齐 INTERFACES.md，不得擅自增删列。
-- ⛔ 评分/签字类记录只增不改；删除一律软删除（设计文档 §5.2 追加式决策）。

-- 检测器产出的人工复核项。⛔ 检测 ≠ 处罚：这里只记录"有疑问"，不记任何处罚结果。
CREATE TABLE flagged_reviews (
  id            TEXT PRIMARY KEY,
  stage_id      TEXT,
  submission_id TEXT,
  team_id       TEXT,
  judge_id      TEXT,
  kind          TEXT NOT NULL,   -- self_vs_judge | burst_submit | identical_peer_pattern | low_variance | multi_account | tied_mutual_peer_rate | reverse_audit
  detail_json   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | confirmed | rejected
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_flags_stage ON flagged_reviews(stage_id);
CREATE INDEX idx_flags_status ON flagged_reviews(status);
CREATE INDEX idx_flags_kind ON flagged_reviews(kind);

-- 幂等键：同一 request_id 重复提交只生效一次，重复请求返回首次的响应。
CREATE TABLE idempotency_keys (
  key           TEXT NOT NULL,
  scope         TEXT NOT NULL,
  request_id    TEXT,
  response_json TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (key, scope)
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);

-- 限频计数落库。⛔ 只在内存计数 = 进程重启即失效 = 等于没有限频。
-- bucket 的含义随 rule 变：s:<epoch秒> 滑动窗口 / m:<epoch分> 每分钟配额 /
-- h:<epoch时> 评委级每小时配额 / lock 提交锁。
CREATE TABLE rate_limit_events (
  id           TEXT PRIMARY KEY,
  subject_key  TEXT NOT NULL,
  rule         TEXT NOT NULL,
  bucket       TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (subject_key, rule, bucket)
);
CREATE INDEX idx_rl_lookup ON rate_limit_events(subject_key, rule, window_start);

-- 申诉：企业/选手对已定稿条目提出，走复核状态机。
CREATE TABLE appeals (
  id            TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL,   -- team_result
  subject_id    TEXT NOT NULL,   -- <stageId>:<teamId>
  filed_by      TEXT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted',  -- submitted | reviewing | accepted | rejected | withdrawn
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_appeals_subject ON appeals(subject_type, subject_id);
CREATE INDEX idx_appeals_status ON appeals(status);
```

- [ ] **Step 4: 追加 `src/errors.js` 的快捷函数，与创建 `src/db/tx.js`**

`platform/src/errors.js`：

```javascript
// ── P4 追加：快捷构造函数 ─────────────────────────────────────────────
// 依据：跨阶段接口契约 §0「错误：抛 AppError（status + code + message + detail，status-first）」
//
// ⚠️ 本文件由 **P0 的 Task 4 建立**（`export class AppError extends Error`，
//    构造签名 `AppError(status, code, message, detail)`），P4 **只追加快捷函数**。
//    ⛔ 不要在这里重写 AppError 类，也不要**重新定义 appError**：
//       P3 的 12 处 `new AppError(...)` 调用按 **status-first** 顺序写死，
//       重写成别的签名会让 err.status / err.code 互换；
//       而 `appError` 若被重新定义成「返回普通 Error 而非 AppError 实例」，
//       就破坏了 P0-8「全部领域错误都经 AppError 抛出」这条验收标准
//       （下游 `e instanceof AppError` 分支会失效）。

export function badRequest(message, detail) {
  return appError(400, 'INVALID_REQUEST', message, detail);
}

export function unauthenticated(message = '未登录') {
  return appError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message, detail) {
  return appError(403, 'FORBIDDEN', message, detail);
}

export function notFound(message, detail) {
  return appError(404, 'NOT_FOUND', message, detail);
}

export function conflict(message, detail) {
  return appError(409, 'CONFLICT', message, detail);
}

export function rateLimited(message, detail) {
  return appError(429, 'RATE_LIMITED', message, detail);
}

```

`platform/src/db/tx.js`：

```javascript
// src/db/tx.js — 事务助手
// 依据：设计文档 §11「数据库写入失败 → 事务回滚，无部分写入」
// 用 SAVEPOINT 而不是 BEGIN/COMMIT：SAVEPOINT 可嵌套，调用方自己开了事务时不会炸。
import { randomUUID } from 'node:crypto';

export function withTransaction(db, fn) {
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // 回滚本身失败：保留原始错误，不掩盖真正的失败原因
    }
    throw err;
  }
}
```

- [ ] **Step 5: 追加 `src/db/repo/audit-log.js` 的查询能力，并创建 5 个仓储文件**

`platform/src/audit/log.js` 由 **P2 的 Task 4 建立**（含 `writeAuditLog` / `listAuditLog`）。
**本阶段一个字都不改它** —— P2 版的 `writeAuditLog` 已经满足本阶段的三条要求：
① **不含 SQL**（SQL 在 `src/db/repo/audit-log.js`，满足全局约束「SQL 边界」）；
② **签名已经是** `(db, { actorId, action, entity, entityId, detail, now })` —— 本阶段要的
`writeAuditLog(db, { actorId, action, entity, entityId, detail, now })` **一字不差**；
③ 已有 `!action` 守卫（没有 action 的日志无法检索）。

⚠️ **不要再建第二个写入口**（原写法是在 `src/audit/log.js` 里 `import { insertAuditLog }`
再包一层 `writeAuditLog`）—— 那会让同一张 `audit_log` 出现**两条写路径**，
「审计日志唯一入口」失守。本阶段**直接复用 P2 的 `writeAuditLog`**。

`platform/src/db/repo/audit-log.js`（**P2 Task 4 已建**；本阶段**只追加**下面两个函数，
P2 已有的 `insertAuditLogRow` / `queryAuditLogRows` 保持不动、签名一个字都不改）：

```javascript
// ── P4 追加：带过滤条件的分页查询 + 取最后一次状态迁移 ────────────────
// 依据：设计文档 §12（可复算）+ §11.2（迁移日志）；表由 P0 的 001_init.sql 建好。
// ⚠️ P2 已建 insertAuditLogRow / queryAuditLogRows（写入 + 按 entity 列表）。
//    本阶段只补两个**只读查询**：带过滤条件的分页查询 + 取最后一次状态迁移。
export function queryAuditLog(db, {
  action = null, entity = null, entityId = null, since = null, until = null,
  limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (until) { where.push('created_at <= ?'); params.push(until); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

// 复核状态机的当前态：从最后一条迁移日志里取 to_state。
// 依据：设计文档 §11.2「每次状态迁移写 audit_log(...)」——状态机的真值来源就是迁移日志。
export function findLatestTransition(db, entity, entityId) {
  const rows = db.prepare(
    `SELECT detail_json, created_at FROM audit_log
      WHERE entity = ? AND entity_id = ? AND action = 'review_state.transition'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).all(entity, entityId);
  if (!rows.length) return null;
  let detail = {};
  try {
    detail = rows[0].detail_json ? JSON.parse(rows[0].detail_json) : {};
  } catch {
    detail = {};
  }
  return { ...detail, at: rows[0].created_at };
}

```

> **【2026-10-21 漂移审计修正 I-8（与 C-3 联动）】**
> **原来错在哪**：P4 的 Files 清单写着 `Create: platform/src/db/repo/audit-log.js`
> **并且**在 Step 5 里**重建**一份 `insertAuditLog`（含自己的 `randomUUID` + `INSERT INTO audit_log`），
> 同时把 `src/audit/log.js` 改写成 `import { insertAuditLog }` 再包一层 `writeAuditLog`。
> 而 P2 的 Task 4 **已经建过** `src/audit/log.js`（当时是内联 SQL 的版本，C-3 修正后改为门面 + 仓储）。
> 结果：同一张 `audit_log` 出现**两条写路径**（P2 的 `writeAuditLog` → P2 的仓储
> vs P4 的 `writeAuditLog` → P4 的仓储），「审计日志唯一入口」失守；
> 且 P4 的 `Create` 声明会让实施者**整体覆盖** P2 的仓储文件，把 P2 的
> `insertAuditLogRow` / `queryAuditLogRows` 抹掉 → P2 的调用点直接崩。
> **为什么错**：审计报告 I-8 明确要求「选一条路：SQL 全部下沉 `src/db/repo/audit-log.js`，
> `src/audit/log.js` 只保留薄服务门面并 `import` 仓储；P4 复用 P2 的 `writeAuditLog`
> 而不是再定义 `insertAuditLog`」。
> **改成什么**：
> ① Files 清单：`Create: src/db/repo/audit-log.js` → **`Modify`**（P2 Task 4 已建，
> 本阶段只**追加** `queryAuditLog` / `findLatestTransition`，不改 P2 已有的两个函数）；
> ② Files 清单：`Modify: src/audit/log.js` → **`Reuse`**（本阶段**一行不改**，
> P2 版的 `writeAuditLog` 签名**已经**是 `(db, { actorId, action, entity, entityId, detail, now })`，
> 与本阶段要的**一字不差**）；
> ③ Step 5 的 `src/audit/log.js` 改造块**整段删除**，改为「本阶段一个字都不改它」的说明；
> ④ `src/db/repo/audit-log.js` 的代码块只保留 `queryAuditLog` / `findLatestTransition`
> 两个**只读查询**（`insertAuditLog` **不再重复定义**）。
> **依据**：漂移审计报告 I-8 与 C-3 + P2 计划 Task 4 的修正后版本
> （`src/db/repo/audit-log.js` 导出 `insertAuditLogRow` / `queryAuditLogRows`，
> `src/audit/log.js` 是薄门面）。

`platform/src/db/repo/computations.js`（**P2 Task 6 已建**；本阶段**只改** `nextRevision`（加可选 `teamId`）
与 `insertSnapshot`（加可选 `id`）**+ 追加** `listComputationRows`，
**不要重建文件、不要重定义已有函数**）：

> ⚠️ **本文件由 P2 建立**（nextRevision / insertSnapshot / getSnapshot /
> getSnapshotInStage / listSnapshots / resetStageResults / upsertStageResult）。
> P4 **只改下面这两个已有函数 + 追加一个**，其余一个字都不动。
>
> ⛔ **绝不在本文件里再定义一个 nextRevision** —— 同名导出重复声明会让整个模块抛
> SyntaxError，`src/services/compute.js` 连带**整个平台**都加载不了。
> （P4 计划原写法是「重定义」⇒ 已实跑三种字面读法，**全部**让平台加载失败，见台账 P4-1。）

```javascript
export function nextRevision(db, { stageId, kind, teamId = null }) {
  // ⚠️ **P4 扩展**（本函数由 P2 建立）：P4 需要「同一赛段内按队伍各自编号」，
  //    所以加了一个**可选**的 teamId 收窄条件。
  //    ⛔ 不传 teamId 时**行为与 P2 一字不差**（P2 的调用点
  //       `nextRevision(db, { stageId, kind })` 不受影响）。
  //    ⛔ 绝不在本文件里**再定义一个 nextRevision** —— 同名导出重复声明会让整个
  //       模块抛 SyntaxError，`src/services/compute.js` 连带**整个平台**都加载不了。
  const where = ['stage_id = ?', 'kind = ?'];
  const params = [stageId, kind];
  if (teamId != null) { where.push('team_id = ?'); params.push(teamId); }
  const row = db
    .prepare(`SELECT MAX(revision) AS rev FROM computation_snapshots WHERE ${where.join(' AND ')}`)
    .get(...params);
  return (row?.rev ?? 0) + 1;
}

export function insertSnapshot(db, { kind, editionId = null, stageId = null, teamId = null, ruleVersion, input, output, trace, revision, now, id = randomUUID() }) {
  // ⚠️ **P4 扩展**：加了可选的 `id`（默认仍是随机 UUID）——
  //    P4 的审计留痕需要「自己指定 id 以便测试与外部引用」。
  //    不传 id 时行为与 P2 一字不差。
  db.prepare(
    `INSERT INTO computation_snapshots
       (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, editionId, stageId, teamId, ruleVersion, JSON.stringify(input), JSON.stringify(output), JSON.stringify(trace), revision, now);
  return id;
}

export function listComputationRows(db, { kind = null, stageId = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (stageId) { where.push('stage_id = ?'); params.push(stageId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM computation_snapshots ${clause}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM computation_snapshots ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

```

`platform/src/db/repo/flags.js`：

```javascript
// src/db/repo/flags.js — 人工复核项仓储
// 依据：设计文档 §11.1（串通识别 → 进人工复核队列）
//   ⛔ 检测 ≠ 处罚：这张表只记录"有疑问"，裁决由人工在复核队列里做。
import { randomUUID } from 'node:crypto';

export function createFlag(db, {
  id = randomUUID(), stageId = null, submissionId = null, teamId = null, judgeId = null,
  kind, detail = null, status = 'open', now = new Date().toISOString(),
}) {
  db.prepare(
    `INSERT INTO flagged_reviews
       (id, stage_id, submission_id, team_id, judge_id, kind, detail_json, status, reviewed_by, reviewed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    id, stageId, submissionId, teamId, judgeId, kind,
    detail === null ? null : JSON.stringify(detail), status, now,
  );
  return id;
}

export function findOpenFlag(db, { kind, stageId = null, teamId = null, judgeId = null }) {
  return db.prepare(
    `SELECT * FROM flagged_reviews
      WHERE kind = ? AND status = 'open'
        AND IFNULL(stage_id, '') = ? AND IFNULL(team_id, '') = ? AND IFNULL(judge_id, '') = ?`,
  ).get(kind, stageId ?? '', teamId ?? '', judgeId ?? '') ?? null;
}

export function listFlagRows(db, {
  status = null, kind = null, stageId = null, limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (stageId) { where.push('stage_id = ?'); params.push(stageId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM flagged_reviews ${clause}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM flagged_reviews ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

export function resolveFlagRow(db, {
  id, status, reviewedBy = null, reviewedAt = null, detail = null,
}) {
  return db.prepare(
    `UPDATE flagged_reviews
        SET status = ?, reviewed_by = ?, reviewed_at = ?, detail_json = COALESCE(?, detail_json)
      WHERE id = ?`,
  ).run(status, reviewedBy, reviewedAt, detail === null ? null : JSON.stringify(detail), id).changes;
}
```

`platform/src/db/repo/idempotency.js`：

```javascript
// src/db/repo/idempotency.js — 幂等键仓储
// 依据：设计文档 §11.1「重复提交 / 并发灌分 → 幂等键（request_id 唯一）」
//   ⛔ 唯一约束由数据库保证，不靠"先查再插"（设计文档 §6.3 同构风险的教训）。
import { randomUUID } from 'node:crypto';

export function findIdempotency(db, { key, scope }) {
  return db.prepare('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?').get(key, scope) ?? null;
}

export function insertIdempotency(db, {
  key, scope, requestId = null, response = null, now = new Date().toISOString(),
}) {
  try {
    db.prepare(
      `INSERT INTO idempotency_keys (key, scope, request_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(key, scope, requestId, response === null ? null : JSON.stringify(response), now);
    return true;
  } catch (err) {
    // ⚠️ 只认「唯一约束」这一种失败 —— 其他错误必须继续往上抛。
    //    ⛔ 不用 `INSERT OR IGNORE`：那会把**所有**约束冲突（含 NOT NULL 违规、
    //    磁盘写满）一并吞掉 → 调用方把「写失败」误判成「重复请求」，
    //    客户端以为提交成功了，实际一条都没落库。
    //    P1 的 T-7 踩过一次同样的坑（registrations 的兜底正则被收紧），
    //    P2 的 `claimRequestKey` 也是同款实现 —— 这里与全项目口径保持一致。
    if (/UNIQUE constraint failed: idempotency_keys/i.test(String(err.message))) return false;
    throw err;
  }
}
```

`platform/src/db/repo/rate-limit.js`：

```javascript
// src/db/repo/rate-limit.js — 限频计数仓储
// 依据：设计文档 §11.1「三层限频：滑动窗口计数 + 提交锁 + 每分钟配额；再加评委级配额」
//   借鉴 CTFd api/v1/challenges.py 的三层限频思路（Apache-2.0），只读思路独立实现。
//   ⛔ 计数必须落库：只在内存计数 = 进程重启即失效 = 等于没有限频。
import { randomUUID } from 'node:crypto';

export function countBucket(db, { subjectKey, rule, bucket }) {
  const row = db.prepare(
    'SELECT count FROM rate_limit_events WHERE subject_key = ? AND rule = ? AND bucket = ?',
  ).get(subjectKey, rule, bucket);
  return row?.count ?? 0;
}

export function incrementBucket(db, { subjectKey, rule, bucket, now = new Date().toISOString() }) {
  db.prepare(
    `INSERT INTO rate_limit_events (id, subject_key, rule, bucket, count, window_start, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(subject_key, rule, bucket)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
  ).run(randomUUID(), subjectKey, rule, bucket, now, now);
}

export function slidingWindowCount(db, { subjectKey, rule, now, windowSeconds }) {
  const from = new Date(Date.parse(now) - windowSeconds * 1000).toISOString();
  const row = db.prepare(
    `SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_events
      WHERE subject_key = ? AND rule = ? AND window_start >= ?`,
  ).get(subjectKey, rule, from);
  return row?.n ?? 0;
}

export function slidingWindowEvents(db, { subjectKey, rule, now, windowSeconds }) {
  const from = new Date(Date.parse(now) - windowSeconds * 1000).toISOString();
  return db.prepare(
    `SELECT bucket, count, window_start FROM rate_limit_events
      WHERE subject_key = ? AND rule = ? AND window_start >= ?
      ORDER BY window_start ASC`,
  ).all(subjectKey, rule, from);
}

// 提交锁：靠 (subject_key, rule, bucket) 的唯一约束 + CAS 改 window_start 实现。
// 锁过期后允许重新获取（window_start + lockSeconds <= now）。
export function acquireLock(db, { subjectKey, rule, now = new Date().toISOString(), lockSeconds = 5 }) {
  const nowMs = Date.parse(now);
  const row = db.prepare(
    'SELECT id, window_start FROM rate_limit_events WHERE subject_key = ? AND rule = ? AND bucket = ?',
  ).get(subjectKey, rule, 'lock');

  if (!row) {
    db.prepare(
      `INSERT INTO rate_limit_events (id, subject_key, rule, bucket, count, window_start, updated_at)
       VALUES (?, ?, ?, 'lock', 1, ?, ?)`,
    ).run(randomUUID(), subjectKey, rule, now, now);
    return { acquired: true, retryAfterSeconds: 0 };
  }

  const expiresAt = Date.parse(row.window_start) + lockSeconds * 1000;
  if (expiresAt > nowMs) {
    return { acquired: false, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - nowMs) / 1000)) };
  }

  // CAS：只有把 window_start 从旧值改成新值成功的那一方拿到锁
  const upd = db.prepare(
    'UPDATE rate_limit_events SET window_start = ?, updated_at = ?, count = count + 1 WHERE id = ? AND window_start = ?',
  ).run(now, now, row.id, row.window_start);
  if (upd.changes === 1) return { acquired: true, retryAfterSeconds: 0 };
  return { acquired: false, retryAfterSeconds: Math.max(1, lockSeconds) };
}
```

`platform/src/db/repo/appeals.js`：

```javascript
// src/db/repo/appeals.js — 申诉仓储
// 依据：设计文档 §11.2（申诉状态机 + 申诉范围）
import { randomUUID } from 'node:crypto';

export function insertAppeal(db, {
  id = randomUUID(), subjectType, subjectId, filedBy = null, reason,
  status = 'submitted', now = new Date().toISOString(),
}) {
  db.prepare(
    `INSERT INTO appeals (id, subject_type, subject_id, filed_by, reason, status, decided_by, decided_at, decision_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(id, subjectType, subjectId, filedBy, reason, status, now);
  return id;
}

export function getAppeal(db, id) {
  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) ?? null;
}

export function listAppealRows(db, {
  status = null, subjectType = null, subjectId = null, limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (subjectType) { where.push('subject_type = ?'); params.push(subjectType); }
  if (subjectId) { where.push('subject_id = ?'); params.push(subjectId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM appeals ${clause}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM appeals ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return { rows, total };
}

export function updateAppeal(db, { id, status, decidedBy = null, decidedAt = null, decisionNote = null }) {
  return db.prepare(
    'UPDATE appeals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?',
  ).run(status, decidedBy, decidedAt, decisionNote, id).changes;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/audit-repo.test.js`
Expected: PASS（12 个测试全过：audit-repo.test.js 12）

- [ ] **Step 7: 提交**

```bash
cd platform && git add db/migrations/005_audit.sql src/errors.js src/db src/audit src/db/repo test/audit-repo.test.js
git commit -m "feat(P4): 审计数据模型（005_audit.sql）、仓储层与错误/事务基础设施"
```

---

### Task 2: 计算快照与复算 diff

**Files:**
- Create: `platform/src/domain/diff.js`
- Create: `platform/src/services/audit.js`
- Test: `platform/test/audit-snapshot.test.js`

**Interfaces:**
- Consumes: **P2 的** `insertSnapshot` / `getSnapshot`（`computation_snapshots` 表的写入方与读取方 —— 规格写的 `insertComputation` / `getComputationRow` **不存在**，见偏差表 §G 第 1 行 / §H 第 1 行）+ **P4 Task 1 的** `nextRevision` / `writeAuditLog` / `queryAuditLog`；P2 的 `scoreStage`（`src/domain/scoring.js`）
- Produces:
  - `diffValues(before, after, opts?)` → `[{ path, before, after, note? }]`（纯函数，path 可定位到具体字段）
  - `recordComputation({ db, kind, editionId, stageId, teamId, ruleVersion, input, output, trace, actorId?, now? })` → `{ id, revision }`
  - `getComputation({ db, id, viewer })` → `{ id, kind, ruleVersion, input, output, trace, createdAt, revision, ... }`
  - `recomputeAndDiff({ db, id, actorId, now, rules?, liveInput?, engine? })` → `{ identical, diff, warnings }`
  - `listAuditLog({ db, filter, viewer, rules? })` → `{ rows, total, retention }`
- **跨阶段契约（P2 必须遵守）**：`computation_snapshots.input_json` 的规范结构是
  `{ configKey, ruleVersion, config, judges, submissions, enterpriseConfirmations, peerReviews }`。
  P2 的 `computeStage` 必须按这个结构写快照，否则 P4 的复算无法重放。`config` 是**权重表的完整拷贝**（不是引用），`ruleVersion` 形如 `scoring.final@2026-10-20`。

- [ ] **Step 1: 写失败的测试**

`platform/test/audit-snapshot.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { recordComputation, getComputation, recomputeAndDiff, listAuditLog } from '../src/services/audit.js';
import { diffValues } from '../src/domain/diff.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4snap-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  seedRefs(db);
  return { db, close, dataDir };
}

/**
 * 造出被外键引用的行。
 * ⚠️ 规格原写法直接用 'u_admin' 写审计日志，但 audit_log.actor_id REFERENCES users(id)
 *    —— 不建被引用的行就会 FOREIGN KEY constraint failed。这是规格自带缺陷。
 *
 * ⚠️ 规格还用了 stageId: 'st1'，而 computation_snapshots.stage_id REFERENCES stages(id)，
 *    stages.edition_id 又 REFERENCES editions(id) —— 外键链三级，全建。
 *    PRAGMA foreign_keys = ON（src/db/sqlite.js），这条链缺一环就必然炸。
 */
function seedRefs(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000998','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z'),
           ('u_judge','评委','13900000997','x','mba',NULL,0,1,'2026-10-20T00:00:00.000Z');
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('e1','2026 华东区','上海','2026-01-01T00:00:00.000Z','2026-12-31T00:00:00.000Z','2026-10-20T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, scoring_config_key, status)
    VALUES ('st1','e1','s1','初赛','initial','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z','scoring.final','open');
    INSERT INTO teams (id, edition_id, name, captain_id, created_at)
    VALUES ('tm1','e1','一队','u_admin','2026-10-20T00:00:00.000Z'),
           ('tm2','e1','二队','u_admin','2026-10-20T00:00:00.000Z');
  `);
}

// 注入用的确定性引擎：让 diff 机制的断言不依赖 P2 的内部实现细节。
function stubEngine(input) {
  return {
    teams: input.submissions.map((s) => ({ teamId: s.teamId, total: s.rawScore, seatP: s.rawScore, seatE: 0 })),
    warnings: [],
    trace: { steps: [] },
  };
}

// 判别性引擎：**真的用 config 参与计算**。
// ⛔ stubEngine 完全不看 config —— 于是「用当前规则复算」与「用快照规则复算」算出来的
//    结果一模一样，测不出当前规则到底有没有真的参与复算。期望值恰好相同 ⇒ 测不出差别。
function configSensitiveEngine(input) {
  const weight = input.config?.dimensions?.[0]?.weight ?? 0;
  return {
    teams: input.submissions.map((s) => ({
      teamId: s.teamId, total: s.rawScore * weight, seatP: s.rawScore * weight, seatE: 0,
    })),
    warnings: [],
    trace: { steps: [] },
  };
}

const BASE_INPUT = {
  configKey: 'scoring.final',
  ruleVersion: 'scoring.final@2026-10-20',
  config: { version: '2026-10-20', dimensions: [{ key: 'innovation', weight: 0.2 }] },
  judges: [{ id: 'j1' }],
  submissions: [
    { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 },
    { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 90 },
  ],
  enterpriseConfirmations: [],
  peerReviews: [],
};

const VIEWER = { id: 'u_admin', is_superadmin: 1, active: 1 };

test('recordComputation 写入三件套并返回 id + revision', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id, revision } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace, now: '2026-10-20T00:00:00.000Z',
  });
  assert.ok(id);
  assert.equal(revision, 1);
  const got = getComputation({ db, id, viewer: VIEWER });
  assert.equal(got.ruleVersion, 'scoring.final@2026-10-20');
  assert.deepEqual(got.input.submissions, BASE_INPUT.submissions);
  assert.equal(got.output.teams[0].total, 80);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('缺少规则版本时 recordComputation 直接报错（缺版本 = 不可复算）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => recordComputation({ db, kind: 'stage_score', input: BASE_INPUT, output: {}, trace: {} }),
    /ruleVersion/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('getComputation 对无权访问者抛 404（单条不满足 → 404，不泄露存在性）', () => {
  const { db, close, dataDir } = setup();
  const { id } = recordComputation({
    db, kind: 'stage_score', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {},
  });
  const viewer = { id: 'u_judge', is_superadmin: 0, active: 1 };
  assert.throws(() => getComputation({ db, id, viewer }), (e) => e.status === 404);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('diffValues 能定位到具体 path（数组用 teamId 而不是下标）', () => {
  const before = { teams: [{ teamId: 't1', total: 80 }, { teamId: 't2', total: 90 }] };
  const after = { teams: [{ teamId: 't1', total: 81 }, { teamId: 't2', total: 90 }] };
  const diff = diffValues(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'teams[t1].total');
  assert.equal(diff[0].before, 80);
  assert.equal(diff[0].after, 81);
});

test('diffValues 对浮点噪声用 epsilon 忽略，对真实差异不放过', () => {
  assert.equal(diffValues({ x: 0.1 + 0.2 }, { x: 0.3 }).length, 0);
  assert.equal(diffValues({ x: 1 }, { x: 1.0001 }).length, 1);
});

test('复算一致时 identical=true 且 diff 为空', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  const r = recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', engine: stubEngine });
  assert.equal(r.identical, true);
  assert.deepEqual(r.diff, []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('快照被改动后复算必须报错出具体 diff，而不是静默通过', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  // 模拟"事后篡改"：把快照里的总分改掉
  db.prepare('UPDATE computation_snapshots SET output_json = ? WHERE id = ?')
    .run(JSON.stringify({ teams: [{ teamId: 't1', total: 999 }, { teamId: 't2', total: 90 }] }), id);

  const r = recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', engine: stubEngine });
  assert.equal(r.identical, false);
  const paths = r.diff.map((d) => d.path);
  assert.ok(paths.includes('teams[t1].total'), `diff 必须能定位到具体 path，实际：${JSON.stringify(paths)}`);
  assert.ok(r.warnings.some((w) => w.code === 'strict_replay_failed'), '必须显式说明"当时的计算已不可复算"');
  assert.ok(r.warnings.some((w) => w.code === 'output_mismatch'), '同一规则版本下不一致也必须显式告警');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('规则版本变更时不得静默当作 identical，必须在 warnings 里说明', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: BASE_INPUT, output, trace: output.trace,
  });
  // 当前规则版本已变（权重也变了）
  const rules = { scoring: { final: { version: '2026-10-21', dimensions: [{ key: 'innovation', weight: 0.3 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: stubEngine,
  });
  assert.equal(r.identical, false, '规则版本已变更时不能报 identical=true');
  const w = r.warnings.find((x) => x.code === 'rule_version_changed');
  assert.ok(w, 'warnings 必须显式说明规则版本已变更');
  assert.equal(w.snapshotRuleVersion, 'scoring.final@2026-10-20');
  assert.equal(w.currentRuleVersion, 'scoring.final@2026-10-21');
  assert.ok(r.diff.some((d) => d.path === 'ruleVersion'), '规则版本差异本身也必须出现在 diff 里');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('复算本身会写审计日志（复算不是一次性的查询，是一次留痕的动作）', () => {
  const { db, close, dataDir } = setup();
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {},
  });
  recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', engine: stubEngine });
  const { rows } = queryAuditLog(db, { action: 'computation.recompute' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, id);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAuditLog 无权访问时返回空集（列表不满足 → 200 + 空集）', () => {
  const { db, close, dataDir } = setup();
  writeAuditLogForTest(db);
  const r = listAuditLog({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listAuditLog 有权时返回行，并带上 6 个月留档窗口', () => {
  const { db, close, dataDir } = setup();
  writeAuditLogForTest(db);
  const rules = { audit: { retention: { archiveMonths: 6 } } };
  const r = listAuditLog({ db, filter: {}, viewer: VIEWER, rules, now: '2026-10-20T00:00:00.000Z' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].action, 'x');
  assert.equal(r.retention.archiveMonths, 6);
  assert.equal(r.retention.queryableSince, '2026-04-20T00:00:00.000Z');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 父代理预审补测（变异检验暴露的三处「有效缺口」）────────────────────────
// ① 对象分支只取 before 的键 → after 新增的键会被静默吞掉
test('diffValues 能报出 after 里新增的键（否则新增的一条会被静默吞掉）', () => {
  const before = { teams: [{ teamId: 't1', total: 80 }] };
  const after = { teams: [{ teamId: 't1', total: 80 }], extra: 'added' };
  const diff = diffValues(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'extra');
  assert.equal(diff[0].before, null);
  assert.equal(diff[0].after, 'added');
});

// ② recordComputation 的 kind / input 校验没有任何用例 → 校验可被无声删掉
test('recordComputation 缺 kind / 缺 input 都必须报错（缺任何一件套 = 不可复算）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => recordComputation({ db, kind: '', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: {}, trace: {} }),
    /kind/,
  );
  assert.throws(
    () => recordComputation({ db, kind: 'stage_score', ruleVersion: BASE_INPUT.ruleVersion, output: {}, trace: {} }),
    /input/,
  );
  assert.throws(
    () => recordComputation({ db, kind: 'stage_score', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, trace: {} }),
    /output/,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ③ 服务层没把 teamId 透传给 nextRevision → 同赛段不同队伍的 revision 互相污染
test('recordComputation 传 teamId 时 revision 按队伍各自编号（不同队伍互不干扰）', () => {
  const { db, close, dataDir } = setup();
  const a1 = recordComputation({ db, kind: 'stage_score', stageId: 'st1', teamId: 'tm1', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {} });
  const a2 = recordComputation({ db, kind: 'stage_score', stageId: 'st1', teamId: 'tm1', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {} });
  const b1 = recordComputation({ db, kind: 'stage_score', stageId: 'st1', teamId: 'tm2', ruleVersion: BASE_INPUT.ruleVersion, input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {} });
  assert.equal(a1.revision, 1);
  assert.equal(a2.revision, 2);
  assert.equal(b1.revision, 1, '不同队伍的 revision 必须各编各的');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑥ 两侧同为 null = 没有变化，不得产生假差异（否则会把"没变"误报成"被改过"）
test('diffValues 对两侧同为 null 的字段不产生假差异（null = 没有值，不是变化）', () => {
  assert.equal(diffValues({ x: null }, { x: null }).length, 0);
});

// ⑦ live 模式：用当前库里的数据重建输入（不传 liveInput 就只重放快照，两条路都得通）
test('复算可走 live 模式：用当前数据重建输入，差异必须显式报出', () => {
  const { db, close, dataDir } = setup();
  const output = stubEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  const liveInput = {
    ...BASE_INPUT,
    submissions: [
      { judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 70 },
      { judgeId: 'j1', teamId: 't2', dimension: 'innovation', rawScore: 90 },
    ],
  };
  const r = recomputeAndDiff({ db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', liveInput, engine: stubEngine });
  assert.equal(r.identical, false);
  assert.ok(
    r.diff.some((d) => d.path === 'teams[t1].total'),
    `live 模式必须报出当前数据算出的差异，实际：${JSON.stringify(r.diff.map((d) => d.path))}`,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑧ 当前规则必须真的参与复算（规则改了权重，复算出来的总分必须跟着变）
test('当前规则必须真的参与复算（权重变了总分必须跟着变，不能仍用快照里的旧规则）', () => {
  const { db, close, dataDir } = setup();
  const output = configSensitiveEngine(BASE_INPUT);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output, trace: output.trace,
  });
  const rules = { scoring: { final: { version: '2026-10-21', dimensions: [{ key: 'innovation', weight: 0.5 }] } } };
  const r = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules, engine: configSensitiveEngine,
  });
  assert.equal(r.identical, false, '权重变了却报 identical=true = 当前规则没参与复算');
  assert.ok(
    r.diff.some((d) => d.path === 'teams[t1].total'),
    `权重变了，总分必须跟着变，实际 diff：${JSON.stringify(r.diff.map((d) => d.path))}`,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑨ 没有留档规则时 retention 必须是 null（不凭空猜一个窗口出来）
test('没有留档规则时 retention 为 null（不凭空猜一个留档窗口出来）', () => {
  const { db, close, dataDir } = setup();
  const r = listAuditLog({ db, filter: {}, viewer: VIEWER, now: '2026-10-20T00:00:00.000Z' });
  assert.equal(r.retention, null);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ⑩ 记录计算时的审计日志必须带上规则版本（事后查得到当时用的是哪一版规则）
test('记录计算时审计日志必须带上规则版本（事后查得到当时用的是哪一版规则）', () => {
  const { db, close, dataDir } = setup();
  recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: BASE_INPUT.ruleVersion,
    input: BASE_INPUT, output: stubEngine(BASE_INPUT), trace: {},
  });
  const { rows } = queryAuditLog(db, { action: 'computation.record' });
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.ruleVersion, BASE_INPUT.ruleVersion, '审计日志里必须能查到当时的规则版本');
  assert.equal(detail.revision, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

function writeAuditLogForTest(db) {
  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run('a1', 'u_admin', 'x', 'stage_result', 'st1', null, '2026-10-01T00:00:00.000Z');
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/audit-snapshot.test.js`
Expected: FAIL —— `Cannot find module '../src/services/audit.js'`

- [ ] **Step 3: 创建 `src/domain/diff.js`**

```javascript
// src/domain/diff.js — 结构化差异比对（纯函数）
// 依据：R-AUD-01（每次发榜/计分可复算）
//   溯源：周报 2026-10-12~18 §4.2 教训 5「静默的空产出比报错更危险」
//   ⛔ 复算结果与快照不一致时，差异必须能被【看见】：每条差异带一个可定位的 path，
//      不能只写一条日志了事。
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

const EPSILON = 1e-9;

export function summarizeValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(v);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 数组元素优先用业务主键做 path（teams[t1].total 比 teams[0].total 可定位得多）
function arrayKey(item, index) {
  if (isPlainObject(item)) {
    const key = item.teamId ?? item.id ?? item.judgeId ?? item.key;
    if (key !== undefined && key !== null) return String(key);
  }
  return String(index);
}

export function diffValues(before, after, { path = '', depth = 0, maxDepth = 12 } = {}) {
  const out = [];
  walk(before, after, path, depth, maxDepth, out);
  return out;
}

function walk(before, after, path, depth, maxDepth, out) {
  if (depth > maxDepth) {
    out.push({
      path: path || '<root>',
      before: summarizeValue(before),
      after: summarizeValue(after),
      note: '超出最大比对深度，已截断',
    });
    return;
  }
  // 浮点用 epsilon 判等：避免 0.1+0.2 与 0.3 被报成差异
  if (typeof before === 'number' && typeof after === 'number') {
    if (Math.abs(before - after) <= EPSILON) return;
    out.push({ path, before, after });
    return;
  }
  if (Object.is(before, after)) return;

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      walk(before[k], after[k], path ? `${path}.${k}` : k, depth + 1, maxDepth, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i += 1) {
      const key = arrayKey(before[i] ?? after[i], i);
      walk(before[i], after[i], `${path}[${key}]`, depth + 1, maxDepth, out);
    }
    return;
  }

  out.push({ path, before: summarizeValue(before), after: summarizeValue(after) });
}
```

- [ ] **Step 4: 创建 `src/services/audit.js`**

```javascript
// src/services/audit.js — 计算快照、复算 diff、审计日志
// 依据：设计文档 §12（每次计算产出三件套）、§13（可复算）
//   R-AUD-01 每次发榜/计分可复算（周报 2026-10-12~18 §4.2 教训 6）
//   R-AUD-02 计算留输入快照（一页纸 §第 3 步 闸二 + 周报教训 5）
//   R-JDG-17 全程留档 6 个月（S7 §4.2）
// ⛔ 本阶段的核心纪律：空结果与降级必须显式暴露。
//    · 复算不一致 → diff 出现在返回值里（API 会把它带给前端），不是只写一条日志。
//    · 规则版本已变更 → warnings 里显式说明"无法严格复算"，不静默当作 identical=true。
import { scoreStage } from '../domain/scoring.js';
import { diffValues } from '../domain/diff.js';
import { insertSnapshot, getSnapshot, nextRevision } from '../db/repo/computations.js';
import { queryAuditLog } from '../db/repo/audit-log.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { notFound } from '../errors.js';

/**
 * 记录一次计算。写 computation_snapshots（input + output + trace + rule_version）+ 写审计日志。
 * @returns {{ id: string, revision: number }}
 */
export function recordComputation({
  db, kind, editionId = null, stageId = null, teamId = null,
  ruleVersion, input, output, trace, actorId = null, now = new Date().toISOString(),
}) {
  if (!kind) throw new Error('记录计算必须给 kind');
  if (!ruleVersion) throw new Error('记录计算必须给 ruleVersion（缺规则版本 = 不可复算）');
  if (!input || typeof input !== 'object') throw new Error('记录计算必须给 input（缺输入快照 = 不可复算）');
  if (!output || typeof output !== 'object') throw new Error('记录计算必须给 output');

  // revision + 1：重算不覆盖历史，旧 revision 保留供复盘（设计文档 §11.1 事后篡改防护）
  const revision = nextRevision(db, { kind, stageId, teamId });
  const id = insertSnapshot(db, {
    kind, editionId, stageId, teamId, ruleVersion, input, output, trace, revision, now,
  });
  writeAuditLog(db, {
    actorId,
    action: 'computation.record',
    entity: 'computation',
    entityId: id,
    detail: { kind, editionId, stageId, teamId, ruleVersion, revision },
    now,
  });
  return { id, revision };
}

/**
 * 读取一份计算快照。单条不满足 → 404（不泄露记录是否存在）。
 */
export function getComputation({ db, id, viewer = null }) {
  const row = getSnapshot(db, id);
  if (!row) throw notFound(`计算快照不存在: ${id}`);
  if (viewer && !can(viewer, 'audit:read', null, db)) throw notFound(`计算快照不存在: ${id}`);
  return {
    id: row.id,
    kind: row.kind,
    ruleVersion: row.rule_version,
    input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json),
    trace: JSON.parse(row.trace_json),
    createdAt: row.created_at,
    revision: row.revision,
    editionId: row.edition_id,
    stageId: row.stage_id,
    teamId: row.team_id,
  };
}

function pickConfig(rules, input) {
  // 快照里记了 configKey（如 'scoring.final'），据此取当前规则；取不到就退回快照自带的 config
  const key = input?.configKey;
  if (key && typeof key === 'string' && key.includes('.')) {
    const [group, name] = key.split('.');
    const cfg = rules?.[group]?.[name];
    if (cfg) return cfg;
  }
  return input?.config ?? null;
}

function runEngine(engine, input, config) {
  return engine({
    config,
    judges: input?.judges ?? [],
    submissions: input?.submissions ?? [],
    enterpriseConfirmations: input?.enterpriseConfirmations ?? [],
    peerReviews: input?.peerReviews ?? [],
  });
}

/**
 * 复算 + 比对。
 * @param {object} args
 * @param {object} [args.rules]   当前规则（loadRules 的结果）。给了才会做规则版本比对。
 * @param {object} [args.liveInput] 用当前库里的数据重建的输入（"live 模式"）。不给则用快照自带的 input。
 * @param {Function} [args.engine] 纯函数引擎，默认 P2 的 scoreStage。
 * @returns {{ identical: boolean, diff: Array, warnings: Array }}
 */
export function recomputeAndDiff({
  db, id, actorId = null, now = new Date().toISOString(),
  rules = null, liveInput = null, engine = scoreStage,
}) {
  const row = getSnapshot(db, id);
  if (!row) throw notFound(`计算快照不存在: ${id}`);

  const snapshotInput = JSON.parse(row.input_json);
  const snapshotOutput = JSON.parse(row.output_json);
  const snapshotRuleVersion = row.rule_version;

  const currentConfig = rules ? pickConfig(rules, snapshotInput) : null;
  const currentRuleVersion = currentConfig?.version
    ? `${snapshotInput?.configKey ?? 'unknown'}@${currentConfig.version}`
    : null;
  const ruleVersionChanged = currentRuleVersion !== null && currentRuleVersion !== snapshotRuleVersion;

  // ① 严格重放：用快照自带的规则版本重放 —— 回答"当时的计算本身可不可复算"
  const strictResult = runEngine(engine, snapshotInput, snapshotInput.config);
  const strictDiff = diffValues(snapshotOutput, strictResult.output ?? strictResult);

  // ② 当前规则复算：用当前规则跑同一批输入 —— 回答"现在这套规则还能不能算出同样的结果"
  const baseInput = liveInput ?? snapshotInput;
  const currentResult = currentConfig
    ? runEngine(engine, baseInput, currentConfig)
    : runEngine(engine, baseInput, snapshotInput.config);
  const currentOutput = currentResult.output ?? currentResult;

  const diff = [];
  if (ruleVersionChanged) {
    diff.push({ path: 'ruleVersion', before: snapshotRuleVersion, after: currentRuleVersion });
  }
  diff.push(...diffValues(snapshotOutput, currentOutput));

  const warnings = [];
  if (ruleVersionChanged) {
    warnings.push({
      code: 'rule_version_changed',
      severity: 'warning',
      message: `规则版本已变更（快照 ${snapshotRuleVersion} → 当前 ${currentRuleVersion}），无法严格复算；差异可能来自规则变更而非数据异常`,
      snapshotRuleVersion,
      currentRuleVersion,
    });
  }
  if (strictDiff.length === 0) {
    warnings.push({
      code: 'strict_replay_identical',
      severity: 'info',
      message: '用快照自带的规则版本重放，结果与快照一致 —— 当时的计算本身可复算',
    });
  } else {
    warnings.push({
      code: 'strict_replay_failed',
      severity: 'error',
      message: '用快照自带的规则版本重放，结果与快照不一致 —— 当时的计算已不可复算（快照或数据被改动过）',
      diff: strictDiff,
    });
  }
  if (!ruleVersionChanged && diff.length > 0) {
    warnings.push({
      code: 'output_mismatch',
      severity: 'error',
      message: '同一规则版本下复算结果与快照不一致 —— 快照或原始数据被改动过',
    });
  }
  for (const w of currentResult.warnings ?? []) {
    warnings.push({ severity: 'warning', ...w });
  }

  const identical = diff.length === 0;

  writeAuditLog(db, {
    actorId,
    action: 'computation.recompute',
    entity: 'computation',
    entityId: id,
    detail: {
      identical,
      diffCount: diff.length,
      warningCodes: warnings.map((w) => w.code),
      snapshotRuleVersion,
      currentRuleVersion,
      mode: liveInput ? 'live' : 'replay',
    },
    now,
  });

  return { identical, diff, warnings };
}

/**
 * 查审计日志。列表不满足 → 200 + 空集（不暴露"有但不给看"）。
 * retention 段给出"赛后 6 个月可查"的窗口（R-JDG-17 / S7 §4.2）。
 */
export function listAuditLog({ db, filter = {}, viewer = null, rules = null, now = new Date().toISOString() }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0, retention: null };

  const { rows, total } = queryAuditLog(db, filter);
  const archiveMonths = rules?.audit?.retention?.archiveMonths ?? null;
  const retention = archiveMonths === null
    ? null
    : { archiveMonths, queryableSince: monthsAgoIso(now, archiveMonths) };

  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
      createdAt: r.created_at,
    })),
    total,
    retention,
  };
}

// 精确的"N 个月前"（不是 30 天 × N）。取不到该日时退到当月最后一天。
function monthsAgoIso(nowIso, months) {
  const d = new Date(Date.parse(nowIso));
  if (!Number.isFinite(d.getTime())) return nowIso;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/audit-snapshot.test.js`
Expected: PASS（19 个测试全过：audit-snapshot.test.js 19 —— 规格自带 11 + 父代理预审补测 8，详见「Task 2 父代理预审修正台账」）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/domain/diff.js src/services/audit.js test/audit-snapshot.test.js
git commit -m "feat(P4): 计算快照、复算 diff 与规则版本变更告警（R-AUD-01/02）"
```

---

### Task 3: 限频三层 + 幂等键

**Files:**
- Create: `platform/src/services/rate-limit.js`
- Create: `platform/src/services/idempotency.js`
- Modify: `platform/rules/`（新增 `audit.json`）
- Modify: `platform/src/config.js`（加载并校验 `rules/audit.json`）
- Test: `platform/test/rate-limit.test.js`

**Interfaces:**
- Consumes: Task 1 的 `countBucket` / `incrementBucket` / `slidingWindowCount` / `slidingWindowEvents` / `acquireLock` / `findIdempotency` / `insertIdempotency`；Task 1 的 `withTransaction`
- Produces:
  - `checkRateLimit({ db, subjectKey, rule, now, limits, subjects? })` → `{ allowed, remaining, retryAfterSeconds, layers }`
  - `assertRateLimit(args)` → 同上；不通过抛 `AppError(429)`，`detail.retryAfterSeconds` 必填
  - `withIdempotency({ db, key, scope, requestId, now }, fn)` → `{ replayed, result, storedAt }`
  - 规则：`rules.audit.rateLimit.<profile>` = `{ lock?, sliding?, perMinute?, perHour? }`，每层可声明 `subject`（用哪个 subjectKey）

- [ ] **Step 1: 写失败的测试**

`platform/test/rate-limit.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { checkRateLimit, assertRateLimit } from '../src/services/rate-limit.js';
import { withIdempotency } from '../src/services/idempotency.js';
import { countBucket, incrementBucket } from '../src/db/repo/rate-limit.js';
import { insertIdempotency } from '../src/db/repo/idempotency.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const LIMITS = {
  // 带提交锁的 profile：同一 subject 在锁有效期内只允许一次
  appealSubmit: {
    lock: { seconds: 5 },
    sliding: { seconds: 60, max: 3 },
    perMinute: { max: 5 },
  },
  // 不带锁的 profile：单独验证滑动窗口与每分钟配额
  slidingOnly: {
    sliding: { seconds: 60, max: 3 },
    perMinute: { max: 5 },
  },
  judgeHourly: {
    perHour: { max: 4 },
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4rl-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

test('未配限频规则时直接报错（不静默用默认值放行）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => checkRateLimit({ db, subjectKey: 'u1', rule: 'notConfigured', now: '2026-10-20T00:00:00.000Z', limits: LIMITS }),
    (e) => e.status === 500 && /未配置/.test(e.message),
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动窗口：超出配额后 allowed=false 且给出 retryAfterSeconds', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    const r = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1, '必须告诉调用方等多久');
  assert.equal(blocked.remaining, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('限频计数必须落库：换一个 db 连接（模拟进程重启）仍然超限', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  }
  // 计数写在 rate_limit_events 表里，不是内存
  const bucket = `s:${Math.floor(Date.parse(now) / 1000)}`;
  const stored = countBucket(db, { subjectKey: 'appeal:u1', rule: 'sliding:slidingOnly', bucket });
  assert.equal(stored, 3, '计数必须落在 rate_limit_events 表');

  // 模拟进程重启：新开一个连接读同一个库
  const { db: db2, close: close2 } = openDatabase({ dataDir });
  const afterRestart = checkRateLimit({ db: db2, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(afterRestart.allowed, false, '进程重启不能让限频失效');
  close2();
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交锁：并发同 subject 的第二次请求被拒，且给出剩余秒数', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  const first = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'appealSubmit', now, limits: LIMITS });
  assert.equal(first.allowed, true);
  const second = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'appealSubmit', now: '2026-10-20T00:00:01.000Z', limits: LIMITS });
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterSeconds >= 1);
  assert.equal(second.layers.find((l) => l.layer === 'lock').allowed, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('每分钟配额：每分钟独立计数', () => {
  const { db, close, dataDir } = setup();
  const limits = { m: { perMinute: { max: 1 } } };
  const a = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:00:10.000Z', limits });
  const b = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:00:20.000Z', limits });
  const c = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:01:05.000Z', limits });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, false);
  assert.equal(c.allowed, true, '进入下一分钟后配额重置');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('评委级每小时配额：按 judge 维度单独计数', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 4; i += 1) {
    const r = checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  const other = checkRateLimit({ db, subjectKey: 'judge:u2', rule: 'judgeHourly', now, limits: LIMITS });
  assert.equal(other.allowed, true, '不同评委互不影响');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('assertRateLimit 超限抛 429 且 detail 带 retryAfterSeconds', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    assertRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  }
  assert.throws(
    () => assertRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS }),
    (e) => e.status === 429 && e.code === 'RATE_LIMITED' && e.detail.retryAfterSeconds >= 1,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：同一 request_id 重复提交只生效一次，且返回首次的响应', () => {
  const { db, close, dataDir } = setup();
  let calls = 0;
  const fn = () => { calls += 1; return { accepted: true, n: calls }; };

  const first = withIdempotency({ db, key: 'req_1', scope: 'appeal.submit', requestId: 'req_1' }, fn);
  const second = withIdempotency({ db, key: 'req_1', scope: 'appeal.submit', requestId: 'req_1' }, fn);

  assert.equal(calls, 1, '业务函数只能被调用一次');
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result, '重复请求必须返回【首次的响应】');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：不同 scope 的同一个 key 互不影响', () => {
  const { db, close, dataDir } = setup();
  let calls = 0;
  const fn = () => { calls += 1; return { n: calls }; };
  withIdempotency({ db, key: 'req_1', scope: 'appeal.submit' }, fn);
  withIdempotency({ db, key: 'req_1', scope: 'review.submit' }, fn);
  assert.equal(calls, 2);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：业务函数失败时不留下幂等记录（可以重试）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => withIdempotency({ db, key: 'req_x', scope: 'appeal.submit' }, () => { throw new Error('业务失败'); }),
    /业务失败/,
  );
  let calls = 0;
  const r = withIdempotency({ db, key: 'req_x', scope: 'appeal.submit' }, () => { calls += 1; return { ok: true }; });
  assert.equal(calls, 1, '失败后应该还能重试');
  assert.equal(r.replayed, false);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('限频：缺 subjectKey / rule 一律 400（不静默放行）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => checkRateLimit({ db, rule: 'slidingOnly', now: '2026-10-20T00:00:00.000Z', limits: LIMITS }),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => checkRateLimit({ db, subjectKey: 'u1', now: '2026-10-20T00:00:00.000Z', limits: LIMITS }),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('layers：每层都要报出 layer / count / max / allowed', () => {
  const { db, close, dataDir } = setup();
  const r = checkRateLimit({
    db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: '2026-10-20T00:00:00.000Z', limits: LIMITS,
  });
  const sliding = r.layers.find((l) => l.layer === 'sliding');
  assert.equal(sliding.count, 0);
  assert.equal(sliding.max, 3);
  assert.equal(sliding.allowed, true);
  assert.ok(r.layers.some((l) => l.layer === 'perMinute'), '每分钟配额也要单独成层');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('subjects：限频层可以指定用哪个 subject 维度计数', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  const limits = { judgeSubmit: { sliding: { seconds: 60, max: 2, subject: 'judge' } } };
  for (let i = 0; i < 2; i += 1) {
    const r = checkRateLimit({
      db, subjectKey: 'stage:s1', rule: 'judgeSubmit', now, limits, subjects: { judge: 'judge:u1' },
    });
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = checkRateLimit({
    db, subjectKey: 'stage:s1', rule: 'judgeSubmit', now, limits, subjects: { judge: 'judge:u1' },
  });
  assert.equal(blocked.allowed, false, '必须按 judge 维度计数，而不是按默认 subjectKey');

  const bucket = `s:${Math.floor(Date.parse(now) / 1000)}`;
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:judgeSubmit', bucket }), 2);
  assert.equal(
    countBucket(db, { subjectKey: 'stage:s1', rule: 'sliding:judgeSubmit', bucket }),
    0,
    '默认 subject 不得被计数',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动窗口：窗口滑出后配额自动恢复', () => {
  const { db, close, dataDir } = setup();
  const t0 = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: t0, limits: LIMITS }).allowed,
      true,
    );
  }
  assert.equal(
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: t0, limits: LIMITS }).allowed,
    false,
  );
  // 61 秒后：最早那次的记录已滑出 60 秒窗口 ⇒ 配额必须恢复
  const later = '2026-10-20T00:01:01.000Z';
  assert.equal(
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now: later, limits: LIMITS }).allowed,
    true,
    '窗口滑出后必须恢复放行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('提交锁：锁到期后可以再次获取', () => {
  const { db, close, dataDir } = setup();
  const limits = { lockOnly: { lock: { seconds: 5 } } };
  const t0 = '2026-10-20T00:00:00.000Z';
  assert.equal(checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'lockOnly', now: t0, limits }).allowed, true);
  const blocked = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'lockOnly', now: '2026-10-20T00:00:01.000Z', limits });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'lockOnly', now: '2026-10-20T00:00:06.000Z', limits }).allowed,
    true,
    '锁过期后必须重新放行',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('被拒绝的请求不消耗配额（只有放行的请求才计数）', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 3; i += 1) {
    checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  }
  const bucket = `s:${Math.floor(Date.parse(now) / 1000)}`;
  assert.equal(countBucket(db, { subjectKey: 'appeal:u1', rule: 'sliding:slidingOnly', bucket }), 3);
  const blocked = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  assert.equal(
    countBucket(db, { subjectKey: 'appeal:u1', rule: 'sliding:slidingOnly', bucket }),
    3,
    '被拒绝的请求不得消耗配额',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('remaining 随配额消耗递减（放行后还能再做几次）', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  const a = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(a.remaining, 2, '滑动窗口还剩 2 次（3 - 已用 1）');
  const b = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(b.remaining, 1);
  const c = checkRateLimit({ db, subjectKey: 'appeal:u1', rule: 'slidingOnly', now, limits: LIMITS });
  assert.equal(c.remaining, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('每分钟配额：超限给出本分钟剩余秒数，且计数落在 m:<epoch分> 桶', () => {
  const { db, close, dataDir } = setup();
  const limits = { m: { perMinute: { max: 1 } } };
  const now = '2026-10-20T00:00:10.000Z';
  assert.equal(checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now, limits }).allowed, true);
  const blocked = checkRateLimit({ db, subjectKey: 'x:1', rule: 'm', now: '2026-10-20T00:00:20.000Z', limits });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 40, '本分钟还剩 40 秒');
  const bucket = `m:${Math.floor(Date.parse(now) / 60_000)}`;
  assert.equal(countBucket(db, { subjectKey: 'x:1', rule: 'minute:m', bucket }), 1, '分钟桶必须按 epoch 分对齐');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('评委级每小时配额：超限给出本小时剩余秒数，且计数落在 h:<epoch时> 桶', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  for (let i = 0; i < 4; i += 1) {
    checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
  }
  const blocked = checkRateLimit({ db, subjectKey: 'judge:u1', rule: 'judgeHourly', now, limits: LIMITS });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 3600, '本小时还剩 3600 秒');
  const bucket = `h:${Math.floor(Date.parse(now) / 3_600_000)}`;
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'hour:judgeHourly', bucket }), 4, '小时桶必须按 epoch 时对齐');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('滑动窗口：retryAfterSeconds 指向最早那次滑出窗口的时刻', () => {
  const { db, close, dataDir } = setup();
  const limits = { s: { sliding: { seconds: 60, max: 2 } } };
  const t0 = '2026-10-20T00:00:00.000Z';
  checkRateLimit({ db, subjectKey: 'a:1', rule: 's', now: t0, limits });
  checkRateLimit({ db, subjectKey: 'a:1', rule: 's', now: '2026-10-20T00:00:30.000Z', limits });
  const blocked = checkRateLimit({ db, subjectKey: 'a:1', rule: 's', now: '2026-10-20T00:00:30.000Z', limits });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 30, '最早那次在 00:01:00 滑出窗口 ⇒ 还差 30 秒');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：缺 key / scope 一律 400', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => withIdempotency({ db, scope: 'appeal.submit' }, () => ({ ok: true })),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => withIdempotency({ db, key: 'req_1' }, () => ({ ok: true })),
    (e) => e.status === 400 && e.code === 'INVALID_REQUEST',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：业务失败时业务副作用一并回滚（不能留下「做了一半」的账）', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  assert.throws(
    () => withIdempotency({ db, key: 'req_roll', scope: 'appeal.submit', requestId: 'req_roll', now }, () => {
      incrementBucket(db, { subjectKey: 'appeal:u1', rule: 'side:effect', bucket: 'b1', now });
      throw new Error('业务失败');
    }),
    /业务失败/,
  );
  assert.equal(
    countBucket(db, { subjectKey: 'appeal:u1', rule: 'side:effect', bucket: 'b1' }),
    0,
    '业务副作用必须随幂等键一起回滚',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：并发下别人先写入了 → 以库里的首次响应为准', () => {
  const { db, close, dataDir } = setup();
  const now = '2026-10-20T00:00:00.000Z';
  let calls = 0;
  const fn = () => {
    calls += 1;
    // 模拟「另一个请求抢先写入了同一个幂等键」
    insertIdempotency(db, {
      key: 'req_c', scope: 'appeal.submit', requestId: 'req_c', response: { accepted: true, by: 'other' }, now,
    });
    return { accepted: true, by: 'self' };
  };
  const r = withIdempotency({ db, key: 'req_c', scope: 'appeal.submit', requestId: 'req_c', now }, fn);
  assert.equal(calls, 1);
  assert.equal(r.replayed, true, '键已被别人占用 ⇒ 必须按重放处理');
  assert.deepEqual(r.result, { accepted: true, by: 'other' }, '以库里的首次响应为准');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等：重放返回的 storedAt 是首次落库的时间', () => {
  const { db, close, dataDir } = setup();
  const t0 = '2026-10-20T00:00:00.000Z';
  const t1 = '2026-10-20T00:05:00.000Z';
  const first = withIdempotency({ db, key: 'req_t', scope: 'appeal.submit', requestId: 'req_t', now: t0 }, () => ({ ok: true }));
  const second = withIdempotency({ db, key: 'req_t', scope: 'appeal.submit', requestId: 'req_t', now: t1 }, () => ({ ok: true }));
  assert.equal(first.storedAt, t0);
  assert.equal(second.storedAt, t0, '重放必须返回首次落库时间');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/rate-limit.test.js`
Expected: FAIL —— `Cannot find module '../src/services/rate-limit.js'`

- [ ] **Step 3: 创建 `rules/audit.json` 并接入 `src/config.js`**

`platform/rules/audit.json`：

```json
{
  "id": "audit",
  "version": "2026-10-20",
  "source": "设计文档 §11/§12 + 一页纸 §第 3 步 闸二 + 周报 2026-10-12~18 §4.2 教训 5",
  "note": "所有阈值都是待组委会确认的机制件，必须配置化（溯源表结论：60 条机制件不得硬编码）",
  "rateLimit": {
    "appealSubmit": {
      "lock": { "seconds": 5, "subject": "default" },
      "sliding": { "seconds": 60, "max": 3, "subject": "default" },
      "perMinute": { "max": 5, "subject": "default" }
    },
    "reviewSubmit": {
      "lock": { "seconds": 5, "subject": "default" },
      "sliding": { "seconds": 60, "max": 20, "subject": "default" },
      "perMinute": { "max": 30, "subject": "default" }
    },
    "judgeHourly": {
      "perHour": { "max": 200, "subject": "default" }
    }
  },
  "antiCheat": {
    "burst": { "windowSeconds": 60, "threshold": 5 },
    "identicalPeer": { "minOverlap": 3 },
    "lowVariance": { "min": 3, "max": 25 },
    "multiAccount": { "keyFields": ["phone", "org"] },
    "tiedMutualPeerRate": { "threshold": 0.8 }
  },
  "reviewState": {
    "appealSubjectType": "team_result",
    "appealAllowedTiers": ["D"]
  },
  "reverseAudit": {
    "topN": 10,
    "instruction": "电话回访 TOP 名单，确认签字人理解与签字内容一致（S7 §4.1 R-JDG-16）"
  },
  "retention": {
    "archiveMonths": 6
  }
}
```

`platform/src/config.js` —— 修改处 1（`FILES` 增加 `audit`）：

```javascript
const FILES = {
  scoringInitial: 'scoring-initial.json',
  scoringFinal: 'scoring-final.json',
  tiebreak: 'tiebreak.json',
  ranks: 'ranks.json',
  behavior: 'behavior-points.json',
  visibility: 'visibility.json',
  registration: 'registration-scoring.json',
  solvability: 'solvability.json',
  milestones: 'milestones.default.json',
  teamFormation: 'team-formation.json',
  schedule: 'schedule.json',
  compliance: 'compliance.json',
  points: 'points.json',
  criteria: 'criteria.json',
  audit: 'audit.json',                     // ← P4 新增
};
```

`platform/src/config.js` —— 修改处 2（`grouped` 增加 `audit`）：

```javascript
  const grouped = {
    scoring: { initial: rules.scoringInitial, final: rules.scoringFinal },
    tiebreak: rules.tiebreak,
    ranks: rules.ranks,
    behavior: rules.behavior,
    visibility: rules.visibility,
    registration: rules.registration,
    solvability: rules.solvability,
    milestones: rules.milestones,
    teamFormation: rules.teamFormation,
    schedule: rules.schedule,
    compliance: rules.compliance,
    points: rules.points,
    criteria: rules.criteria,
    audit: rules.audit,                    // ← P4 新增
  };
```

`platform/src/config.js` —— 修改处 3（`validateRules` 末尾追加 audit 的**内容**校验，插在 `return errors;` 之前）：

```javascript
  // ── 审计与防作弊（P4）────────────────────────────────────
  const audit = rules.audit;
  if (!audit) {
    errors.push('audit 缺失');
  } else {
    for (const [name, profile] of Object.entries(audit.rateLimit ?? {})) {
      for (const layer of ['lock', 'sliding', 'perMinute', 'perHour']) {
        const l = profile?.[layer];
        if (!l) continue;
        if (layer === 'lock' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.lock.seconds 必须是正整数`);
        }
        if (layer !== 'lock' && !(Number.isInteger(l.max) && l.max > 0)) {
          errors.push(`audit.rateLimit.${name}.${layer}.max 必须是正整数`);
        }
        // ⚠️ perMinute / perHour 的窗口长度是**结构决定的**（一分钟 / 一小时）——
        //    服务层写死 60_000 / 3_600_000 毫秒，配置里没有、也**不该有** seconds：
        //    配了也不会生效（配置说了不算 = 说谎）。
        //    只有滑动窗口（sliding）的窗口长度与提交锁（lock）的持有时长是可配的。
        if (layer === 'sliding' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.sliding.seconds 必须是正整数`);
        }
      }
    }
    const lv = audit.antiCheat?.lowVariance;
    if (!lv || !(Number.isFinite(lv.min) && Number.isFinite(lv.max)) || lv.min >= lv.max) {
      errors.push('audit.antiCheat.lowVariance 必须满足 min < max');
    }
    if (!(Number.isInteger(audit.antiCheat?.identicalPeer?.minOverlap) && audit.antiCheat.identicalPeer.minOverlap >= 2)) {
      errors.push('audit.antiCheat.identicalPeer.minOverlap 必须 ≥ 2（重叠项目太少没有判定力）');
    }
    if (!(Number.isInteger(audit.retention?.archiveMonths) && audit.retention.archiveMonths > 0)) {
      errors.push('audit.retention.archiveMonths 必须是正整数（R-JDG-17 赛后 6 个月可查）');
    }
    if (!Array.isArray(audit.reviewState?.appealAllowedTiers) || audit.reviewState.appealAllowedTiers.length === 0) {
      errors.push('audit.reviewState.appealAllowedTiers 不得为空');
    }
  }

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
> → **加多少份配置都自动覆盖**，P4 不需要改 version 校验。
> **改成什么**：本步**只**做三件事 —— ① `FILES` 加 `audit`；② `grouped` 加 `audit`；
> ③ `validateRules` 末尾追加 audit 的**内容**校验段。version 校验一个字都不动。
> **⚠️ 本次一并订正了「修改处 1 / 2」的原文**：原来贴的是 **P0 的 9 项** `FILES` / `grouped`，
> 但基线的 `FILES` 已经有 **P1 加的 3 份**（`teamFormation` / `schedule` / `compliance`），
> **P3 又加了 2 份**（`points` / `criteria`）。实施者若照原文**整块替换**，会把这些配置**删掉**
> → `FILES` 份数与 `grouped` 对不上 `expectedCount`，且 `rules.points` / `rules.criteria`
> 变成 `undefined` → 报「points 缺失 / criteria.tier 缺失 / criteria.mvp.tiebreak 缺失」
> → **拒绝启动**。
> **【2026-10-21 Task 3 预审修正 · 见台账 P4-7】**：上面三块「修改处 1 / 2 / 3」已从
> 「一个 `text` 大块（整块替换语义）」改成**三块独立代码块**，每块都是**从落地实现里逐字切出的
> 连续片段**（`FILES` 17 行 / `grouped` 16 行 / 校验段 39 行）—— 实施者只需**按位置插入**，
> 不会再有「照抄整块把别人的配置删掉」的事故；P1 的 3 份与 P3 的 2 份都在块里。
> **【2026-10-21 Task 3 预审修正 · 见台账 P4-6】**：「修改处 3」的校验段也已订正 ——
> `seconds` **只对 `lock` 与 `sliding` 必填**；`perMinute` / `perHour` 的窗口长度是**结构决定的**
> （一分钟 / 一小时，服务层写死 `60_000` / `3_600_000` 毫秒），配置里没有也不该有 `seconds`
> （配了也不生效 = 配置说了不算 = 说谎）。按原文字面实施 ⇒ 规格自带的 `rules/audit.json`
> 通不过规格自带的校验段 ⇒ **拒绝启动**。
> **⚠️ 硬前提**：`rules/audit.json` **必须带 `"id": "audit"`**（识别「一份配置」用的是 `id`
> 而不是 `version`）；P4 落地时 `FILES` 为 **15** 份（P0 的 9 + P1 的 3 + P3 的 2 + P4 的 1），识别到的配置份数也必须是 15。
> **依据**：基线 `platform/src/config.js` + 漂移审计报告 I-2 与 D-3。

- [ ] **Step 4: 创建 `src/services/rate-limit.js`**

```javascript
// src/services/rate-limit.js — 三层限频 + 评委级每小时配额
// 依据：设计文档 §11.1「三层限频：滑动窗口计数 + 提交锁 + 每分钟配额；再加评委级配额（每人每小时打分次数上限）」
//   借鉴 CTFd api/v1/challenges.py 的三层限频思路（Apache-2.0），只读思路独立实现。
//   溯源：R-AUD-05 空结果必须显式报错 —— 限频触发必须返回 429 + retryAfterSeconds，⛔ 绝不静默丢包。
//   ⛔ 计数落 rate_limit_events 表：只在内存计数 = 进程重启即失效 = 等于没有限频。
import {
  countBucket, incrementBucket, slidingWindowCount, slidingWindowEvents, acquireLock,
} from '../db/repo/rate-limit.js';
import { appError, rateLimited } from '../errors.js';

function bucketKey(kind, ms, unit) {
  return `${kind}:${Math.floor(ms / unit)}`;
}

/**
 * 检查限频。通过则消耗配额，不通过则返回 allowed=false + retryAfterSeconds。
 * @param {object} args
 * @param {string} args.subjectKey 被限的主体
 * @param {string} args.rule       限频 profile 名（对应 rules.audit.rateLimit.<rule>）
 * @param {object} args.limits     rules.audit.rateLimit
 * @param {object} [args.subjects] 额外的 subject 维度，如 { judge: 'judge:u1' }
 */
export function checkRateLimit({
  db, subjectKey, rule, now = new Date().toISOString(), limits, subjects = null,
}) {
  if (!subjectKey) throw appError(400, 'INVALID_REQUEST', '限频必须给 subjectKey');
  if (!rule) throw appError(400, 'INVALID_REQUEST', '限频必须给 rule');
  const profile = limits?.[rule];
  if (!profile) {
    // ⛔ 没有配置就放行 = 限频形同虚设。直接报错。
    throw appError(500, 'RATE_LIMIT_NOT_CONFIGURED', `限频规则未配置: ${rule}（rules/audit.json 缺该 profile）`);
  }

  const nowMs = Date.parse(now);
  const resolved = { default: subjectKey, ...(subjects ?? {}) };
  const subjectOf = (layer) => resolved[layer?.subject ?? 'default'] ?? subjectKey;

  const layers = [];

  // ── 只读判定（不消耗配额）────────────────────────────────
  if (profile.sliding) {
    const key = subjectOf(profile.sliding);
    const count = slidingWindowCount(db, {
      subjectKey: key, rule: `sliding:${rule}`, now, windowSeconds: profile.sliding.seconds,
    });
    layers.push({
      layer: 'sliding',
      allowed: count < profile.sliding.max,
      count,
      max: profile.sliding.max,
      retryAfterSeconds: count < profile.sliding.max
        ? 0
        : slidingRetryAfter(db, {
          subjectKey: key, rule: `sliding:${rule}`, now, windowSeconds: profile.sliding.seconds, max: profile.sliding.max,
        }),
    });
  }
  if (profile.perMinute) {
    const key = subjectOf(profile.perMinute);
    const bucket = bucketKey('m', nowMs, 60_000);
    const count = countBucket(db, { subjectKey: key, rule: `minute:${rule}`, bucket });
    layers.push({
      layer: 'perMinute',
      allowed: count < profile.perMinute.max,
      count,
      max: profile.perMinute.max,
      retryAfterSeconds: count < profile.perMinute.max
        ? 0
        : Math.max(1, Math.ceil(((Math.floor(nowMs / 60_000) + 1) * 60_000 - nowMs) / 1000)),
    });
  }
  if (profile.perHour) {
    const key = subjectOf(profile.perHour);
    const bucket = bucketKey('h', nowMs, 3_600_000);
    const count = countBucket(db, { subjectKey: key, rule: `hour:${rule}`, bucket });
    layers.push({
      layer: 'perHour',
      allowed: count < profile.perHour.max,
      count,
      max: profile.perHour.max,
      retryAfterSeconds: count < profile.perHour.max
        ? 0
        : Math.max(1, Math.ceil(((Math.floor(nowMs / 3_600_000) + 1) * 3_600_000 - nowMs) / 1000)),
    });
  }

  const blocked = layers.find((l) => !l.allowed);
  if (blocked) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: blocked.retryAfterSeconds,
      layers,
    };
  }

  // ── 取提交锁（防并发灌分）──────────────────────────────
  if (profile.lock) {
    const key = subjectOf(profile.lock);
    const lock = acquireLock(db, {
      subjectKey: key, rule: `lock:${rule}`, now, lockSeconds: profile.lock.seconds,
    });
    if (!lock.acquired) {
      layers.push({ layer: 'lock', allowed: false, retryAfterSeconds: lock.retryAfterSeconds });
      return { allowed: false, remaining: 0, retryAfterSeconds: lock.retryAfterSeconds, layers };
    }
    layers.push({ layer: 'lock', allowed: true, retryAfterSeconds: 0 });
  }

  // ── 消耗配额（落库）────────────────────────────────────
  if (profile.sliding) {
    const key = subjectOf(profile.sliding);
    incrementBucket(db, {
      subjectKey: key, rule: `sliding:${rule}`, bucket: bucketKey('s', nowMs, 1000), now,
    });
  }
  if (profile.perMinute) {
    const key = subjectOf(profile.perMinute);
    incrementBucket(db, {
      subjectKey: key, rule: `minute:${rule}`, bucket: bucketKey('m', nowMs, 60_000), now,
    });
  }
  if (profile.perHour) {
    const key = subjectOf(profile.perHour);
    incrementBucket(db, {
      subjectKey: key, rule: `hour:${rule}`, bucket: bucketKey('h', nowMs, 3_600_000), now,
    });
  }

  const remaining = layers.length
    ? Math.min(...layers.filter((l) => Number.isInteger(l.max)).map((l) => Math.max(0, l.max - l.count - 1)))
    : 0;

  return { allowed: true, remaining, retryAfterSeconds: 0, layers };
}

// 滑动窗口的等待时间：等到窗口内最早的若干次记录滑出窗口，才腾得出一个名额。
function slidingRetryAfter(db, { subjectKey, rule, now, windowSeconds, max }) {
  const events = slidingWindowEvents(db, { subjectKey, rule, now, windowSeconds });
  const total = events.reduce((a, e) => a + e.count, 0);
  if (total < max) return 0;
  let need = total - max + 1;
  for (const e of events) {
    if (need <= 0) break;
    need -= e.count;
    if (need <= 0) {
      const outAt = Date.parse(e.window_start) + windowSeconds * 1000;
      return Math.max(1, Math.ceil((outAt - Date.parse(now)) / 1000));
    }
  }
  return Math.max(1, windowSeconds);
}

/**
 * 限频断言：不通过抛 429（AppError），detail.retryAfterSeconds 必填。
 * HTTP 层据此返回 429 + Retry-After 响应头（⛔ 不静默丢包）。
 */
export function assertRateLimit(args) {
  const result = checkRateLimit(args);
  if (!result.allowed) {
    throw rateLimited(
      `触发限频（${args.rule}），请 ${result.retryAfterSeconds} 秒后重试`,
      { retryAfterSeconds: result.retryAfterSeconds, rule: args.rule, layers: result.layers },
    );
  }
  return result;
}
```

- [ ] **Step 5: 创建 `src/services/idempotency.js`**

```javascript
// src/services/idempotency.js — 幂等键执行器
// 依据：设计文档 §11.1「重复提交 / 并发灌分 → 幂等键（request_id 唯一）」
//   借鉴 hack-the-back app/services/judging.py 的幂等思路（MIT），只读思路独立实现。
//   ⛔ 同一 request_id 重复提交只生效一次，且重复请求返回【首次的响应】——不是重新算一遍。
//
// ⚠️ **这不是 P2 的 `src/db/repo/request-keys.js`（`claimRequestKey`）** —— 两者看着像，
//    却是**两个不同的能力**，别当重复造轮子：
//    · P2 `review_request_keys`：**只抢键**。抢到 = 首次生效，抢不到 = 重复请求 → 直接短路，
//      幂等键表里**不存业务响应**。用于「一次批量提交写多行、它们共用同一个 request_id」
//      的评审场景（键建在业务表的 request_id 列上会插不进第二批）。
//    · P4 `idempotency_keys`：**存业务响应**。首次执行完把响应 JSON 落库，重复请求
//      **原样返回首次的响应**（调用方不需要再问一次「上次到底成没成」）。
//    一句话：P2 管「别重复写」，P4 管「重复写时也要能给出同样的答复」。
//
// ⚠️ **响应是 JSON 往返**：首次调用返回的是业务函数的**原始返回值**，
//    重放返回的是**落库后再解析**的那份（`JSON.parse(response_json)`）。
//    对 JSON 安全的载荷两者完全一致；对 `undefined` / `Date` / `Map` 这类值会不同
//    （`undefined` 落库成 NULL、重放拿到 `null`）。HTTP 层本来就只吐 JSON，
//    所以对外无感；调用方若直接读对象字段，请只用 JSON 安全的返回值。
import { withTransaction } from '../db/tx.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { badRequest } from '../errors.js';

export function withIdempotency({ db, key, scope, requestId = null, now = new Date().toISOString() }, fn) {
  if (!key) throw badRequest('幂等执行必须给 key（request_id）');
  if (!scope) throw badRequest('幂等执行必须给 scope（操作域）');

  return withTransaction(db, () => {
    const existing = findIdempotency(db, { key, scope });
    if (existing) {
      // ⛔ 重复请求：直接返回首次的响应，不重新执行业务函数
      return {
        replayed: true,
        result: existing.response_json === null ? null : JSON.parse(existing.response_json),
        storedAt: existing.created_at,
      };
    }

    const result = fn();
    const inserted = insertIdempotency(db, { key, scope, requestId, response: result, now });
    if (!inserted) {
      // 并发下别人先写进去了：以库里的首次响应为准
      const again = findIdempotency(db, { key, scope });
      return {
        replayed: true,
        result: again?.response_json ? JSON.parse(again.response_json) : null,
        storedAt: again?.created_at ?? now,
      };
    }
    return { replayed: false, result, storedAt: now };
  });
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd platform && node --test test/rate-limit.test.js`
Expected: PASS（24 个测试全过：rate-limit.test.js 24）

> **【2026-10-21 漂移审计修正 M-1】** **原来错在哪**：本计划两处「Expected: PASS」的条数声明
> 与代码块里实际的 `test(` 数量不符 —— `rate-limit.test.js` 声明 **11** 实为 **10**、
> `review-state.test.js` 声明 **12** 实为 **13**。
> **为什么错**：条数是**实施时的验收闸**。实施者跑出 10 个而计划写 11 个，会误判「测试缺失」
> 而去改测试代码迁就声明，或者干脆失去对闸的信任。
> **注意方向相反**：一处少 1、一处多 1 —— 说明是**手工维护漂移**，不是有意为之。
> **改成什么**：① 两个数字改成实测值；② 把本计划**全部 7 处** `Expected: PASS` 统一成
> `Expected: PASS（N 个测试全过：file N）` 的格式。
> **依据**：按「就近 `Run:` 行指向的测试文件 → 该文件的 fenced code block 内 `^test(` 出现次数」
> 逐个统计（与审计报告 M-1 同一口径），并在本次改动后**对五份计划全量复算**：
> 每一条 `Expected: PASS（N …）` 现已与代码块实测条数**逐条相等**。

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/services/rate-limit.js src/services/idempotency.js rules/audit.json src/config.js test/rate-limit.test.js
git commit -m "feat(P4): 三层限频（落库）+ 评委级小时配额 + 幂等键执行器"
```

## Task 3 父代理预审修正台账（2026-10-21）

> Task 3 = **限频三层（滑动窗口 + 提交锁 + 每分钟配额）+ 评委级每小时配额 + 幂等键执行器**。
> 实施前做了一次**独立工程实跑**（把规格的代码块抽到 `/tmp/p4t3/` 的副本里跑通再落盘 —— 「先跑后派」）：
> 规格自带的 `rate-limit.test.js`（10 条）**一次就全绿**（`/tmp/p4t3/scratch1`）；
> 但在接入 `src/config.js` 时**实证了 2 处 Critical 级规格缺陷**（照字面实施 ⇒ 服务器**拒绝启动**）。
> 实施完成后做**变异检验**：变异体 **30** 个 → **KILLED 30 / 存活 0 / 等价 0 / 有效缺口 0**。
>
> **编号约定**：本段沿用 Task 1 台账的「**规格缺陷**编号」序列（`P4-1..P4-5`），从 **P4-6** 起续编；
> 后续任务（Task 4 及以后）请从 **P4-8** 起续编，避免撞号。
> ⚠️ **两套号别混**：本台账的 `P4-x` 是**规格缺陷编号**；文末「P4 验收标准」表里的 `P4-1..P4-11`
> 是**验收项编号**（P4-6 = 「PENDING_REVIEW 分数不可见」、P4-7 = 「检测 ≠ 处罚」）——
> 两套号**各指各的**，读台账时以「### 一、预审发现的规格缺陷」这张表为准。
> 本段的 `L-1` / `L-2` 是「**已登记的已知限制**」编号，与上面两套都不同。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P4-6** | **Critical** | **规格自带的 `rules/audit.json` 通不过规格自带的 `validateRules` 校验段 ⇒ `loadRules()` 抛错 ⇒ 服务器拒绝启动。** 根因：校验段要求 `perMinute` / `perHour` 两层**也必须声明 `seconds`**，但规格自己的 `audit.json` 里这两层**只有 `max`**（`perMinute: { max: 5 }` / `perHour: { max: 200 }`）；而且这两层的窗口长度是**结构决定的**（一分钟 / 一小时），服务层写死 `60_000` / `3_600_000` 毫秒 —— 配置里**配了也不会生效** | `node /tmp/p4t3/probe-config.mjs`（步骤 2：FILES/grouped 已补正、校验段仍按规格字面）→<br>`❌ loadRules 抛错：规则配置校验失败，拒绝启动：`<br>`  - audit.rateLimit.appealSubmit.perMinute.seconds 必须是正整数`<br>`  - audit.rateLimit.reviewSubmit.perMinute.seconds 必须是正整数`<br>`  - audit.rateLimit.judgeHourly.perHour.seconds 必须是正整数` | **改规格，不迁就实现**：校验段改成「`seconds` 只对 `lock` 与 `sliding` 必填」；`perMinute` / `perHour` 不再要求 `seconds`，并在块内注明「这两层的窗口是结构决定的，配了也不生效 —— 配置说了不算 = 说谎」。规格与实现**同一份文本**（计划「修改处 3」块 39 行与 `src/config.js` 逐字一致，`fragment-check.mjs` ✅） |
| **P4-7** | **Critical** | **规格的「修改处 1 / 2」（`FILES` / `grouped`）是**过期**的**：只列了 P0 的 9 项 + P1 的 3 项 + P4 的 1 项 = **13 份**，**漏掉 P3 加的 `points` / `criteria` 两份**（基线 `FILES` 实为 14 份，加 P4 的 1 份 = 15 份）。照原文**整块替换** ⇒ P3 的两份被删 ⇒ `rules.points` / `rules.criteria` 变 `undefined` ⇒ 报「points 缺失 / criteria.tier 缺失 / criteria.mvp.tiebreak 缺失」⇒ **拒绝启动**；更糟的是这两块**永远不可能与正确实现逐字一致**（正确实现必须含 P3 的两份）⇒「计划 = 规格」这条纪律本身被打破 | `node /tmp/p4t3/probe-config.mjs`（步骤 1：按规格字面整块替换）→<br>`❌ loadRules 抛错：规则配置校验失败，拒绝启动：`<br>`  - points 缺失`<br>`  - criteria.tier 缺失`<br>`  - criteria.mvp.tiebreak 缺失或为空`<br>`（另有 3 条 `perMinute.seconds` 错误 ⇒ 见 P4-6） | **改规格**：把「修改处 1 / 2 / 3」从一个 `text` 大块（整块替换语义）拆成**三块独立代码块**，每块都是**从落地实现里逐字切出的连续片段**（`FILES` 17 行 / `grouped` 16 行 / 校验段 39 行）—— 实施者只需**按位置插入**，不会再误删别人的配置；`fragment-check.mjs` **3/3 ✅** |

### 二、已登记的已知限制（**未改规格**：不导致任何计划用例变红，故按「最小一致改动」只登记不改）

| # | 级别 | 限制 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **L-1** | Minor | **幂等的响应是「JSON 往返」**：首次调用返回业务函数的**原始返回值**，重放返回**落库后再解析**的那份。JSON 安全的载荷两者完全一致；`undefined` 会落库成 `NULL`、重放拿到 `null`（`deepEqual(undefined, null)` 为假）。`Date` / `Map` 同理（首次是对象、重放是字符串 / `{}`） | `node --disable-warning=ExperimentalWarning -e "…withIdempotency(…, () => undefined)…"` →<br>`OK {"replayed":false,"storedAt":"…"}`（`insertIdempotency` 的默认参数 `response = null` 兜住了 `undefined`，**不会**触发 node:sqlite 的 `Provided value cannot be bound to SQLite parameter 1`）；重放时 `result` 为 `null` | **不改实现**：HTTP 层本来就只吐 JSON ⇒ 对外无感；调用方若直接读对象字段，只用 JSON 安全的返回值。已在 `src/services/idempotency.js` 头部注释写明这条边界 |
| **L-2** | Minor | **只配 `lock`、不配配额层的 profile ⇒ `remaining` = `Math.min(...[])` = `Infinity`**（`JSON.stringify` 后成 `null`）。出厂的 `rules/audit.json` 每个 profile 都带配额层 ⇒ 线上不可达；`rules/audit.json` 之外的临时 profile 可达 | `checkRateLimit({ db, subjectKey: 'x', rule: 'lockOnly', limits: { lockOnly: { lock: { seconds: 5 } } } })` → `remaining === Infinity` | **不改实现**（`remaining` 在「无配额层」时的语义本身没定义 —— 填 0 是「没有剩余次数」、填 `null` 是「不适用」，都得改接口契约）；本阶段只登记，**并提醒 Task 6 的 HTTP 层**：若要把 `remaining` 直接序列化给客户端，先决定这个分支的口径 |

### 三、变异检验（**独立变异测试**，脚本 `/tmp/p4t3/mutate.mjs`）

> 变异体 **30** 个，在 `/tmp/p4t3/` 的**独立副本**上跑**已落地**的 `platform/test/rate-limit.test.js`，
> **测试必须失败才算杀灭**（KILLED）。脚本内置三道闸：
> ① **锚点唯一性**：锚点在目标文件里必须**恰好命中 1 次**（命中 2 次即判 `ANCHOR_INVALID`，不出变异体）；
> ② **语法自检**：变异后文件必须仍能被 `node --check` 解析（坏变异体判 `BROKEN`，**不计入杀灭**）；
> ③ **基线闸**：未变异时测试文件必须全绿，否则整轮作废（「存活」不可信）。
> 首轮有 **2 条锚点命中 2 次**（M05 `windowSeconds:` 行、M23 `replayed: true` 行），
> 按纪律「命中 2 次要加长上下文」加长锚点后两条都被杀灭。

| 覆盖面 | 变异体 | 结果 |
|---|---|---|
| 限频三层判定（未配置即报错 / 滑动窗口 / 每分钟 / 每小时） | M01–M04 | 4/4 KILLED |
| 窗口与桶的时间口径（秒当毫秒 / 60 秒当 120 秒 / 3600 秒当 7200 秒） | M05、M11、M12 | 3/3 KILLED |
| 提交锁（不取锁 / 取到锁当没取到 / 仓库层锁永不过期） | M06、M07、M29 | 3/3 KILLED |
| 配额落库（滑动 / 分钟 / 小时三层各一条） | M08–M10 | 3/3 KILLED |
| `subjects` 维度（一律按默认 `subjectKey` 计数） | M13 | 1/1 KILLED |
| `retryAfterSeconds` 口径（滑动固定值 / 分钟恒 1 / 小时恒 1） | M14、M18、M19 | 3/3 KILLED |
| `remaining` 口径（少减一次 / 取最大而非最小） | M15、M16 | 2/2 KILLED |
| 「只有放行的请求才消耗配额」 | M17 | 1/1 KILLED |
| `assertRateLimit` 抛 429（静默丢包） | M20 | 1/1 KILLED |
| 幂等（不查旧键 / 响应不返回 / 重放标志 / scope 不参与查询 / 不包事务 / 并发抢先写入不采信库里响应 / `storedAt` 不是首次落库时间 / 缺 key 不报错） | M21–M28 | 8/8 KILLED |
| 仓库层「滑动窗口不看窗口」 | M30 | 1/1 KILLED |

**最终结果**：变异体 **30** → **KILLED 30 / SURVIVED 0 / BROKEN 0 / ANCHOR_INVALID 0**；
**等价变异体 0**（无「杀不掉但也不影响行为」的项需要标注）、**不可观测变异体 0**、**有效缺口 0**。

> 变异脚本里 **M29 / M30** 这两条**故意打在 Task 1 的仓库层文件**上
> （`src/db/repo/rate-limit.js`）—— 它们证明的是**服务层用例对底层行为有牙**：
> 「锁会过期」「滑动窗口真的只看窗口内的计数」这两条如果没人守，服务层的用例会假绿。
> 变异只在 `/tmp` 的副本上做，**不碰仓库文件**。

### 四、测试条数口径与核验

* **Task 3 测试条数**：`platform/test/rate-limit.test.js` = **24**
  （**规格自带 10** + **变异检验补测 14**）。
  补的 14 条全部是**判别性**用例（每条都对应上面某个变异体，补之前那条变异体会存活）：
  `subjects` 维度 / 滑动窗口到期恢复 / 提交锁到期恢复 / 被拒请求不消耗配额 / `remaining` 递减 /
  分钟桶键与 `retryAfterSeconds` / 小时桶键与 `retryAfterSeconds` / 滑动 `retryAfterSeconds` 精确值 /
  限频入参 400 / 幂等入参 400 / 幂等业务副作用回滚 / 幂等并发抢先写入采信库里响应 / `storedAt` 首次落库时间 /
  `layers` 形状。
* **全量回归**：P4 全量 **750/750**（基线 **726** + Task 3 的 24）。
  ⚠️ 父代理给的基线数字是 **723**；**实跑基线是 726**（Task 1 台账里写的 723 是补测前的旧数）。
* **计划块逐字核验**：`node /tmp/p3fix/plan-blocks.mjs <plan> <platform>` ⇒
  `test/rate-limit.test.js` **整文件块 ✅一致**（414 行）、
  `src/services/rate-limit.js` **整文件块 ✅一致**（167 行）、
  `src/services/idempotency.js` **整文件块 ✅一致**（52 行）；
  `node /tmp/p4-proof/fragment-check.mjs <plan> <platform> src/config.js` ⇒ **3/3 ✅**。
* ⚠️ **核验工具的一个盲点**（工具问题，不是规格问题）：`plan-blocks.mjs` 的 hint 正则里
  扩展名分支是 `(?:js|html|css|sql|json)`，**`js` 排在 `json` 前面** ⇒ 它对 `rules/audit.json`
  的 hint 会**截断成 `rules/audit.js`**（`.json` 的前两个字母正好是 `js`）⇒ 该块永远显示「无实现」。
  该文件改用**直接逐字比对**核验：计划行 1861 的 `json` 块与 `platform/rules/audit.json`
  **逐字一致 = True**。

---

### Task 4: 防作弊检测器 + 证据三列 + 字段字典

**Files:**
- Create: `platform/src/domain/anticheat.js`
- Create: `platform/src/domain/evidence.js`
- Create: `platform/src/domain/field-dictionary.js`
- Create: `platform/src/services/anticheat.js`
- Test: `platform/test/anticheat.test.js`
- Test: `platform/test/field-dictionary.test.js`

**Interfaces:**
- Consumes: Task 1 的 `createFlag` / `listFlagRows` / `resolveFlagRow` / `writeAuditLog`
  - ⚠️ **预审修正**：原写法还消费 `findOpenFlag`，但它的粗键 `(kind, stage_id, team_id, judge_id)`
    分不开「同 kind 的不同问题」（两个不同的多账号分组在粗键下 team_id / judge_id 都是 NULL →
    第二个被当成「重复」丢掉 = **真问题被漏报**）。去重改为「同 kind + 同赛段 + **同明细内容**」
    （见台账 P4-T4-D4）。`findOpenFlag` 仍留在仓储层，本阶段不再调用。
- Produces（领域层，纯函数：无 IO / 无 `Date.now()` / 无 `Math.random()`）：
  - `detectIdenticalPeerPattern({ peerReviews, minOverlap })` → `{ flags }`
  - `detectBurstSubmission({ events, windowSeconds, threshold })` → `{ flags, maxCount }`
  - `detectLowVariance({ scoreStats, threshold })` → `{ flags }`
  - `detectMultiAccount({ users, keyFields })` → `{ flags }`
  - `detectTiedMutualPeerRate({ peerReviews, results, threshold })` → `{ flags }`（R-RNK-08）
  - `normalizeEvidence({ items })` → `{ columns, items, uniquePublishers, dropped, violations }`（R-AUD-04）
  - `assertKnownFields(kind, detail)` / `assertMutuallyExclusive(detail)` / `assertConfidenceLabel(v)`（R-AUD-06）
- Produces（服务层）：
  - `runDetection({ db, stageId, peerReviews, events, scoreStats, users, rules, now, extraCandidates? })` → `{ created, skipped }`
    - ⚠️ **预审修正**：原 Interfaces 写的是 `{ created, skipped, flags }`，但实现从来只返回前两个键（写接口契约就是错的）
    - `extraCandidates` 是扩展点：追加候选 flag（默认空），给「还没进检测器模块的新检测器」用；
      同时给「字段字典闸」一条可测的入口（候选里带越界字段 → 必须 400，不进库）
  - `resolveFlag({ db, flagId, status, reviewerId, reason, evidence, now })` → flag
  - `listFlags({ db, filter, viewer })` → `{ rows, total }`
  - `assertFlagDetail(flag)` → `string[]`（字段字典闸，R-AUD-06；抽成导出函数才能被单独测到）
  - `buildReverseAuditTasks({ results, signoffs, topN })` → `[{ teamId, rank, signoffs, instruction }]`（R-JDG-16）

> **⚠️ 检测 ≠ 处罚（本阶段的硬边界，写进代码注释与验收标准）**
> 四个检测器**只产出 flag 并进复核队列**。它们**不改分、不封号、不改档位、不自动裁决**。
> 任何"检测到就扣分"的实现都不属于本计划。同样，`detectLowVariance` 的输出里带 `action: 'alert_only'` 字段——把这个边界写进数据本身，而不是只写在注释里。

- [ ] **Step 1: 写失败的测试**

`platform/test/anticheat.test.js`：

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
  detectIdenticalPeerPattern, detectBurstSubmission, detectLowVariance,
  detectMultiAccount, detectTiedMutualPeerRate,
} from '../src/domain/anticheat.js';
import { normalizeEvidence } from '../src/domain/evidence.js';
import { assertKnownFields } from '../src/domain/field-dictionary.js';
import { runDetection, resolveFlag, listFlags, buildReverseAuditTasks, assertFlagDetail } from '../src/services/anticheat.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4ac-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  seedRefs(db);
  return { db, close, dataDir };
}

/**
 * 造出被外键引用的行。
 * ⚠️ 规格原写法直接用 reviewerId='u_admin' 写审计日志，
 *    但 audit_log.actor_id REFERENCES users(id) —— **不建被引用的行就会
 *    FOREIGN KEY constraint failed**。这不是测试写得随意，是规格自带缺陷：照抄必然红
 *    （与 P4 Task 1 的 audit-repo.test.js 同一个坑）。
 */
function seedRefs(db) {
  db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_admin','组委会','13900000999','x','mba',NULL,1,1,'2026-10-20T00:00:00.000Z');
  `);
}

const VIEWER = { id: 'u_admin', is_superadmin: 1, active: 1 };

// 统一的规则集（与 rules/audit.json 的 antiCheat 段同值，见 P4 计划 Task 3）
const RULES = {
  audit: {
    antiCheat: {
      identicalPeer: { minOverlap: 3 },
      burst: { windowSeconds: 60, threshold: 5 },
      lowVariance: { min: 3, max: 25 },
      multiAccount: { keyFields: ['phone'] },
      tiedMutualPeerRate: { threshold: 0.8 },
    },
  },
};

test('互评相对顺序完全相同 → 疑似串通，进复核队列', () => {
  const peerReviews = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
    { judgeId: 'j2', teamId: 't1', score: 75 }, { judgeId: 'j2', teamId: 't2', score: 85 }, { judgeId: 'j2', teamId: 't3', score: 95 },
  ];
  const r = detectIdenticalPeerPattern({ peerReviews, minOverlap: 3 });
  assert.equal(r.flags.length, 0, '顺序相反不算串通');

  // ⛔ 预审修正（P4-T4-D1）：这里的"同序"数据集原来给反了 ——
  //    j2 打 (60,70,80) 的相对顺序是 t3>t2>t1，与 j1 的 t1>t2>t3 **正好相反**，
  //    检测器判「顺序不一致 → 不串通」是对的，用例却期望报 1 条 → 必然红。
  //    现在 j2 打 (60,50,40)：与 j1 同序（t1>t2>t3），但绝对分差一大截（不是照抄分数）。
  const same = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
    { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 50 }, { judgeId: 'j2', teamId: 't3', score: 40 },
  ];
  const r2 = detectIdenticalPeerPattern({ peerReviews: same, minOverlap: 3 });
  assert.equal(r2.flags.length, 1);
  assert.equal(r2.flags[0].kind, 'identical_peer_pattern');
  assert.deepEqual([r2.flags[0].voterA, r2.flags[0].voterB].sort(), ['j1', 'j2']);
  assert.equal(r2.flags[0].overlap, 3);
  assert.deepEqual(r2.flags[0].targets, ['t1', 't2', 't3']);
  assert.equal(r2.flags[0].matchRatio, 1);
  assert.equal(r2.flags[0].action, 'alert_only');
});

test('互评：也认 fromId/toId 别名（与 judgeId/teamId 等价）', () => {
  // 互评来源在别处可能叫 fromId/toId —— 两种写法必须等价，否则换个来源就检测不出来。
  const alias = [
    { fromId: 'j1', toId: 't1', score: 90 }, { fromId: 'j1', toId: 't2', score: 80 }, { fromId: 'j1', toId: 't3', score: 70 },
    { fromId: 'j2', toId: 't1', score: 60 }, { fromId: 'j2', toId: 't2', score: 50 }, { fromId: 'j2', toId: 't3', score: 40 },
  ];
  const r = detectIdenticalPeerPattern({ peerReviews: alias, minOverlap: 3 });
  assert.equal(r.flags.length, 1, '别名写法也要能检出同序');
  assert.equal(r.flags[0].voterA, 'j1');
  assert.equal(r.flags[0].voterB, 'j2');
  assert.deepEqual(r.flags[0].targets, ['t1', 't2', 't3']);
});

test('重叠项目少于 minOverlap 时不报（样本太少没有判定力）', () => {
  const peerReviews = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 },
    { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 70 },
  ];
  const r = detectIdenticalPeerPattern({ peerReviews, minOverlap: 3 });
  assert.equal(r.flags.length, 0);
});

test('互评：重叠数**刚好等于** minOverlap 也要报（阈值的另一侧）', () => {
  // 判别性数据：3 组重叠 = minOverlap → 必须报；少一组（2 组）→ 不报。
  // 只测「少于阈值」测不出 minOverlap 被写成 `<` 还是 `<=`。
  const three = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
    { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 50 }, { judgeId: 'j2', teamId: 't3', score: 40 },
  ];
  const r = detectIdenticalPeerPattern({ peerReviews: three, minOverlap: 3 });
  assert.equal(r.flags.length, 1, '重叠数正好等于 minOverlap 必须报');
  const two = three.filter((x) => x.teamId !== 't3');
  const r2 = detectIdenticalPeerPattern({ peerReviews: two, minOverlap: 3 });
  assert.equal(r2.flags.length, 0, '重叠数比 minOverlap 少一个必须不报');
});

test('突发提交：窗口内提交数超阈值才报', () => {
  const events = [
    { subjectId: 'j1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', at: '2026-10-20T00:00:05.000Z' },
    { subjectId: 'j1', at: '2026-10-20T00:00:10.000Z' },
    { subjectId: 'j2', at: '2026-10-20T00:00:01.000Z' },
  ];
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  assert.equal(r.flags.length, 0, '刚好等于阈值不报');
  assert.equal(r.maxCount, 3, 'maxCount 要如实反映窗口内最大提交数');

  const events2 = [...events, { subjectId: 'j1', at: '2026-10-20T00:00:15.000Z' }];
  const r2 = detectBurstSubmission({ events: events2, windowSeconds: 60, threshold: 3 });
  assert.equal(r2.flags.length, 1);
  assert.equal(r2.flags[0].kind, 'burst_submit');
  assert.equal(r2.flags[0].subjectId, 'j1');
  assert.equal(r2.flags[0].count, 4);
  assert.equal(r2.flags[0].action, 'alert_only');
});

test('突发提交：窗口外的提交不计入', () => {
  const events = [
    { subjectId: 'j1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', at: '2026-10-20T00:10:00.000Z' },
    { subjectId: 'j1', at: '2026-10-20T00:20:00.000Z' },
  ];
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  assert.equal(r.flags.length, 0);
});

test('突发提交：同一主体只报一次（连续爆发不重复报）', () => {
  // 判别性数据：窗口内 6 次提交、阈值 3 —— 循环里每多一个 end 都会再次越过阈值。
  //   「同一主体只报一次」的 break 在不在，结果差 3 倍（1 条 vs 3 条）。
  const events = Array.from({ length: 6 }, (_, i) => ({
    subjectId: 'j1', at: `2026-10-20T00:00:0${i}.000Z`,
  }));
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  assert.equal(r.flags.length, 1, '同一主体只报最早的那次爆发');
  assert.equal(r.flags[0].count, 4);
});

test('突发提交：窗口边界 —— 相隔正好 windowSeconds 算同一窗口（判别性数据）', () => {
  // 判别性数据：窗口是「开区间右闭」—— 差值**正好**等于窗口长度仍算同一窗口，
  // 差 1 毫秒才算出窗。只测「差 10 分钟」测不出 `>` 写成 `>=`。
  const inside = [
    { subjectId: 'j1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', at: '2026-10-20T00:01:00.000Z' },
  ];
  const r = detectBurstSubmission({ events: inside, windowSeconds: 60, threshold: 1 });
  assert.equal(r.flags.length, 1, '正好相隔 60 秒仍算同一窗口');
  assert.equal(r.flags[0].count, 2);

  const outside = [
    { subjectId: 'j1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', at: '2026-10-20T00:01:00.001Z' },
  ];
  const r2 = detectBurstSubmission({ events: outside, windowSeconds: 60, threshold: 1 });
  assert.equal(r2.flags.length, 0, '超出窗口 1 毫秒就不算同一窗口');
});

test('评委打分方差异常小/大都告警，但标死 action=alert_only（只告警不处罚）', () => {
  const scoreStats = [
    { judgeId: 'j1', dimension: 'innovation', n: 10, mean: 80, sum_sq: 64000 },  // stdev = 0
    { judgeId: 'j2', dimension: 'innovation', n: 10, mean: 70, sum_sq: 100000 }, // stdev ≈ 75.2773
  ];
  const r = detectLowVariance({ scoreStats, threshold: { min: 3, max: 25 } });
  assert.equal(r.flags.length, 2);
  const low = r.flags.find((f) => f.judgeId === 'j1');
  const high = r.flags.find((f) => f.judgeId === 'j2');
  assert.equal(low.direction, 'too_low');
  assert.equal(high.direction, 'too_high');
  assert.equal(low.stdev, 0);
  assert.equal(high.stdev, 75.277265);
  for (const f of r.flags) {
    assert.equal(f.action, 'alert_only', '检测器不得产出任何处罚动作');
    assert.equal(f.kind, 'low_variance');
  }
});

test('低方差：stdev 恰好等于 min / max 时不报（严格不等号，判别性数据）', () => {
  // 判别性数据：[0,0,0,6] 的 stdev 恰好 3；[0,0,0,50] 的 stdev 恰好 25。
  // 阈值写 `<` 还是 `<=` 只有在这种「恰好打平」的数据上才分得开。
  const scoreStats = [
    { judgeId: 'j_edge_low', dimension: 'innovation', n: 4, mean: 1.5, sum_sq: 36 },   // stdev = 3
    { judgeId: 'j_edge_high', dimension: 'innovation', n: 4, mean: 12.5, sum_sq: 2500 }, // stdev = 25
  ];
  const r = detectLowVariance({ scoreStats, threshold: { min: 3, max: 25 } });
  assert.equal(r.flags.length, 0, '恰好打平阈值不报（严格不等号）');

  const loose = detectLowVariance({ scoreStats, threshold: { min: 3.5, max: 25 } });
  assert.equal(loose.flags.length, 1, '阈值放宽一点点，stdev=3 就该报');
  assert.equal(loose.flags[0].judgeId, 'j_edge_low');

  const strict = detectLowVariance({ scoreStats, threshold: { min: 3, max: 24.5 } });
  assert.equal(strict.flags.length, 1, '阈值收紧一点点，stdev=25 就该报');
  assert.equal(strict.flags[0].judgeId, 'j_edge_high');
});

test('低方差：脏数据（sum_sq < n·mean²）按方差 0 处理，不产生 NaN', () => {
  // n=2, mean=5, sum_sq=10 → 真实方差是负数（脏数据）。
  // 原来靠 Math.max(0, ...) 兜住；去掉兜底就出 NaN，而 NaN 与任何阈值的比较都是 false
  // → 脏数据会被**静默放过**（该报的极端评分不报）。
  const r = detectLowVariance({
    scoreStats: [{ judgeId: 'j_dirty', dimension: 'innovation', n: 2, mean: 5, sum_sq: 10 }],
    threshold: { min: 3, max: 25 },
  });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].stdev, 0);
  assert.equal(r.flags[0].direction, 'too_low');
});

test('低方差：n=1 不报（单样本没有方差可言）', () => {
  // 判别性数据：n=1 时 stdev 被兜底成 0，若不守 n>1 就会把「只有一个打分」误报成方差异常小。
  const r = detectLowVariance({
    scoreStats: [{ judgeId: 'j_single', dimension: 'innovation', n: 1, mean: 80, sum_sq: 6400 }],
    threshold: { min: 3, max: 25 },
  });
  assert.equal(r.flags.length, 0, '单样本不构成方差异常');
});

test('多账号：同一手机号（规范化后）注册多个账号被识别', () => {
  const users = [
    { id: 'u1', phone: '13800000000', org: 'A' },
    { id: 'u2', phone: '+86 138-0000-0000', org: 'B' },
    { id: 'u3', phone: '13900000000', org: 'C' },
  ];
  const r = detectMultiAccount({ users, keyFields: ['phone'] });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].kind, 'multi_account');
  assert.deepEqual(r.flags[0].userIds.sort(), ['u1', 'u2']);
  assert.equal(r.flags[0].count, 2);
  assert.equal(r.flags[0].action, 'alert_only');
});

test('多账号：同一企业注册多个账号被识别', () => {
  const users = [
    { id: 'u1', phone: '13800000001', org: '某某科技有限公司' },
    { id: 'u2', phone: '13800000002', org: '某某科技有限公司' },
  ];
  const r = detectMultiAccount({ users, keyFields: ['org'] });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].keyField, 'org');
  assert.equal(r.flags[0].count, 2);
});

test('多账号：不同手机号不同企业不报', () => {
  const users = [
    { id: 'u1', phone: '13800000001', org: 'A' },
    { id: 'u2', phone: '13800000002', org: 'B' },
  ];
  const r = detectMultiAccount({ users, keyFields: ['phone', 'org'] });
  assert.equal(r.flags.length, 0);
});

test('多账号：同一个人重复出现只算一个账号（空手机号不参与分组）', () => {
  const users = [
    { id: 'u1', phone: '13800000001' },
    { id: 'u1', phone: '13800000001' },
    { id: 'u2', phone: '' },
    { id: 'u3', phone: '   ' },
  ];
  const r = detectMultiAccount({ users, keyFields: ['phone'] });
  assert.equal(r.flags.length, 0, '同一 id 重复出现 + 空手机号 → 不构成多账号');
});

test('同分互投率过高 → 告警（R-RNK-08）', () => {
  const peerReviews = [
    { fromId: 't1', toId: 't2', score: 90 }, { fromId: 't2', toId: 't1', score: 88 },
    { fromId: 't3', toId: 't4', score: 70 },
  ];
  const results = [
    { teamId: 't1', rank: 1 }, { teamId: 't2', rank: 1 },
    { teamId: 't3', rank: 3 }, { teamId: 't4', rank: 4 },
  ];
  const r = detectTiedMutualPeerRate({ peerReviews, results, threshold: 0.8 });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].kind, 'tied_mutual_peer_rate');
  assert.equal(r.flags[0].rate, 1);
});

test('同分互投率：真实互投率低于阈值不报，阈值降一点就报（判别性数据）', () => {
  // ⛔ 预审修正（P4-T4-D3）：分母原来写成「互投的对数」→ rate 恒为 1，阈值形同虚设。
  //    判别性数据：3 支同分队伍，候选对 3 组（A-B / A-C / B-C），其中 2 组互投
  //    → 真实互投率 2/3 = 0.6667。阈值 0.8 → 不报；阈值 0.6 → 报。
  const peerReviews = [
    { fromId: 'A', toId: 'B' }, { fromId: 'B', toId: 'A' },
    { fromId: 'A', toId: 'C' }, { fromId: 'C', toId: 'A' },
  ];
  const results = [{ teamId: 'A', rank: 1 }, { teamId: 'B', rank: 1 }, { teamId: 'C', rank: 1 }];
  const low = detectTiedMutualPeerRate({ peerReviews, results, threshold: 0.8 });
  assert.equal(low.flags.length, 0, '互投率 0.6667 < 0.8 → 不报');
  const mid = detectTiedMutualPeerRate({ peerReviews, results, threshold: 0.6 });
  assert.equal(mid.flags.length, 1, '阈值降到 0.6 → 报');
  assert.equal(mid.flags[0].rate, 0.6667);
  assert.equal(mid.flags[0].tiedPairs.length, 2);
  assert.equal(mid.flags[0].rank, 1);
  assert.equal(mid.flags[0].action, 'alert_only');
});

test('同分互投率：互投率恰好等于阈值要报（严格小于才跳过）', () => {
  // 判别性数据：5 支同分队伍，候选对 10 组，其中 8 组互投 → rate 恰好 0.8。
  // 阈值 0.8 时必须报（`rate < threshold` 是严格小于）。
  const mutual = [['A', 'B'], ['A', 'C'], ['A', 'D'], ['A', 'E'], ['B', 'C'], ['B', 'D'], ['B', 'E'], ['C', 'D']];
  const peerReviews = mutual.flatMap(([a, b]) => [{ fromId: a, toId: b }, { fromId: b, toId: a }]);
  const results = ['A', 'B', 'C', 'D', 'E'].map((teamId) => ({ teamId, rank: 1 }));
  const r = detectTiedMutualPeerRate({ peerReviews, results, threshold: 0.8 });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].rate, 0.8);
  assert.equal(r.flags[0].tiedPairs.length, 8);
});

test('证据三列：缺列必须显式报错，不静默丢弃', () => {
  const r = normalizeEvidence({ items: [{ url: 'https://a.example/x' }] });
  assert.equal(r.violations.length, 1);
  assert.deepEqual(r.violations[0].missing.sort(), ['independent', 'publisher']);
});

test('证据三列：按发行方去重，不按 URL 计数', () => {
  const r = normalizeEvidence({
    items: [
      { url: 'https://a.example/1', publisher: '某媒体', independent: true },
      { url: 'https://b.example/2', publisher: '某媒体', independent: true },
      { url: 'https://c.example/3', publisher: '另一媒体', independent: false },
    ],
  });
  assert.equal(r.items.length, 2, '同一发行方的第二条要被合并');
  assert.equal(r.uniquePublishers, 2, '计数按发行方，不按 URL');
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].url, 'https://b.example/2');
});

test('证据三列：同一 URL 不同发行方**不合并**（去重按发行方，不按 URL）', () => {
  const r = normalizeEvidence({
    items: [
      { url: 'https://same.example/1', publisher: '媒体甲', independent: true },
      { url: 'https://same.example/1', publisher: '媒体乙', independent: true },
    ],
  });
  assert.equal(r.items.length, 2, '两个发行方 = 两个独立信源，哪怕 URL 一样');
  assert.equal(r.uniquePublishers, 2);
  assert.equal(r.dropped.length, 0);
});

test('证据三列：发行方大小写 / 首尾空白不同算同一个发行方', () => {
  const r = normalizeEvidence({
    items: [
      { url: 'https://a.example/1', publisher: 'Reuters', independent: true },
      { url: 'https://b.example/2', publisher: ' reuters ', independent: true },
    ],
  });
  assert.equal(r.items.length, 1, '规范化后是同一个发行方 → 合并');
  assert.equal(r.uniquePublishers, 1);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].keptUrl, 'https://a.example/1');
});

test('证据三列：independent 只接受布尔或字符串 "true"', () => {
  const r = normalizeEvidence({
    items: [
      { url: 'https://a.example/1', publisher: '甲', independent: 'true' },
      { url: 'https://b.example/2', publisher: '乙', independent: 'yes' },
    ],
  });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].independent, true);
  assert.equal(r.items[1].independent, false);
});

test('runDetection 把检测结果写进 flagged_reviews，且不重复建同一 flag', () => {
  const { db, close, dataDir } = setup();
  const args = {
    db,
    stageId: 'st1',
    peerReviews: [
      // ⛔ 预审修正（P4-T4-D1）：j2 原来打 (60,70,80) → 与 j1 顺序相反 → 检测器正确地不报，
      //    用例却期望报 1 条。改成同序的 (60,50,40)。
      { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
      { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 50 }, { judgeId: 'j2', teamId: 't3', score: 40 },
    ],
    events: [],
    scoreStats: [],
    users: [],
    rules: RULES,
    now: '2026-10-20T00:00:00.000Z',
  };
  const first = runDetection(args);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].kind, 'identical_peer_pattern');
  // 检测也要留痕：flag.detected 审计日志是「检测 ≠ 处罚」的对账底账
  const detected = queryAuditLog(db, { action: 'flag.detected' });
  assert.equal(detected.rows.length, 1, '每次检出都要写一条审计日志');
  assert.equal(detected.rows[0].entity_id, first.created[0].id);
  const second = runDetection(args);
  assert.equal(second.created.length, 0, '同一问题不得重复建 flag');
  assert.equal(second.skipped.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('runDetection：同 kind 的**不同**问题各建各的 flag（粗去重键会漏报）', () => {
  // ⛔ 预审修正（P4-T4-D4）：原来按 (kind, stage, team, judge) 粗键去重 ——
  //    两个不同的多账号分组在粗键下 team_id / judge_id 都是 NULL → 第二个被当成重复丢掉。
  const { db, close, dataDir } = setup();
  const users = [
    { id: 'u1', phone: '13800000001' }, { id: 'u2', phone: '13800000001' },
    { id: 'u3', phone: '13800000002' }, { id: 'u4', phone: '13800000002' },
  ];
  const r = runDetection({
    db, stageId: 'st1', peerReviews: [], events: [], scoreStats: [], users, rules: RULES,
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(r.created.length, 2, '两个不同的多账号分组 = 两个问题 = 两条 flag');
  assert.deepEqual(r.created.map((c) => c.detail.keyValue).sort(), ['13800000001', '13800000002']);

  const again = runDetection({
    db, stageId: 'st1', peerReviews: [], events: [], scoreStats: [], users, rules: RULES,
    now: '2026-10-20T00:01:00.000Z',
  });
  assert.equal(again.created.length, 0, '重跑不得重复建');
  assert.equal(again.skipped.length, 2, '两个问题都应被识别为已存在');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('同一个问题：明细键顺序不同也算重复（不重建 flag）', () => {
  // 判别性数据：库里存的是**键顺序不同**的同一份明细（模拟旧版本写下的行）。
  //   比较若不做键排序，就会把它当成新问题 → 同一个问题被反复建 flag。
  const { db, close, dataDir } = setup();
  db.prepare(
    `INSERT INTO flagged_reviews (id, stage_id, submission_id, team_id, judge_id, kind, detail_json, status, reviewed_by, reviewed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)`,
  ).run(
    'fl_manual', 'st1', null, null, 'j1', 'burst_submit',
    JSON.stringify({
      action: 'alert_only',
      windowEnd: '2026-10-20T00:00:05.000Z',
      count: 6,
      kind: 'burst_submit',
      windowStart: '2026-10-20T00:00:00.000Z',
      subjectId: 'j1',
    }),
    '2026-10-20T00:00:00.000Z',
  );
  const events = Array.from({ length: 6 }, (_, i) => ({
    subjectId: 'j1', at: `2026-10-20T00:00:0${i}.000Z`,
  }));
  const r = runDetection({
    db, stageId: 'st1', peerReviews: [], events, scoreStats: [], users: [], rules: RULES,
    now: '2026-10-20T00:10:00.000Z',
  });
  assert.equal(r.created.length, 0, '同一份明细（键顺序不同）不得重建 flag');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].flagId, 'fl_manual');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('五个检测器的产出全部 action=alert_only，且全部通过字段字典（P4-7 + R-AUD-06）', () => {
  const peerReviews = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 },
    { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 50 },
  ];
  const events = Array.from({ length: 6 }, (_, i) => ({ subjectId: 'j1', at: `2026-10-20T00:00:0${i}.000Z` }));
  const scoreStats = [{ judgeId: 'j1', dimension: 'innovation', n: 10, mean: 80, sum_sq: 64000 }];
  const users = [{ id: 'u1', phone: '13800000001' }, { id: 'u2', phone: '13800000001' }];
  const results = [{ teamId: 't1', rank: 1 }, { teamId: 't2', rank: 1 }];
  const mutual = [{ fromId: 't1', toId: 't2' }, { fromId: 't2', toId: 't1' }];

  const all = [
    ...detectIdenticalPeerPattern({ peerReviews, minOverlap: 2 }).flags,
    ...detectBurstSubmission({ events, windowSeconds: 60, threshold: 5 }).flags,
    ...detectLowVariance({ scoreStats, threshold: { min: 3, max: 25 } }).flags,
    ...detectMultiAccount({ users, keyFields: ['phone'] }).flags,
    ...detectTiedMutualPeerRate({ peerReviews: mutual, results, threshold: 0.8 }).flags,
  ];
  assert.equal(all.length, 5, '五个检测器各命中一条');
  for (const f of all) {
    assert.equal(f.action, 'alert_only', `${f.kind} 不得产出处罚动作`);
    assert.deepEqual(assertKnownFields(f.kind, f), [], `${f.kind} 的字段必须都在字典里`);
  }
});

test('裁决 flag 会写审计日志，且证据按发行方去重后落库', () => {
  const { db, close, dataDir } = setup();
  const { created } = runDetection({
    db,
    stageId: 'st1',
    peerReviews: [],
    events: [{ subjectId: 'j1', at: '2026-10-20T00:00:00.000Z' }, { subjectId: 'j1', at: '2026-10-20T00:00:01.000Z' }, { subjectId: 'j1', at: '2026-10-20T00:00:02.000Z' }, { subjectId: 'j1', at: '2026-10-20T00:00:03.000Z' }, { subjectId: 'j1', at: '2026-10-20T00:00:04.000Z' }, { subjectId: 'j1', at: '2026-10-20T00:00:05.000Z' }],
    scoreStats: [],
    users: [],
    rules: RULES,
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(created.length, 1);
  const flagId = created[0].id;
  const out = resolveFlag({
    db,
    flagId,
    status: 'confirmed',
    reviewerId: 'u_admin',
    reason: '确认为脚本刷分，已记录',
    evidence: [
      { url: 'https://a.example/1', publisher: '某媒体', independent: true },
      { url: 'https://b.example/2', publisher: '某媒体', independent: true },
    ],
    now: '2026-10-20T01:00:00.000Z',
  });
  assert.equal(out.status, 'confirmed');
  assert.equal(out.detail.evidence.uniquePublishers, 1, '按发行方去重');
  assert.equal(out.detail.resolution.status, 'confirmed');
  assert.equal(out.detail.resolution.reason, '确认为脚本刷分，已记录');
  assert.equal(out.detail.resolution.reviewerId, 'u_admin');
  assert.equal(out.detail.resolution.decidedAt, '2026-10-20T01:00:00.000Z');
  const { rows } = queryAuditLog(db, { action: 'flag.resolve' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, flagId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('裁决：无理由 / 非法状态 / 缺列证据 / 不存在 / 二次裁决 都要显式报错', () => {
  const { db, close, dataDir } = setup();
  const { created } = runDetection({
    db, stageId: 'st1', peerReviews: [], events: [], scoreStats: [],
    users: [{ id: 'u1', phone: '13800000001' }, { id: 'u2', phone: '13800000001' }],
    rules: RULES, now: '2026-10-20T00:00:00.000Z',
  });
  const flagId = created[0].id;

  assert.throws(
    () => resolveFlag({ db, flagId, status: 'confirmed', reviewerId: 'u_admin', reason: '   ', now: '2026-10-20T01:00:00.000Z' }),
    (e) => e.status === 400 && /理由/.test(e.message),
    '没有理由的裁决必须被拒',
  );
  assert.throws(
    () => resolveFlag({ db, flagId, status: 'maybe', reviewerId: 'u_admin', reason: 'x', now: '2026-10-20T01:00:00.000Z' }),
    (e) => e.status === 400 && /confirmed/.test(e.message),
    '非法裁决状态必须被拒',
  );
  assert.throws(
    () => resolveFlag({
      db, flagId, status: 'confirmed', reviewerId: 'u_admin', reason: 'x',
      evidence: [{ url: 'https://a.example/1' }], now: '2026-10-20T01:00:00.000Z',
    }),
    (e) => e.status === 400 && /缺列/.test(e.message),
    '证据缺列必须报错，不得静默丢弃（P4-8）',
  );
  assert.throws(
    () => resolveFlag({ db, flagId: 'no-such-flag', status: 'confirmed', reviewerId: 'u_admin', reason: 'x', now: '2026-10-20T01:00:00.000Z' }),
    (e) => e.status === 404,
    '不存在的复核项必须是 404（单条不满足）',
  );

  resolveFlag({ db, flagId, status: 'confirmed', reviewerId: 'u_admin', reason: '确认', now: '2026-10-20T01:00:00.000Z' });
  assert.throws(
    () => resolveFlag({ db, flagId, status: 'rejected', reviewerId: 'u_admin', reason: '再改一次', now: '2026-10-20T02:00:00.000Z' }),
    (e) => e.status === 400 && /不得二次裁决/.test(e.message),
    '已裁决的复核项不得二次裁决',
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('复核队列：无权访问返回空集（列表不满足 → 200 + 空集）', () => {
  const { db, close, dataDir } = setup();
  // ⚠️ 判别性数据：队列里**先有东西**再问权限。
  //    队列本来是空的时，"有权"与"无权"的结果都是空集 —— 测不出权限判定有没有生效。
  runDetection({
    db, stageId: 'st1', peerReviews: [], events: [], scoreStats: [],
    users: [{ id: 'u1', phone: '13800000001' }, { id: 'u2', phone: '13800000001' }],
    rules: RULES, now: '2026-10-20T00:00:00.000Z',
  });
  const asJudge = listFlags({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(asJudge.rows, [], '无权的人看不到队列');
  assert.equal(asJudge.total, 0);
  const asAdmin = listFlags({ db, filter: {}, viewer: VIEWER });
  assert.equal(asAdmin.rows.length, 1, '同一个库，有权的人看得到 —— 证明空集不是因为库里没东西');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('复核队列：有权访问能看到队列，并能按 kind 过滤', () => {
  const { db, close, dataDir } = setup();
  runDetection({
    db, stageId: 'st1', peerReviews: [], events: [], scoreStats: [],
    users: [{ id: 'u1', phone: '13800000001' }, { id: 'u2', phone: '13800000001' }],
    rules: RULES, now: '2026-10-20T00:00:00.000Z',
  });
  const all = listFlags({ db, filter: {}, viewer: VIEWER });
  assert.equal(all.rows.length, 1);
  assert.equal(all.total, 1);
  assert.equal(all.rows[0].kind, 'multi_account');
  assert.equal(all.rows[0].status, 'open');
  assert.equal(all.rows[0].detail.action, 'alert_only');

  const filtered = listFlags({ db, filter: { kind: 'low_variance' }, viewer: VIEWER });
  assert.deepEqual(filtered.rows, [], '按 kind 过滤后不应有命中');
  assert.equal(filtered.total, 0);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('字段字典闸：越界字段名进不了库（R-AUD-06）', () => {
  assert.deepEqual(assertFlagDetail({ kind: 'low_variance', judgeId: 'j1', stdev: 1 }), []);
  assert.equal(assertFlagDetail({ kind: 'low_variance', judgeId: 'j1', 越界字段: 3 }).length, 1);
  assert.equal(assertFlagDetail({ kind: '字典里没有的 kind' }).length, 1);

  const { db, close, dataDir } = setup();
  assert.throws(
    () => runDetection({
      db, stageId: 'st1', peerReviews: [], events: [], scoreStats: [], users: [], rules: RULES,
      extraCandidates: [{ kind: 'low_variance', judgeId: 'j1', stdev: 1, 越界字段: 3, action: 'alert_only' }],
      now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 400 && /字段不合规/.test(e.message),
    '越界字段名必须在写入前被拒（不进库）',
  );
  const { rows } = queryAuditLog(db, { action: 'flag.detected' });
  assert.equal(rows.length, 0, '被拒的候选不得留下任何写入痕迹');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('TOP10 反向抽查任务：从结果里取前 N 名并带上签字信息（R-JDG-16）', () => {
  const results = Array.from({ length: 12 }, (_, i) => ({ teamId: `t${i + 1}`, rank: i + 1, total: 100 - i }));
  const signoffs = [{ teamId: 't1', signatoryUserId: 'u_sig', department: '业务部', content: '确认可落地', signedAt: '2026-10-19T00:00:00.000Z' }];
  const tasks = buildReverseAuditTasks({ results, signoffs, topN: 10 });
  assert.equal(tasks.length, 10);
  assert.equal(tasks[0].teamId, 't1');
  assert.equal(tasks[0].rank, 1);
  assert.equal(tasks[0].signoffs.length, 1);
  assert.equal(tasks[0].signoffs[0].department, '业务部');
  assert.ok(tasks[0].instruction.includes('电话回访'));
  assert.equal(tasks[0].action, 'alert_only', '反向抽查任务同样只告警，不代劳不自动结案');

  const fewer = buildReverseAuditTasks({ results, signoffs, topN: 3 });
  assert.equal(fewer.length, 3, 'topN 必须真的生效');
  assert.deepEqual(fewer.map((t) => t.rank), [1, 2, 3]);
});
```

`platform/test/field-dictionary.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAG_DETAIL_FIELDS, CONFIDENCE_LABELS, MUTUALLY_EXCLUSIVE,
  assertKnownFields, assertMutuallyExclusive, assertConfidenceLabel,
} from '../src/domain/field-dictionary.js';

test('字段字典为每一种 flag kind 定义了字段', () => {
  for (const kind of ['self_vs_judge', 'burst_submit', 'identical_peer_pattern', 'low_variance', 'multi_account', 'tied_mutual_peer_rate', 'reverse_audit']) {
    assert.ok(Array.isArray(FLAG_DETAIL_FIELDS[kind]), `缺 ${kind} 的字段定义`);
    assert.ok(FLAG_DETAIL_FIELDS[kind].length > 0, `${kind} 的字段不能为空`);
  }
});

test('未知字段名被拒绝（R-AUD-06：并行前先定字段字典）', () => {
  const errors = assertKnownFields('low_variance', { judgeId: 'j1', stdev: 1, 随便写的字段: 3 });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('随便写的字段'));
  assert.deepEqual(assertKnownFields('low_variance', { judgeId: 'j1', stdev: 1 }), []);
});

test('字典里没有定义的 flag kind 被拒绝（没定义就没闸 = 等于没闸）', () => {
  const errors = assertKnownFields('字典里没有的 kind', { judgeId: 'j1' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('未知的 flag kind'));
});

test('互斥字段名同时出现被拒绝（借鉴维度 vs 同样点/差异点）', () => {
  const errors = assertMutuallyExclusive({ 借鉴维度: 'A', 同样点: 'B' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('互斥'));
  assert.deepEqual(assertMutuallyExclusive({ 借鉴维度: 'A' }), []);
});

test('置信度只有一套标签', () => {
  assert.deepEqual(CONFIDENCE_LABELS, ['high', 'medium', 'low']);
  assert.equal(assertConfidenceLabel('high'), true);
  assert.equal(assertConfidenceLabel('probably-high'), false);
});

test('互斥组定义不为空', () => {
  assert.ok(MUTUALLY_EXCLUSIVE.length >= 1);
  assert.ok(MUTUALLY_EXCLUSIVE[0].fields.includes('借鉴维度'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/anticheat.test.js test/field-dictionary.test.js`
Expected: FAIL —— `Cannot find module '../src/domain/anticheat.js'`

- [ ] **Step 3: 创建 `src/domain/field-dictionary.js`**

```javascript
// src/domain/field-dictionary.js — 审计字段字典（唯一字段名来源）
// 依据：R-AUD-06「并行前定字段字典」
//   溯源：周报 2026-10-12~18 §4.2 教训 5 —— 字段互斥替换（"借鉴维度" vs "同样点/差异点"）、
//   置信度三套标签并行。同样的失败模式会在"多个检测器并行产出 flag"时重演。
//   → 字段名只有这一个来源；不在字典里的字段名在【写入前】就被拒绝，不进库。
// 纯函数常量与断言，无 IO。
//
// ⚠️ 字典的适用范围：**检测器产出的 flag 明细**（runDetection 写进 detail_json 的那份）。
//    「裁决」阶段由人追加的 resolution / evidence 不在检测明细范围内 —— 那是裁决记录，不是检测结论。
// ⛔ 每个 kind 的字段表必须**覆盖检测器实际写进 detail_json 的每一个键**：
//    少写一个键，runDetection 就会把**所有**检测产出判成「字段不合规」并抛 400，
//    检测器等于完全不能用（kind / action 是每个 flag 都带的两个固定键）。
export const FLAG_DETAIL_FIELDS = {
  self_vs_judge: ['kind', 'teamId', 'dimension', 'judgeScore', 'selfScore', 'delta', 'action'],
  burst_submit: ['kind', 'subjectId', 'count', 'windowStart', 'windowEnd', 'action'],
  identical_peer_pattern: ['kind', 'voterA', 'voterB', 'overlap', 'targets', 'matchRatio', 'action'],
  low_variance: ['kind', 'judgeId', 'dimension', 'stdev', 'n', 'mean', 'direction', 'action'],
  multi_account: ['kind', 'keyField', 'keyValue', 'userIds', 'count', 'action'],
  tied_mutual_peer_rate: ['kind', 'rank', 'tiedPairs', 'rate', 'threshold', 'action'],
  reverse_audit: ['kind', 'teamId', 'rank', 'total', 'signoffs', 'instruction', 'action'],
};

// 置信度标签只有这一套。（周报教训 5：并行任务曾各自造了三套置信度标签，最后无法合并）
export const CONFIDENCE_LABELS = ['high', 'medium', 'low'];

// 互斥字段组：同一份记录里只能出现其中一套。
export const MUTUALLY_EXCLUSIVE = [
  {
    group: 'inspiration',
    fields: ['借鉴维度', '同样点', '差异点'],
    message: '「借鉴维度」与「同样点/差异点」互斥，同一份记录只能用一个字段组',
  },
];

export function assertKnownFields(kind, detail) {
  const allowed = FLAG_DETAIL_FIELDS[kind];
  if (!allowed) return [`未知的 flag kind: ${kind}（字段字典里没有定义）`];
  const errors = [];
  for (const key of Object.keys(detail ?? {})) {
    if (!allowed.includes(key)) {
      errors.push(`字段名 "${key}" 不在 ${kind} 的字段字典里（允许：${allowed.join(', ')}）`);
    }
  }
  return errors;
}

export function assertMutuallyExclusive(detail) {
  const errors = [];
  for (const rule of MUTUALLY_EXCLUSIVE) {
    const hit = rule.fields.filter((f) => detail && detail[f] !== undefined && detail[f] !== null);
    if (hit.length > 1) {
      errors.push(`${rule.message}（本次出现：${hit.join(' / ')}）`);
    }
  }
  return errors;
}

export function assertConfidenceLabel(value) {
  return CONFIDENCE_LABELS.includes(value);
}
```

- [ ] **Step 4: 创建 `src/domain/evidence.js`**

```javascript
// src/domain/evidence.js — 证据三列规范化
// 依据：R-AUD-04「证据三列（URL/发行方/独立性），按发行方去重，不按 URL 计数」
//   溯源：evidence-chain Skill 闸 1。同一发行方的 10 条报道不是 10 个独立信源，是 1 个。
// 纯函数：无 IO、无 Date.now()、无 Math.random()。

export const EVIDENCE_COLUMNS = ['url', 'publisher', 'independent'];

export function normalizeEvidence({ items = [], requiredColumns = EVIDENCE_COLUMNS }) {
  const kept = [];
  const dropped = [];
  const violations = [];
  const seen = new Map(); // publisher → 已保留的记录

  for (const raw of items) {
    const item = raw ?? {};
    const missing = requiredColumns.filter((c) => {
      const v = item[c];
      return v === undefined || v === null || String(v).trim() === '';
    });
    if (missing.length) {
      // ⛔ 缺列必须显式报出来，不能悄悄扔掉（静默的空产出比报错更危险）
      violations.push({ item, missing });
      continue;
    }
    const publisher = String(item.publisher).trim();
    const key = publisher.toLowerCase();
    if (seen.has(key)) {
      dropped.push({ publisher, url: String(item.url).trim(), keptUrl: seen.get(key).url });
      continue;
    }
    const record = {
      url: String(item.url).trim(),
      publisher,
      independent: item.independent === true || item.independent === 'true',
    };
    seen.set(key, record);
    kept.push(record);
  }

  return {
    columns: requiredColumns,
    items: kept,
    uniquePublishers: kept.length,   // 按发行方计数，不按 URL
    dropped,
    violations,
  };
}
```

- [ ] **Step 5: 创建 `src/domain/anticheat.js`**

```javascript
// src/domain/anticheat.js — 防作弊检测器（纯函数层）
// 依据：设计文档 §11.1（防刷分与防串通）+ §3.4 零件 7（多账号协同检测是全行业空白）
//   R-RNK-08 异常互评检测（S10 §0.4「同分互投率过高由组委会复核」）
// ⛔ 检测 ≠ 处罚：本文件只产出 flag（"有疑问"），不改分、不封号、不自动裁决。
// 纯函数：无 IO、无 Date.now()、无 Math.random()。时间一律由入参给出。

function pickVoter(r) {
  return r.judgeId ?? r.fromId ?? r.voterId ?? null;
}

function pickTarget(r) {
  return r.teamId ?? r.toId ?? r.targetId ?? null;
}

function sign(a, b) {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * 两位评委对重叠项目给出完全相同的相对顺序 → 疑似串通。
 * 借鉴 Gavel 追加式决策日志的思路（AGPL，⛔ 只读思路独立实现）。
 */
export function detectIdenticalPeerPattern({ peerReviews = [], minOverlap = 3 }) {
  const byVoter = new Map();
  for (const r of peerReviews) {
    const voter = pickVoter(r);
    const target = pickTarget(r);
    if (voter === null || target === null) continue;
    if (!byVoter.has(voter)) byVoter.set(voter, new Map());
    byVoter.get(voter).set(target, Number(r.score));
  }

  const voters = [...byVoter.keys()].sort();
  const flags = [];
  for (let i = 0; i < voters.length; i += 1) {
    for (let j = i + 1; j < voters.length; j += 1) {
      const a = byVoter.get(voters[i]);
      const b = byVoter.get(voters[j]);
      const overlap = [...a.keys()].filter((t) => b.has(t));
      if (overlap.length < minOverlap) continue;

      let same = true;
      let compared = 0;
      for (let x = 0; x < overlap.length && same; x += 1) {
        for (let y = x + 1; y < overlap.length; y += 1) {
          const ta = overlap[x];
          const tb = overlap[y];
          compared += 1;
          if (sign(a.get(ta), a.get(tb)) !== sign(b.get(ta), b.get(tb))) {
            same = false;
            break;
          }
        }
      }
      if (same && compared > 0) {
        flags.push({
          kind: 'identical_peer_pattern',
          voterA: voters[i],
          voterB: voters[j],
          overlap: overlap.length,
          targets: overlap.slice().sort(),
          matchRatio: 1,
          action: 'alert_only',   // ⛔ 只告警，不处罚
        });
      }
    }
  }
  return { flags };
}

/**
 * 短时间窗口内突发提交。
 * 借鉴 hack-the-back app/services/judging.py 的思路（MIT），只读思路独立实现。
 */
export function detectBurstSubmission({ events = [], windowSeconds = 60, threshold = 5 }) {
  const bySubject = new Map();
  for (const e of events) {
    const subject = e.subjectId ?? e.judgeId ?? 'default';
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(at);
  }

  const flags = [];
  let maxCount = 0;
  for (const [subject, times] of bySubject) {
    times.sort((x, y) => x - y);
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while (times[end] - times[start] > windowSeconds * 1000) start += 1;
      const count = end - start + 1;
      if (count > maxCount) maxCount = count;
      if (count > threshold) {
        flags.push({
          kind: 'burst_submit',
          subjectId: subject,
          count,
          windowStart: new Date(times[start]).toISOString(),
          windowEnd: new Date(times[end]).toISOString(),
          action: 'alert_only',
        });
        break; // 同一主体只报一次（报最早的那次爆发）
      }
    }
  }
  return { flags, maxCount };
}

/**
 * 某评委 stddev 异常小/大 → 告警。
 * 依据：设计文档 §11.1「评委宽严异常 → 告警但不自动处罚」。
 * ⛔ 输出里带 action='alert_only'：这个边界写进数据本身，不只写在注释里。
 */
export function detectLowVariance({ scoreStats = [], threshold = { min: 0, max: Number.POSITIVE_INFINITY } }) {
  const min = typeof threshold === 'number' ? 0 : (threshold.min ?? 0);
  const max = typeof threshold === 'number' ? threshold : (threshold.max ?? Number.POSITIVE_INFINITY);
  const flags = [];

  for (const s of scoreStats) {
    const n = Number(s.n);
    const mean = Number(s.mean);
    const sumSq = Number(s.sum_sq);
    if (!Number.isFinite(n) || !Number.isFinite(mean) || !Number.isFinite(sumSq)) continue;
    const stdev = n > 1 ? Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1))) : 0;
    let direction = null;
    if (n > 1 && stdev < min) direction = 'too_low';
    else if (n > 1 && stdev > max) direction = 'too_high';
    if (!direction) continue;
    flags.push({
      kind: 'low_variance',
      judgeId: s.judgeId,
      dimension: s.dimension,
      stdev: Number(stdev.toFixed(6)),
      n,
      mean,
      direction,
      action: 'alert_only',
    });
  }
  return { flags };
}

/**
 * 同一手机号 / 同一企业注册多个账号。
 * 依据：设计文档 §11.1「⚠️ 全行业空白：没有任何一个开源项目做多账号协同投票检测」。
 */
export function detectMultiAccount({ users = [], keyFields = [] }) {
  const flags = [];
  for (const field of keyFields) {
    const groups = new Map();
    for (const u of users) {
      const raw = u?.[field];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const value = normalizeKeyValue(field, raw);
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(u.id);
    }
    for (const [value, ids] of groups) {
      const unique = [...new Set(ids)];
      if (unique.length < 2) continue;
      flags.push({
        kind: 'multi_account',
        keyField: field,
        keyValue: value,
        userIds: unique.slice().sort(),
        count: unique.length,
        action: 'alert_only',
      });
    }
  }
  return { flags };
}

// 手机号去掉分隔符与 +86 前缀；其余字段去掉首尾空白并小写
function normalizeKeyValue(field, raw) {
  const text = String(raw).trim();
  if (!text) return '';
  if (field.toLowerCase().includes('phone')) {
    let digits = text.replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2);
    return digits;
  }
  return text.toLowerCase();
}

/**
 * 同分队伍互投率过高 → 由组委会复核（R-RNK-08，S10 §0.4）。
 * ⛔ 互评来源不公示（S10 §0.3）——这份明细只进 admin 复核队列，不进任何公开接口。
 */
export function detectTiedMutualPeerRate({ peerReviews = [], results = [], threshold = 0.8 }) {
  const byRank = new Map();
  for (const r of results) {
    const rank = Number(r.rank);
    if (!Number.isFinite(rank)) continue;
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(r.teamId);
  }

  const pairs = new Set();
  for (const r of peerReviews) {
    const from = r.fromId ?? r.judgeId ?? null;
    const to = r.toId ?? r.teamId ?? null;
    if (!from || !to) continue;
    pairs.add(`${from}>${to}`);
  }

  const flags = [];
  for (const [rank, teams] of byRank) {
    if (teams.length < 2) continue;
    const tiedPairs = [];
    let mutual = 0;
    for (let i = 0; i < teams.length; i += 1) {
      for (let j = i + 1; j < teams.length; j += 1) {
        const a = teams[i];
        const b = teams[j];
        const forward = pairs.has(`${a}>${b}`);
        const backward = pairs.has(`${b}>${a}`);
        if (forward && backward) {
          mutual += 1;
          tiedPairs.push([a, b]);
        }
      }
    }
    if (mutual === 0) continue;
    // ⛔ 预审修正（P4-T4-D3）：分母必须是**同分组内的全部候选对**，不是「互投的对数」。
    //    原来写 mutual / tiedPairs.length —— tiedPairs 只装互投的对，于是分母 == 分子，
    //    rate 恒等于 1，threshold 形同虚设（阈值调到 0.99 照样报）。
    //    现在的口径：rate = 互投对数 / 同分组全部候选对数（C(n,2)）。
    const candidatePairs = (teams.length * (teams.length - 1)) / 2;
    const rate = mutual / candidatePairs;
    if (rate < threshold) continue;
    flags.push({
      kind: 'tied_mutual_peer_rate',
      rank,
      tiedPairs,
      rate: Number(rate.toFixed(4)),
      threshold,
      action: 'alert_only',
    });
  }
  return { flags };
}
```

- [ ] **Step 6: 创建 `src/services/anticheat.js`**

```javascript
// src/services/anticheat.js — 检测编排与复核队列
// 依据：设计文档 §11.1（检测 → 进人工复核队列）、§9（组委会视角的复核/申诉/改级）
//   R-RNK-08 异常互评检测、R-JDG-16 TOP10 反向抽查
// ⛔ 检测 ≠ 处罚：runDetection 只建 flag（status='open'），不改分、不封号、不自动裁决。
//   裁决是人的动作（resolveFlag），且必须留审计日志。
import {
  detectIdenticalPeerPattern, detectBurstSubmission, detectLowVariance,
  detectMultiAccount, detectTiedMutualPeerRate,
} from '../domain/anticheat.js';
import { normalizeEvidence } from '../domain/evidence.js';
import { assertKnownFields, assertMutuallyExclusive } from '../domain/field-dictionary.js';
import { createFlag, listFlagRows, resolveFlagRow } from '../db/repo/flags.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { badRequest, notFound } from '../errors.js';

/**
 * 稳定序列化（键名排序）——用来比较两份 flag 明细是不是「同一个问题」。
 * 不排序的话，键顺序不同但内容相同的明细会被判成两个问题。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 「同一个问题」的判定：同 kind + 同赛段 + **同明细内容**。
 *
 * ⛔ 预审修正（P4-T4-D4）：原来用 (kind, stage_id, team_id, judge_id) 这个粗键去重。
 *    那个键分不开「同 kind 的不同问题」——两个不同的多账号分组（138…001 / 138…002）
 *    在粗键下 team_id / judge_id 都是 NULL → 第二个被当成「重复」丢掉；
 *    同一位评委的**两个维度**方差异常同理（judge_id 相同、dimension 不同）。
 *    丢掉的不是重复项，是**真问题** —— 防作弊检测漏报。改成按明细内容判定。
 */
function isSameFinding(row, flag, stageId) {
  if ((row.stage_id ?? null) !== (stageId ?? null)) return false;
  let detail = null;
  try {
    detail = row.detail_json ? JSON.parse(row.detail_json) : null;
  } catch {
    return false;   // 明细坏掉 → 不当成同一个问题（宁可多建一条让人看，也不漏）
  }
  return canonicalJson(detail) === canonicalJson(flag);
}

/**
 * 逐页扫 flagged_reviews。
 * ⚠️ 仓储层的 listFlagRows 默认只回 100 条 —— 一次查全表再 find 会漏，
 *    漏掉的 flag 会被误判成「不存在」（404），或让去重失效（重复建 flag）。所以要翻页。
 */
function scanFlags(db, filter, match) {
  const LIMIT = 200;
  for (let offset = 0; ; offset += LIMIT) {
    const { rows } = listFlagRows(db, { ...filter, limit: LIMIT, offset });
    for (const row of rows) {
      const hit = match(row);
      if (hit) return hit;
    }
    if (rows.length < LIMIT) return null;
  }
}

/**
 * 字段字典闸（R-AUD-06）：返回这条 flag 明细的**全部**违规（空数组 = 合规）。
 * ⛔ 单独抽成导出函数：这条闸是「不在字典里的字段名不进库」的唯一执行点，
 *    抽出来才能被单独测到（不然只能靠「检测器恰好产出越界字段」这种偶然路径）。
 */
export function assertFlagDetail(flag) {
  return [...assertKnownFields(flag.kind, flag), ...assertMutuallyExclusive(flag)];
}

/**
 * 跑一遍全部检测器，把命中的问题写进 flagged_reviews（status='open'）。
 * @param {object[]} extraCandidates 扩展点：额外候选 flag（默认空）。
 *   给「还没进检测器模块的新检测器」用；同时给「字段字典闸」一条可测的入口 ——
 *   候选里带越界字段 → 必须被 400 挡住，不进库（R-AUD-06）。
 * @returns {{ created: Array, skipped: Array }}
 */
export function runDetection({
  db, stageId = null, peerReviews = [], events = [], scoreStats = [], results = [],
  users = [], rules, now = new Date().toISOString(), extraCandidates = [],
}) {
  const antiCheat = rules?.audit?.antiCheat ?? {};
  const created = [];
  const skipped = [];

  const candidates = [
    ...detectIdenticalPeerPattern({ peerReviews, minOverlap: antiCheat.identicalPeer?.minOverlap ?? 3 }).flags,
    ...detectBurstSubmission({
      events,
      windowSeconds: antiCheat.burst?.windowSeconds ?? 60,
      threshold: antiCheat.burst?.threshold ?? 5,
    }).flags,
    ...detectLowVariance({ scoreStats, threshold: antiCheat.lowVariance ?? { min: 0, max: Infinity } }).flags,
    ...detectMultiAccount({ users, keyFields: antiCheat.multiAccount?.keyFields ?? [] }).flags,
    ...detectTiedMutualPeerRate({
      peerReviews, results, threshold: antiCheat.tiedMutualPeerRate?.threshold ?? 0.8,
    }).flags,
    ...extraCandidates,
  ];

  for (const flag of candidates) {
    // 字段字典校验：不在字典里的字段名不进库（R-AUD-06）
    const fieldErrors = assertFlagDetail(flag);
    if (fieldErrors.length) {
      throw badRequest(`flag 明细字段不合规（${flag.kind}）：${fieldErrors.join('；')}`);
    }
    const judgeId = flag.judgeId ?? flag.voterA ?? flag.subjectId ?? null;
    const teamId = flag.teamId ?? (flag.tiedPairs?.[0]?.[0] ?? null);
    const existing = scanFlags(
      db,
      { status: 'open', kind: flag.kind },
      (row) => (isSameFinding(row, flag, stageId) ? row : null),
    );
    if (existing) {
      skipped.push({ kind: flag.kind, reason: '已存在未决 flag，不重复建', flagId: existing.id });
      continue;
    }
    const id = createFlag(db, {
      stageId, teamId, judgeId, kind: flag.kind, detail: flag, status: 'open', now,
    });
    writeAuditLog(db, {
      action: 'flag.detected',
      entity: 'flag',
      entityId: id,
      detail: { kind: flag.kind, stageId, teamId, judgeId, action: flag.action ?? 'alert_only' },
      now,
    });
    created.push({ id, kind: flag.kind, detail: flag });
  }

  return { created, skipped };
}

/**
 * 裁决一条 flag。必须给理由与证据（可空数组），并写审计日志。
 */
export function resolveFlag({
  db, flagId, status, reviewerId = null, reason, evidence = [], now = new Date().toISOString(),
}) {
  if (!['confirmed', 'rejected'].includes(status)) {
    throw badRequest(`裁决状态只能是 confirmed 或 rejected，收到：${status}`);
  }
  if (!reason || !String(reason).trim()) {
    throw badRequest('裁决必须写理由（无理由的裁决无法复盘）');
  }
  const row = scanFlags(db, {}, (r) => (r.id === flagId ? r : null));
  if (!row) throw notFound(`复核项不存在: ${flagId}`);
  if (row.status !== 'open') {
    throw badRequest(`复核项 ${flagId} 已裁决（当前状态 ${row.status}），不得二次裁决`);
  }

  // 证据三列：缺列直接报错；按发行方去重（R-AUD-04）
  const normalized = normalizeEvidence({ items: evidence });
  if (normalized.violations.length) {
    throw badRequest(
      `证据缺列，必须补齐 URL / 发行方 / 独立性：${normalized.violations.map((v) => `缺 ${v.missing.join(',')}`).join('；')}`,
    );
  }

  const oldDetail = row.detail_json ? JSON.parse(row.detail_json) : {};
  const detail = {
    ...oldDetail,
    resolution: { status, reason, reviewerId, decidedAt: now },
    evidence: normalized,
  };
  const changes = resolveFlagRow(db, {
    id: flagId, status, reviewedBy: reviewerId, reviewedAt: now, detail,
  });
  if (changes !== 1) throw notFound(`复核项不存在: ${flagId}`);

  writeAuditLog(db, {
    actorId: reviewerId,
    action: 'flag.resolve',
    entity: 'flag',
    entityId: flagId,
    detail: { status, reason, uniquePublishers: normalized.uniquePublishers, dropped: normalized.dropped.length },
    now,
  });

  return { id: flagId, kind: row.kind, status, detail };
}

/**
 * 复核队列列表。列表不满足 → 200 + 空集。
 */
export function listFlags({ db, filter = {}, viewer = null }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0 };
  const { rows, total } = listFlagRows(db, filter);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      stageId: r.stage_id,
      teamId: r.team_id,
      judgeId: r.judge_id,
      kind: r.kind,
      status: r.status,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
    })),
    total,
  };
}

/**
 * TOP10 反向抽查任务（R-JDG-16，S7 §4.1「组委会对 TOP10 作品电话回访」）。
 * 只生成任务，不代劳、不自动结案。
 */
export function buildReverseAuditTasks({ results = [], signoffs = [], topN = 10, instruction = '电话回访 TOP 名单，确认签字人理解与签字内容一致' }) {
  const sorted = [...results].sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, topN);
  return sorted.map((r) => ({
    teamId: r.teamId,
    rank: Number(r.rank),
    total: r.total,
    signoffs: signoffs.filter((s) => s.teamId === r.teamId),
    instruction,
    // ⛔ 检测 ≠ 处罚：反向抽查任务同样只告警、不代劳、不自动结案（把边界写进数据本身）
    action: 'alert_only',
  }));
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/anticheat.test.js test/field-dictionary.test.js`
Expected: PASS（anticheat **34** 个 + field-dictionary **6** 个全过 = 40 个）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/domain/anticheat.js src/domain/evidence.js src/domain/field-dictionary.js src/services/anticheat.js test/anticheat.test.js test/field-dictionary.test.js
git commit -m "feat(P4): 五个防作弊检测器、证据三列去重与审计字段字典（只告警不处罚）"
```

---

## Task 4 父代理预审修正台账（2026-10-21）

> Task 4 是 P4 的**检测器**层：五个检测器 + 证据三列 + 字段字典 + 复核队列。
> 规格自带的 15 + 5 条用例**实测 3 红**；顺着这 3 条红往下挖，共实证 **10 处规格缺陷**
> （**4 Critical / 3 Important / 3 Minor**），全部处置；随后做**独立变异检验**：
> 变异体 **47** → 首轮存活 7（其中 **5 条是真实覆盖缺口**，补用例后杀掉）→
> **KILLED 45 / 等价 2 / 有效缺口 0**。
> ⛔ **检测 ≠ 处罚**：这条边界同时钉在三处 —— 代码注释、**数据字段**（每个 flag 都带
> `action='alert_only'`）、验收标准（P4-7 的 grep 无命中）。

### 一、预审发现的规格缺陷

| # | 级别 | 缺陷 | 实跑证据（命令 + 关键输出） | 处置 |
|---|---|---|---|---|
| **P4-T4-D1** | **Critical** | **「相对顺序相同」的判别性数据集给反了** —— 两处用例里 j2 的打分（60/70/80）与 j1（90/80/70）相对顺序**正好相反**；检测器判「顺序不一致 → 不串通」是对的，用例却期望报 1 条 | `node --test test/anticheat.test.js`（照抄计划的实现）→ `not ok 1 - 互评相对顺序完全相同 → 疑似串通，进复核队列`（expected 1, actual 0）、`not ok 12 - runDetection 把检测结果写进 flagged_reviews…`（expected 1, actual 0）；探针 5：j1 顺序 `t1>t2>t3` / j2 顺序 `t3>t2>t1` / 同序=`false` | 改判别性数据集：j2 改成 **60/50/40**（同序、但绝对分差一大截，不是照抄分数）。两处都改 |
| **P4-T4-D2** | **Critical** | **字段字典少了每个 flag 都带的固定键 `kind` / `action`**（外加 `tied_mutual_peer_rate.rank`、`reverse_audit.total`）→ runDetection 拿**检测器自己的产出**去过字典闸，结果**每一个**检测结果都被判「字段不合规」抛 400 —— 检测器等于完全不能用 | 探针 2：5 个 kind 全部报错（`burst_submit` 报 `"kind"` 与 `"action"` 不在字典里…）；实跑 `not ok 13` → `error: 'flag 明细字段不合规（burst_submit）：字段名 "kind" 不在 burst_submit 的字段字典里（允许：subjectId, count, windowStart, windowEnd）'` | 字典补齐 `kind`/`action`/`rank`/`total`；字典头部写死规矩：「字段表必须**覆盖检测器实际写进 detail_json 的每一个键**，少写一个键 = 全部检测产出被拒」 |
| **P4-T4-D3** | **Critical** | **仓储函数调用签名错** —— 计划写 `findOpenFlag({ db, kind, … })`（单对象），Task 1 的签名是 `findOpenFlag(db, { kind, … })` → 解构 undefined → **TypeError**（不是 AppError → 500） | 探针实跑：`TypeError: Cannot destructure property 'kind' of 'undefined' as it is undefined at findOpenFlag (src/db/repo/flags.js:21:36) at runDetection (src/services/anticheat.js:51:22)` | 去重改走 `listFlagRows` 的逐页扫描（见 D4），不再调用 `findOpenFlag`；仓储层该函数保留不动 |
| **P4-T4-D4** | **Important** | **去重键太粗 → 同 kind 的不同问题被当成「重复」丢掉**（漏报）。粗键 `(kind, stage_id, team_id, judge_id)` 分不开「两个不同的多账号分组」（team_id / judge_id 都是 NULL）与「同一评委的两个维度方差异常」 | 探针 3：两个分组 138…001 / 138…002 → `created=1`、`skipped=[{kind:'multi_account', reason:'已存在未决 flag，不重复建'}]`（**第二个真问题被丢了**）；探针 4：同一评委两个维度 → `created=1`、`skipped=1` | 去重口径改为「**同 kind + 同赛段 + 同明细内容**」（明细按稳定序列化比较，键排序）；并补用例锁死（见变异表 M2） |
| **P4-T4-D5** | **Important** | **同分互投率的分母写成「互投的对数」**（`mutual / tiedPairs.length`）→ 分母 == 分子 → **rate 恒为 1**，threshold 形同虚设 | 探针 1：3 支同分队伍、候选对 3 组、互投 2 组（真实互投率 2/3 = 0.6667）→ 阈值 0.8 仍报，`rate=1`；探针 1b：阈值调到 **0.99 仍报** | 分母改为**同分组全部候选对** C(n,2)；补「阈值两侧都可测」的判别性用例（0.6667 vs 阈值 0.8 不报 / 0.6 报；以及恰好 0.8 要报） |
| **P4-T4-D6** | **Critical** | **规格用例没建被外键引用的行** —— 裁决时用 `reviewerId='u_admin'` 写审计日志，但 `audit_log.actor_id REFERENCES users(id)` → **FOREIGN KEY constraint failed** | 实跑 `not ok 13` → `error: 'FOREIGN KEY constraint failed' at insertAuditLogRow (src/db/repo/audit-log.js:19:5) at writeAuditLog (src/audit/log.js:10:14) at resolveFlag` | 测试加 `seedRefs(db)` 造出 `u_admin`（与 P4 Task 1 的 `audit-repo.test.js` **同一个坑**，同一套写法） |
| **P4-T4-D7** | Minor | 规格用例注释里的 stdev「≈ 47」与实际不符 | 探针 6：注释声称 47 / 实际 **75.2773**（n=10, mean=70, sum_sq=100000 → √(5666.67)） | 注释与断言改成实际值 `75.277265`（`toFixed(6)` 后的值） |
| **P4-T4-D8** | Minor | 裁决用 `listFlagRows(db, { limit: 1000 })` 一次查全表再 `find` → 超过 1000 条 flag 时目标不在结果里 → **误报 404**、去重也失效 | 代码 review（计划 `src/services/anticheat.js` 裁决段）：仓储 `listFlagRows` 默认 limit 100，计划写死 1000 | 改为**逐页扫描**（`scanFlags`，每页 200 条），上限不再是硬编码 |
| **P4-T4-D9** | Minor | Interfaces 写 `runDetection → { created, skipped, flags }`，实现从来只返回**前两个键** —— 写接口契约就是错的 | 计划 Interfaces 行 vs 实现 `return { created, skipped }` | 改 Interfaces 为 `{ created, skipped }`；另补 `extraCandidates`（扩展点）说明 |
| **P4-T4-D10** | Minor | 反向抽查任务的产出**没有 `action` 字段** → 若被做成 flag，P4-7「所有 flag 的 action='alert_only'」就不成立 | 计划 `buildReverseAuditTasks` 返回字段 | 任务产出补 `action: 'alert_only'`（边界写进数据本身），并补断言 |

### 二、变异检验发现的实现盲区

> 变异体 **47** 个（5 个检测器 / 证据三列 / 字段字典 / 服务层编排与裁决 / 复核队列 / 反向抽查）。
> 变异脚本：`/tmp/p4t4/mutate.mjs`（跑在 `/tmp` 副本上，指向**已落地**的测试文件；
> 锚点必须在目标文件里**只出现一次**，命中 2 次即报错不执行）。

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P4-T4-M1** | Important | **「同一主体只报一次」的 `break` 从来没被验过** —— 删掉它，循环里每个越过阈值的 end 都会再报一次（4 次提交 → 3 条 flag） | 变异存活：删掉 `break` 后 40 条用例全绿 | 补用例：窗口内 **6** 次提交、阈值 3 → 必须只报 1 条（首轮数据只有 4 次提交，删掉 break 结果**恰好一样**） |
| **P4-T4-M2** | Important | **复核队列的权限判定没被验过** —— 用例里队列本来是**空的**，"有权"与"无权"的结果都是空集，测不出判定有没有生效 | 变异存活：把 `can(viewer,'audit:read',…)` 换成 `true` 后 40 条用例全绿 | 补用例：**队列里先有东西**再问权限（无权 → 空集，有权 → 1 条，同一个库） |
| **P4-T4-M3** | Important | **检测留痕（`flag.detected` 审计日志）没被验过** —— 只有 `flag.resolve` 有断言 | 变异存活：把 `action:'flag.detected'` 改名后 40 条用例全绿 | 补断言：每次检出写 1 条 `flag.detected`，且 `entity_id` 对上 flagId |
| **P4-T4-M4** | Minor | **明细比较的「键排序」没被验过** —— 不排序就只在「键顺序恰好一致」时成立 | 变异存活：`canonicalJson` 去掉 `.sort()` 后 40 条用例全绿 | 补用例：库里塞一条**键顺序不同**的同一份明细 → 不得重建 flag |
| **P4-T4-M5** | Minor | **互评的 `fromId/toId` 别名没被验过** —— `pickVoter/pickTarget` 认三套别名，测试只用了 `judgeId/teamId` | 变异存活：`pickTarget` 退回只认 `teamId` 后 40 条用例全绿 | 补用例：用别名写法跑一遍，必须同样检出 |
| **P4-T4-M6** | — | 空手机号不再跳过（`String(raw).trim()===''` 那道检查摘掉） | 差分实证（`/tmp/p4t4/equiv-probe.mjs`）：原版与变异版输出**逐字相同** —— `normalizeKeyValue` 对空/空白返回 `''`，下一道 `if (!value) continue;` 照样跳过 | **等价变异体**（不可观测，不是测试的漏洞）；保留原实现（多一道防御） |
| **P4-T4-M7** | — | 同分组「只允许 2 支以上」改成「1 支以上」 | 差分实证：单队分组里 `i<j` 循环不执行 → `mutual=0` → `if (mutual===0) continue;` → 原版与变异版输出**逐字相同**（均 `{"flags":[]}`） | **等价变异体**（不可观测） |

### 三、刻意保持的行为（登记口径）

| 行为 | 为什么这样 |
|---|---|
| **服务层保留阈值兜底值**（minOverlap 3 / windowSeconds 60 / threshold 5 / tied 0.8） | 与 INTERFACES §0「可变规则一律进 rules/*.json」有偏差，但真值由 **Task 3 的 `rules/audit.json`** 提供（`rules.audit.antiCheat`），这里的常量只是 `rules` 缺失时的兜底。**不改成 fail-fast** —— 规格的接口是 `rules` 可选，缺配置就静默按默认跑是既有口径，Task 3 落地后即由配置接管 |
| **字段字典的适用范围 = 检测器产出的 flag 明细** | 裁决阶段由人追加的 `resolution` / `evidence` 不在字典范围内 —— 那是**裁决记录**，不是检测结论；字典管的是「检测器能写什么字段名」 |
| **字段字典闸是逐条校验**（一条越界 → 整批抛 400） | 越界字段名在**写入前**被拒（不进库）。此时本批已写的 flag 是 open 状态，重跑会被去重跳过 → 不会重复建，语义安全 |
| **去重口径 = 同 kind + 同赛段 + 同明细内容** | 粗键会漏报（见 D4）。明细用稳定序列化（键排序）比较 → 旧版本写下的、键顺序不同的同一份明细也能认出来 |
| **反向抽查任务不是 flag** | 它是「给人做的任务」，带 `action='alert_only'`；要不要落 `flagged_reviews` 是 Task 6 的事，本阶段不落库 |

**Task 4 的测试条数口径**：anticheat **34**（规格自带 15 + 预审补 19）；field-dictionary **6**（规格自带 5 + 预审补 1）= 本阶段新增 **40** 条。

**最终结果**：变异体 47 → **KILLED 45 / SURVIVED 2（均为等价变异体，探针差分实证）/ 有效缺口 0**；
`anticheat.test.js` **34/34**、`field-dictionary.test.js` **6/6**；P4 全量 **766/766**（Task 1 后基线 726/766 → 726/726）；
迁移到版本 **5**；P4-7 的 `grep -n "UPDATE stage_reviews\|deactivateUser\|DELETE FROM users"` **无命中**（退出码 1）。

---

### Task 5: 复核与申诉状态机

**Files:**
- Create: `platform/src/services/review-state.js`
- Modify: `platform/src/db/repo/tiers.js`（**P3 Task 7 已建**；本阶段**追加**降级查询函数，不重建文件）
- Test: `platform/test/review-state.test.js`

**Interfaces:**
- Consumes: Task 1 的 `findLatestTransition` / `insertAppeal` / `getAppeal` / `listAppealRows` / `updateAppeal` / `withIdempotency` / `writeAuditLog`；P3 的 `tier_records` 表
- Produces:
  - `REVIEW_STATES` / `REVIEW_TRANSITIONS`（状态与合法迁移表）
  - `getSubjectState({ db, subjectType, subjectId })` → `string | null`
  - `transition({ db, subjectType, subjectId, from, to, actorId, reason, idempotencyKey, now })` → `{ applied, from, to, state, at }`
  - `filterVisibleScores({ db, stageId, viewer, scores })` → 过滤后的分数数组
  - `fileAppeal({ db, subjectType, subjectId, filedBy, reason, now, rules })` → appeal
  - `decideAppeal({ db, appealId, decision, decidedBy, note, now, rules })` → `{ appeal, transitions, recomputeRequired }`
  - `listAppeals({ db, filter, viewer })` → `{ rows, total }`
  - `parseAppealSubject(subjectId)` → `{ stageId, teamId }`

- [ ] **Step 1: 写失败的测试**

`platform/test/review-state.test.js`：

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
  transition, getSubjectState, filterVisibleScores,
  fileAppeal, decideAppeal, listAppeals, parseAppealSubject, REVIEW_STATES,
} from '../src/services/review-state.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const RULES = {
  audit: {
    reviewState: { appealSubjectType: 'team_result', appealAllowedTiers: ['D'] },
  },
};

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4rs-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

function seedTier(db, teamId, tier) {
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(`tr_${teamId}`, teamId, tier, 0, 0, '[]', '2026-10-20T00:00:00.000Z');
}

test('状态机：合法迁移成功并写审计日志', () => {
  const { db, close, dataDir } = setup();
  const r = transition({
    db, subjectType: 'stage_result', subjectId: 'st1',
    from: 'SUBMITTED', to: 'PENDING_REVIEW', actorId: 'u_admin', reason: '待复核',
    idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(r.applied, true);
  assert.equal(r.to, 'PENDING_REVIEW');
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'PENDING_REVIEW');
  const { rows } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail_json);
  assert.equal(detail.from, 'SUBMITTED');
  assert.equal(detail.to, 'PENDING_REVIEW');
  assert.equal(detail.reason, '待复核');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：非法迁移被拒（SUBMITTED 不能直接跳 FINALIZED）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1',
      from: 'SUBMITTED', to: 'FINALIZED', actorId: 'u_admin', reason: 'x',
      idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
    }),
    (e) => e.status === 409 && /非法迁移/.test(e.message),
  );
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), null, '被拒的迁移不得落库');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('状态机：from 与当前状态不一致时拒绝（防并发覆盖）', () => {
  const { db, close, dataDir } = setup();
  transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: 'x', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  assert.throws(
    () => transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'CONFIRMED',
      actorId: 'u_admin', reason: 'y', idempotencyKey: 'k2', now: '2026-10-20T00:00:01.000Z',
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('幂等守卫：同一 idempotencyKey 重复触发不产生二次迁移', () => {
  const { db, close, dataDir } = setup();
  const args = {
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: '待复核', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  };
  const first = transition(args);
  const second = transition(args);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false, '重复触发不得产生二次迁移');
  const { rows } = queryAuditLog(db, { action: 'review_state.transition' });
  assert.equal(rows.length, 1, '审计日志里只能有一条迁移记录');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('PENDING_REVIEW 的分数对其他评委不可见（API 层过滤，不是前端隐藏）', () => {
  const { db, close, dataDir } = setup();
  transition({
    db, subjectType: 'stage_result', subjectId: 'st1', from: 'SUBMITTED', to: 'PENDING_REVIEW',
    actorId: 'u_admin', reason: '待复核', idempotencyKey: 'k1', now: '2026-10-20T00:00:00.000Z',
  });
  const scores = [
    { judgeId: 'j1', teamId: 't1', rawScore: 80 },
    { judgeId: 'j2', teamId: 't1', rawScore: 90 },
  ];
  const asJudge = filterVisibleScores({
    db, stageId: 'st1', viewer: { id: 'j1', is_superadmin: 0, active: 1 }, scores,
  });
  assert.equal(asJudge[0].rawScore, 80, '自己的分看得到');
  assert.equal(asJudge[1].rawScore, null, '别人的分看不到');
  assert.equal(asJudge[1].hidden, true);

  const asAdmin = filterVisibleScores({
    db, stageId: 'st1', viewer: { id: 'u_admin', is_superadmin: 1, active: 1 }, scores,
  });
  assert.equal(asAdmin[1].rawScore, 90, '组委会看得到全部');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('FINALIZED 之后分数对其他评委恢复可见', () => {
  const { db, close, dataDir } = setup();
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  const scores = [{ judgeId: 'j2', teamId: 't1', rawScore: 90 }];
  const asJudge = filterVisibleScores({
    db, stageId: 'st1', viewer: { id: 'j1', is_superadmin: 0, active: 1 }, scores,
  });
  assert.equal(asJudge[0].rawScore, 90);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：理由为空直接报错（空结果必须显式报错）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
      reason: '   ', now: '2026-10-20T00:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 400,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：只能对"已 FINALIZED 且处于低可见档"的条目提出', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  seedTier(db, 't2', 'B');
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  // D 段（低可见档）→ 允许
  const ok = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  assert.equal(ok.status, 'submitted');
  // B 段（已公示档）→ 拒绝
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t2', filedBy: 'u_captain',
      reason: '我不服', now: '2026-10-20T01:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 403,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉：未 FINALIZED 的条目不能申诉', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  assert.throws(
    () => fileAppeal({
      db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
      reason: '还没定稿就申诉', now: '2026-10-20T01:00:00.000Z', rules: RULES,
    }),
    (e) => e.status === 409,
  );
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('申诉成立 → 撤销终稿并要求 revision + 1 重算（旧 revision 保留）', () => {
  const { db, close, dataDir } = setup();
  seedTier(db, 't1', 'D');
  const steps = [
    ['SUBMITTED', 'PENDING_REVIEW', 'k1'],
    ['PENDING_REVIEW', 'CONFIRMED', 'k2'],
    ['CONFIRMED', 'FINALIZED', 'k3'],
  ];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  const appeal = fileAppeal({
    db, subjectType: 'team_result', subjectId: 'st1:t1', filedBy: 'u_captain',
    reason: '企业确认分与事实不符', now: '2026-10-20T01:00:00.000Z', rules: RULES,
  });
  const out = decideAppeal({
    db, appealId: appeal.id, decision: 'accepted', decidedBy: 'u_admin',
    note: '成立，重算', now: '2026-10-20T02:00:00.000Z', rules: RULES,
  });
  assert.equal(out.appeal.status, 'accepted');
  assert.equal(out.recomputeRequired, true);
  assert.equal(getSubjectState({ db, subjectType: 'stage_result', subjectId: 'st1' }), 'PENDING_REVIEW');
  const { rows } = queryAuditLog(db, { action: 'appeal.decided' });
  assert.equal(rows.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('parseAppealSubject 能拆出 stageId 与 teamId', () => {
  const p = parseAppealSubject('st9:t7');
  assert.equal(p.stageId, 'st9');
  assert.equal(p.teamId, 't7');
});

test('REVIEW_STATES 覆盖设计文档 §11.2 的全部状态', () => {
  for (const s of ['SUBMITTED', 'PENDING_REVIEW', 'CONFIRMED', 'FINALIZED', 'REJECTED', 'FLAGGED']) {
    assert.ok(REVIEW_STATES.includes(s), `缺状态 ${s}`);
  }
});

test('申诉列表：无权访问返回空集', () => {
  const { db, close, dataDir } = setup();
  const r = listAppeals({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(r.rows, []);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/review-state.test.js`
Expected: FAIL —— `Cannot find module '../src/services/review-state.js'`

- [ ] **Step 3: 追加 `src/db/repo/tiers.js` 的只读查询**

`platform/src/db/repo/tiers.js` 由 **P3 的 Task 7 建立**（已含 `insertTierRecord(db, { id, teamId, tier, milestoneCount, businessSignoffCount, reasonsJson, computedAt })` 及其他段位仓储）。
本阶段**只追加一个只读函数**，**不重建文件、不重复定义 `insertTierRecord`**：

```javascript
// src/db/repo/tiers.js —— 【追加】到 P3 已建的文件里
// 依据：设计文档 §6.5（段位表）+【冲突】C-02（C 段及以上公示名次，D 段只公示个人进度）
//   表由 P3 的 004_leaderboard.sql 建好；P4 只读（申诉范围判定需要知道档位）。
// ⚠️ 命名带 Row 后缀，是为了避开 P3 服务层已导出的 `getTeamTier({ db, teamId, viewer, rules })`，
//    两者职责不同：这里是纯仓储读取（无可见性过滤），那里是带权限与规则的服务层函数。
export function getTeamTierRow(db, teamId) {
  const row = db.prepare(
    'SELECT tier FROM tier_records WHERE team_id = ? AND deleted_at IS NULL ORDER BY computed_at DESC LIMIT 1',
  ).get(teamId);
  return row?.tier ?? null;
}
```

⚠️ **段位写入（`insertTierRecord`）一律走 P3 的版本**（参数名是 `reasonsJson`，不是 `reasons`）。
两个版本并存时，参数名不同会导致 `reasons` 静默变成 `undefined` → 段位降级原因丢失、无法公示（R-PTS-04「降级须公示」会破）。

- [ ] **Step 4: 创建 `src/services/review-state.js`**

```javascript
// src/services/review-state.js — 复核与申诉状态机
// 依据：设计文档 §11.2（人工复核与申诉状态机）
//   SUBMITTED → PENDING_REVIEW → CONFIRMED → FINALIZED
//               ↘ REJECTED ←（选手申诉）──┘
//               ↘ FLAGGED（疑似刷分/串通）→ REJECTED | CONFIRMED
//   借鉴 OpenReview 的状态机思路（MIT）：分阶段 + 幂等守卫（只处理首次 edit）。
// 三条硬规则：
//   ① PENDING_REVIEW 的分数对其他评委/企业不可见 → 必须在【API 层】过滤，前端隐藏 = 已泄露
//   ② 每次状态迁移写 audit_log(from_state, to_state, reason, at) → 否则申诉无法复盘
//   ③ 幂等守卫：重复触发不产生二次迁移
//   ④ 申诉触发 revision + 1 重算，不覆盖历史（旧 revision 保留）
import { findLatestTransition } from '../db/repo/audit-log.js';
import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';
import { insertAppeal, getAppeal, listAppealRows, updateAppeal } from '../db/repo/appeals.js';
import { getTeamTierRow } from '../db/repo/tiers.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

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

export function parseAppealSubject(subjectId) {
  const idx = String(subjectId ?? '').indexOf(':');
  if (idx < 0) return { stageId: null, teamId: String(subjectId ?? '') };
  return { stageId: subjectId.slice(0, idx), teamId: subjectId.slice(idx + 1) };
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

  const at = now;
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
 * 分数可见性过滤（必须在 API 层调用，不是前端隐藏）。
 * PENDING_REVIEW 期间，分数对其他评委/企业不可见。
 */
export function filterVisibleScores({ db, stageId, viewer = null, scores = [] }) {
  const state = getSubjectState({ db, subjectType: 'stage_result', subjectId: stageId });
  if (state !== 'PENDING_REVIEW') return scores;

  const privileged = viewer ? can(viewer, 'audit:read', null, db) : false;
  return scores.map((s) => {
    if (privileged) return s;
    if (viewer && s.judgeId && s.judgeId === viewer.id) return s;
    return { ...s, rawScore: null, hidden: true, hiddenReason: 'pending_review' };
  });
}

/**
 * 提交申诉。范围：已 FINALIZED 且处于低可见档的条目（设计文档 §11.2）。
 */
export function fileAppeal({
  db, subjectType = 'team_result', subjectId, filedBy = null, reason, now = new Date().toISOString(), rules,
}) {
  if (!subjectId) throw badRequest('申诉必须给 subjectId');
  if (!reason || !String(reason).trim()) throw badRequest('申诉必须写理由（空理由 = 无法复核）');

  const { stageId, teamId } = parseAppealSubject(subjectId);
  const state = stageId ? getSubjectState({ db, subjectType: 'stage_result', subjectId: stageId }) : null;
  if (state !== 'FINALIZED') {
    throw conflict(`只有已 FINALIZED 的条目可以申诉（当前状态：${state ?? '未进入复核'}）`);
  }

  const allowedTiers = rules?.audit?.reviewState?.appealAllowedTiers ?? [];
  const tier = teamId ? getTeamTierRow(db, teamId) : null;
  if (!tier) {
    throw conflict(`无法判定档位（队伍 ${teamId}）——档位未知时不得受理申诉`);
  }
  if (!allowedTiers.includes(tier)) {
    throw forbidden(`档位 ${tier} 不在可申诉的低可见档（${allowedTiers.join(' / ')}）范围内`);
  }

  const id = insertAppeal(db, {
    subjectType, subjectId, filedBy, reason, status: 'submitted', now,
  });
  writeAuditLog(db, {
    actorId: filedBy,
    action: 'appeal.filed',
    entity: 'appeal',
    entityId: id,
    detail: { subjectType, subjectId, reason, stageId, teamId, tier },
    now,
  });
  return getAppeal(db, id);
}

/**
 * 裁决申诉。成立 → 撤销终稿（FINALIZED → REJECTED → PENDING_REVIEW）并要求 revision + 1 重算。
 * 旧 revision 保留（重算走新记录，不覆盖历史）。
 */
export function decideAppeal({
  db, appealId, decision, decidedBy = null, note, now = new Date().toISOString(), rules,
}) {
  if (!['accepted', 'rejected'].includes(decision)) {
    throw badRequest(`裁决只能是 accepted 或 rejected，收到：${decision}`);
  }
  if (!note || !String(note).trim()) throw badRequest('裁决必须写说明（无说明的裁决无法复盘）');

  const appeal = getAppeal(db, appealId);
  if (!appeal) throw notFound(`申诉不存在: ${appealId}`);
  if (appeal.status !== 'submitted' && appeal.status !== 'reviewing') {
    throw conflict(`申诉 ${appealId} 已裁决（当前状态 ${appeal.status}）`);
  }

  const transitions = [];
  if (decision === 'accepted') {
    const { stageId } = parseAppealSubject(appeal.subject_id);
    if (stageId) {
      transitions.push(transition({
        db, subjectType: 'stage_result', subjectId: stageId,
        from: 'FINALIZED', to: 'REJECTED', actorId: decidedBy,
        reason: `申诉成立：${note}`, idempotencyKey: `appeal:${appealId}:revoke`, now,
      }));
      transitions.push(transition({
        db, subjectType: 'stage_result', subjectId: stageId,
        from: 'REJECTED', to: 'PENDING_REVIEW', actorId: decidedBy,
        reason: `申诉重新复核：${note}`, idempotencyKey: `appeal:${appealId}:reopen`, now,
      }));
    }
  }

  updateAppeal(db, { id: appealId, status: decision, decidedBy, decidedAt: now, decisionNote: note });
  writeAuditLog(db, {
    actorId: decidedBy,
    action: 'appeal.decided',
    entity: 'appeal',
    entityId: appealId,
    detail: { decision, note, subjectType: appeal.subject_type, subjectId: appeal.subject_id, recomputeRequired: decision === 'accepted' },
    now,
  });

  return {
    appeal: getAppeal(db, appealId),
    transitions,
    // 申诉成立必须重算；重算走 revision + 1，旧 revision 保留（不覆盖历史）
    recomputeRequired: decision === 'accepted',
  };
}

/**
 * 申诉列表。列表不满足 → 200 + 空集。
 */
export function listAppeals({ db, filter = {}, viewer = null }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0 };
  const { rows, total } = listAppealRows(db, filter);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      filedBy: r.filed_by,
      reason: r.reason,
      status: r.status,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
    })),
    total,
  };
}
```

> **【2026-10-21 漂移审计修正 C-4】**
> **原来错在哪**：`src/services/review-state.js` 原来在**服务层直接写 SQL**：
> ```javascript
> const existing = db.prepare(
>   'SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?',
> ).get(idempotencyKey, scope);
> …
> db.prepare(
>   `INSERT OR IGNORE INTO idempotency_keys (key, scope, request_id, response_json, created_at)
>    VALUES (?, ?, ?, ?, ?)`,
> ).run(idempotencyKey, scope, idempotencyKey, JSON.stringify(result), at);
> ```
> **为什么错**：P0 终审 I-7 立了全局约束「**所有 SQL 收进 `platform/src/db/repo/`**」，
> 并由 `platform/test/sql-boundary.test.js` 守卫：扫描 `src/` 与 `scripts/` 下
> **除 `src/db/repo/` 与 `src/db/migrate.js` 外**的一切 `.js`，
> 只要出现 `db.prepare(`/`db.exec(` 且参数里含 `SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/DROP/ALTER`
> 就判违规。`src/services/` **不在豁免名单里** → 照本计划实施，P0 自带用例当场变红
> （审计实跑：`not ok 1 - src/ 与 scripts/ 里除仓储层外没有裸 SQL`，
> 报 `src/services/review-state.js:59 出现 SQL：SELECT response_json FROM idempotency_keys …`
> 与 `…:92 出现 SQL：INSERT OR IGNORE INTO idempotency_keys …`）。
> **更荒唐的是**：P4 **自己**在 Task 1 建了 `src/db/repo/idempotency.js`
> （导出 `findIdempotency` / `insertIdempotency`）——**建了仓储层却不用**，
> 反而在服务层又写一遍。
> **改成什么**：删掉服务层的两处 `db.prepare`，改为调用本阶段 Task 1 已建的仓储：
> ① 读：`const existing = findIdempotency(db, { key: idempotencyKey, scope });`
> （仓储返回整行 `SELECT *`，含 `response_json` —— 原代码取的字段它一样有；
> 且 `?? null` 的空值语义一致：`findIdempotency` 内部已 `?? null`）；
> ② 写：`insertIdempotency(db, { key, scope, requestId, response, now })`
> （`requestId` 对应原来的第 3 个占位符 `idempotencyKey`；`response` 是对象，
> 由仓储内部 `JSON.stringify` —— 与原代码等价；`now` 对应原来的 `at`）。
> 并在文件顶部加 `import { findIdempotency, insertIdempotency } from '../db/repo/idempotency.js';`。
> **依据**：基线 `platform/test/sql-boundary.test.js:282-292`（扫描范围 + 豁免名单）
> + 本计划 Task 1 自建的 `src/db/repo/idempotency.js` 的两个导出签名
> + 漂移审计报告 C-4。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/review-state.test.js`
Expected: PASS（13 个测试全过：review-state.test.js 13）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/services/review-state.js src/db/repo/tiers.js test/review-state.test.js
git commit -m "feat(P4): 复核与申诉状态机、幂等守卫与 PENDING_REVIEW 分数可见性过滤"
```

---

### Task 6: 审计 API + 前端 trace 抽屉 + 复核队列

**Files:**
- Create: `platform/src/http/routes/audit.js`
- Create: `platform/web/views/audit.js`
- Create: `platform/web/views/flags.js`
- Modify: `platform/src/server.js`（挂载路由；错误响应带 detail 与 `Retry-After`）
- Modify: `platform/src/http/respond.js`（`error()` 增加可选第 6 参 `extraHeaders`）
- Modify: `platform/web/app.js`（注册 `/audit` 与 `/flags` 路由 + 导航）
- Modify: `platform/scripts/seed.js`（新增能力点 `audit:write` / `appeal:write`）
- Test: `platform/test/audit-api.test.js`

**Interfaces:**
- Consumes: Task 2 的 `getComputation` / `recomputeAndDiff` / `listAuditLog`；Task 4 的 `listFlags` / `resolveFlag`；Task 5 的 `fileAppeal` / `decideAppeal` / `listAppeals`；Task 3 的 `assertRateLimit`
- Produces（API，与 `INTERFACES.md` §5 逐字一致）：
  - `GET  /api/audit/computations/:id`
  - `GET  /api/audit/computations/:id/diff`
  - `GET  /api/audit/log`
  - `GET  /api/audit/flags`
  - `POST /api/audit/flags/:id/resolve`
  - `POST /api/appeals`
  - `POST /api/appeals/:id/decide`
- 视图：`web/views/audit.js` 的 `renderAudit(ctx)`（trace 抽屉）、`web/views/flags.js` 的 `renderFlags(ctx)`（复核队列）

> **跨阶段接线说明（P2 必读）**：P2 的 `GET /api/stages/:stageId/review-state` 必须把返回的分数数组过一遍
> `filterVisibleScores({ db, stageId, viewer, scores })`（Task 5 提供）。**前端隐藏 = 数据已泄露**（设计文档 §6.6）。
> 执行本 Task 时先 `grep -n "review-state" platform/src/server.js` 找到 P2 的 handler，
> 在其返回前加一行 `scores: filterVisibleScores({ db, stageId, viewer: user, scores })`。

- [ ] **Step 1: 写失败的测试**

`platform/test/audit-api.test.js`：

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
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth/session.js';
import { createUser } from '../src/db/repo/users.js';
import { recordComputation } from '../src/services/audit.js';
import { transition } from '../src/services/review-state.js';
import { createFlag } from '../src/db/repo/flags.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4api-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app, rules };
}

function seedCapabilities(db) {
  const insCap = db.prepare('INSERT OR IGNORE INTO capabilities (key, description) VALUES (?, ?)');
  insCap.run('audit:read', '读取审计与计算快照');
  insCap.run('audit:write', '裁决复核项与申诉');
  insCap.run('appeal:write', '提交申诉');
  const insRole = db.prepare('INSERT OR IGNORE INTO roles (key, description) VALUES (?, ?)');
  insRole.run('admin', '组委会');
  insRole.run('captain', '队长');
  const insRc = db.prepare('INSERT OR IGNORE INTO role_capabilities (role_id, capability) VALUES (?, ?)');
  insRc.run('admin', 'audit:read');
  insRc.run('admin', 'audit:write');
  insRc.run('admin', 'appeal:write');
  insRc.run('captain', 'appeal:write');
}

function makeUser(db, { name, phone, superadmin = false, role = null }) {
  const user = createUser(db, { name, phone, password: 'pw' });
  if (superadmin) db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(user.id);
  if (role) db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_key) VALUES (?, ?)').run(user.id, role);
  const { token } = createSession(db, user.id);
  return { user, cookie: `hk_session=${token}` };
}

function call(app, method, path, { cookie = null, body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      headers: cookie ? { cookie } : {},
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
        resolve({ status: this.statusCode, headers: this.headers, body: this.body, json: this.body ? JSON.parse(this.body) : null });
      },
    };
    app.handle(req, res);
  });
}

// 输入快照按 INTERFACES.md §3 的契约构造（真实权重表 + 合法 submissions）。
// 若 P2 的 scoreStage 对入参结构有更严格要求，按 P2 的实际结构调整本函数，其余断言不变。
function makeInput(rules) {
  return {
    configKey: 'scoring.final',
    ruleVersion: `scoring.final@${rules.scoring.final.version}`,
    config: rules.scoring.final,
    judges: [{ id: 'j1' }],
    submissions: [{ judgeId: 'j1', teamId: 't1', dimension: 'innovation', rawScore: 80 }],
    enterpriseConfirmations: [],
    peerReviews: [],
  };
}

test('GET /api/audit/computations/:id 返回三件套', async () => {
  const { db, close, dataDir, app, rules } = setup();
  seedCapabilities(db);
  const { cookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const input = makeInput(rules);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: input.ruleVersion,
    input, output: { teams: [{ teamId: 't1', total: 80 }] }, trace: { normalization: {} },
  });
  const res = await call(app, 'GET', `/api/audit/computations/${id}`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.ruleVersion, input.ruleVersion);
  assert.equal(res.json.output.teams[0].total, 80);
  assert.ok(res.json.input.submissions.length > 0, '输入快照必须能重放');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/computations/:id 未登录返回 401，单条不存在返回 404', async () => {
  const { db, close, dataDir, app } = setup();
  seedCapabilities(db);
  const { cookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const anon = await call(app, 'GET', '/api/audit/computations/nope');
  assert.equal(anon.status, 401);
  const missing = await call(app, 'GET', '/api/audit/computations/nope', { cookie });
  assert.equal(missing.status, 404);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/computations/:id/diff 返回 diff 与 warnings（能被看见）', async () => {
  const { db, close, dataDir, app, rules } = setup();
  seedCapabilities(db);
  const { cookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const input = makeInput(rules);
  const { id } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: input.ruleVersion,
    input, output: { teams: [{ teamId: 't1', total: 999 }] }, trace: {},
  });
  const res = await call(app, 'GET', `/api/audit/computations/${id}/diff`, { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.diff));
  assert.ok(Array.isArray(res.json.warnings));
  assert.ok('identical' in res.json);
  assert.equal(res.json.identical, false, '快照被改后必须报不一致');
  assert.ok(res.json.diff.length > 0, 'diff 不能为空');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/log 无权访问返回 200 + 空集，有权返回行', async () => {
  const { db, close, dataDir, app } = setup();
  seedCapabilities(db);
  const { cookie: adminCookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const { cookie: judgeCookie } = makeUser(db, { name: '评委', phone: '13800000002' });
  const anon = await call(app, 'GET', '/api/audit/log');
  assert.equal(anon.status, 401);
  const denied = await call(app, 'GET', '/api/audit/log', { cookie: judgeCookie });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.json.rows, []);
  const allowed = await call(app, 'GET', '/api/audit/log', { cookie: adminCookie });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.json.rows));
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/audit/flags 返回复核队列；POST resolve 裁决并留痕', async () => {
  const { db, close, dataDir, app } = setup();
  seedCapabilities(db);
  const { cookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const flagId = createFlag(db, {
    stageId: 'st1', teamId: 't1', judgeId: 'j1', kind: 'low_variance',
    detail: { judgeId: 'j1', dimension: 'innovation', stdev: 1, n: 5, mean: 80, direction: 'too_low', action: 'alert_only' },
  });
  const list = await call(app, 'GET', '/api/audit/flags', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.rows.length, 1);

  const resolve = await call(app, 'POST', `/api/audit/flags/${flagId}/resolve`, {
    cookie,
    body: {
      status: 'confirmed',
      reason: '确认为异常宽严，列入观察名单',
      evidence: [{ url: 'https://a.example/1', publisher: '某媒体', independent: true }],
    },
  });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.json.status, 'confirmed');
  assert.equal(resolve.json.detail.evidence.uniquePublishers, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/audit/flags/:id/resolve 缺理由返回 400（不静默通过）', async () => {
  const { db, close, dataDir, app } = setup();
  seedCapabilities(db);
  const { cookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const flagId = createFlag(db, { stageId: 'st1', kind: 'burst_submit', detail: { subjectId: 'j1', count: 9, windowStart: 'x', windowEnd: 'y' } });
  const res = await call(app, 'POST', `/api/audit/flags/${flagId}/resolve`, {
    cookie, body: { status: 'confirmed', reason: '  ' },
  });
  assert.equal(res.status, 400);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 超限返回 429 + Retry-After（不静默丢包）', async () => {
  const { db, close, dataDir, app, rules } = setup();
  seedCapabilities(db);
  rules.audit.rateLimit.appealSubmit = {
    sliding: { seconds: 60, max: 2 },
    perMinute: { max: 2 },
  };
  const { cookie } = makeUser(db, { name: '队长', phone: '13800000003', role: 'captain' });
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES ('tr_t1', 't1', 'D', 0, 0, '[]', '2026-10-20T00:00:00.000Z')`,
  ).run();
  const steps = [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  const body = { subjectType: 'team_result', subjectId: 'st1:t1', reason: '企业确认分与事实不符' };
  const first = await call(app, 'POST', '/api/appeals', { cookie, body });
  assert.equal(first.status, 200);
  const second = await call(app, 'POST', '/api/appeals', { cookie, body });
  assert.equal(second.status, 200);
  const third = await call(app, 'POST', '/api/appeals', { cookie, body });
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers['Retry-After']) >= 1, '必须带 Retry-After 响应头');
  assert.ok(third.json.error.detail.retryAfterSeconds >= 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals 理由为空返回 400', async () => {
  const { db, close, dataDir, app } = setup();
  seedCapabilities(db);
  const { cookie } = makeUser(db, { name: '队长', phone: '13800000003', role: 'captain' });
  const res = await call(app, 'POST', '/api/appeals', {
    cookie, body: { subjectType: 'team_result', subjectId: 'st1:t1', reason: '' },
  });
  assert.equal(res.status, 400);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('POST /api/appeals/:id/decide 成立返回 recomputeRequired=true', async () => {
  const { db, close, dataDir, app } = setup();
  seedCapabilities(db);
  const { cookie: adminCookie } = makeUser(db, { name: '管理员', phone: '13800000001', superadmin: true });
  const { cookie: captainCookie } = makeUser(db, { name: '队长', phone: '13800000003', role: 'captain' });
  db.prepare(
    `INSERT INTO tier_records (id, team_id, tier, milestone_count, business_signoff_count, reasons_json, computed_at, deleted_at)
     VALUES ('tr_t1', 't1', 'D', 0, 0, '[]', '2026-10-20T00:00:00.000Z')`,
  ).run();
  const steps = [['SUBMITTED', 'PENDING_REVIEW', 'k1'], ['PENDING_REVIEW', 'CONFIRMED', 'k2'], ['CONFIRMED', 'FINALIZED', 'k3']];
  for (const [from, to, key] of steps) {
    transition({
      db, subjectType: 'stage_result', subjectId: 'st1', from, to,
      actorId: 'u_admin', reason: 'x', idempotencyKey: key, now: '2026-10-20T00:00:00.000Z',
    });
  }
  const filed = await call(app, 'POST', '/api/appeals', {
    cookie: captainCookie,
    body: { subjectType: 'team_result', subjectId: 'st1:t1', reason: '企业确认分与事实不符' },
  });
  assert.equal(filed.status, 200);
  const decided = await call(app, 'POST', `/api/appeals/${filed.json.id}/decide`, {
    cookie: adminCookie, body: { decision: 'accepted', note: '成立，重算' },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.recomputeRequired, true);
  assert.equal(decided.json.appeal.status, 'accepted');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/audit-api.test.js`
Expected: FAIL —— 404（`/api/audit/...` 路由尚未注册）

- [ ] **Step 3: 创建 `src/http/routes/audit.js`**

```javascript
// src/http/routes/audit.js — P4 的 7 个接口
// 依据：INTERFACES.md §5「API（P4）」——路径与语义逐字对齐。
//   GET  /api/audit/computations/:id          计算快照（三件套）
//   GET  /api/audit/computations/:id/diff     复算 diff
//   GET  /api/audit/log                       审计日志
//   GET  /api/audit/flags                     复核队列
//   POST /api/audit/flags/:id/resolve         裁决复核项
//   POST /api/appeals                         提交申诉
//   POST /api/appeals/:id/decide              裁决申诉
// ⛔ 三态语义：列表不满足 → 200 + 空集（服务层已处理）；单条不满足 → 404；未登录 → 401。
// ⛔ 限频触发 → 429 + Retry-After（由 server.js 的错误分支统一加头）。
import { getComputation, recomputeAndDiff, listAuditLog } from '../services/audit.js';
import { listFlags, resolveFlag } from '../services/anticheat.js';
import { fileAppeal, decideAppeal, listAppeals } from '../services/review-state.js';
import { assertRateLimit } from '../services/rate-limit.js';
import { can } from '../auth/permissions.js';
import { unauthenticated, forbidden } from '../errors.js';

function requireLogin(user) {
  if (!user) throw unauthenticated();
}

function pickFilter(query = {}) {
  const out = {};
  for (const key of ['action', 'entity', 'entityId', 'since', 'until', 'status', 'kind', 'stageId']) {
    if (query[key] !== undefined && query[key] !== '') out[key] = query[key];
  }
  if (query.limit !== undefined) out.limit = Number(query.limit);
  if (query.offset !== undefined) out.offset = Number(query.offset);
  return out;
}

export function registerAuditRoutes(router, { db, rules }) {
  const now = () => new Date().toISOString();

  router.add('GET', '/api/audit/computations/:id', async ({ user, params }) => {
    requireLogin(user);
    return getComputation({ db, id: params.id, viewer: user });
  });

  router.add('GET', '/api/audit/computations/:id/diff', async ({ user, params }) => {
    requireLogin(user);
    if (!can(user, 'audit:read', null, db)) throw forbidden('无权复算');
    return recomputeAndDiff({ db, id: params.id, actorId: user.id, now: now(), rules });
  });

  router.add('GET', '/api/audit/log', async ({ user, query }) => {
    requireLogin(user);
    return listAuditLog({ db, filter: pickFilter(query), viewer: user, rules, now: now() });
  });

  router.add('GET', '/api/audit/flags', async ({ user, query }) => {
    requireLogin(user);
    return listFlags({ db, filter: pickFilter(query), viewer: user });
  });

  router.add('POST', '/api/audit/flags/:id/resolve', async ({ user, params, body }) => {
    requireLogin(user);
    if (!can(user, 'audit:write', null, db)) throw forbidden('无权裁决复核项');
    return resolveFlag({
      db,
      flagId: params.id,
      status: body?.status,
      reviewerId: user.id,
      reason: body?.reason,
      evidence: Array.isArray(body?.evidence) ? body.evidence : [],
      now: now(),
    });
  });

  router.add('POST', '/api/appeals', async ({ user, body }) => {
    requireLogin(user);
    if (!can(user, 'appeal:write', null, db)) throw forbidden('无权提交申诉');
    // 限频：申诉提交必须限频。触发即 429 + retryAfterSeconds，⛔ 绝不静默丢包。
    assertRateLimit({
      db,
      subjectKey: `appeal:${user.id}`,
      rule: 'appealSubmit',
      now: now(),
      limits: rules?.audit?.rateLimit,
      subjects: { default: `appeal:${user.id}` },
    });
    return fileAppeal({
      db,
      subjectType: body?.subjectType,
      subjectId: body?.subjectId,
      filedBy: user.id,
      reason: body?.reason,
      now: now(),
      rules,
    });
  });

  router.add('POST', '/api/appeals/:id/decide', async ({ user, params, body }) => {
    requireLogin(user);
    if (!can(user, 'audit:write', null, db)) throw forbidden('无权裁决申诉');
    return decideAppeal({
      db,
      appealId: params.id,
      decision: body?.decision,
      decidedBy: user.id,
      note: body?.note,
      now: now(),
      rules,
    });
  });

  // 申诉列表挂在 /api/audit/log 的同族路径下，供委员会用（不新增 INTERFACES 之外的必选接口）
  router.add('GET', '/api/appeals', async ({ user, query }) => {
    requireLogin(user);
    return listAppeals({ db, filter: pickFilter(query), viewer: user });
  });
}
```

- [ ] **Step 4: 修改 `src/http/respond.js` 与 `src/server.js`**

`platform/src/http/respond.js`（`error()` 增加可选第 6 参，向后兼容）：

```javascript
// src/http/respond.js —— 修改处：error() 增加可选 extraHeaders（第 6 参）
// ⛔ 限频要返回 429 + Retry-After 响应头，调用方拿不到 res.writeHead 的二次机会，
//    所以错误响应也必须能带自定义头。
export function error(res, status, code, message, detail, extraHeaders = {}) {
  json(res, status, { error: { code, message, ...(detail ? { detail } : {}) } }, extraHeaders);
}
```

`platform/src/server.js`（三处修改）：

```text
（以下是并入 platform/src/server.js 对应位置的【片段】，不是独立文件）

// src/server.js —— 修改处 1：import
import { registerAuditRoutes } from './http/routes/audit.js';

// src/server.js —— 修改处 2：createApp 内挂载路由（放在 /api/health 之后）
  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));
  registerAuditRoutes(router, { db, rules });

// src/server.js —— 修改处 3：错误分支带上 Retry-After
//    ⚠️ 这段是在**当前基线**（P1 终态）的 catch 分支上**追加**，不是**替换**掉它。
//    基线的 catch 分支里已修好的防线必须原样保留：
//      ① 5xx 分支只回「服务内部错误」，内部原文只进 console.error（I7-3）
//      ② code 走 domainCode(err, 'BAD_REQUEST')，不外泄 Node 的 ERR_* 码
//      ③ message 只透传 AppError 的 message，裸 Error 一律回落「请求无效」（I-C）
//      ④ 413 分支带 Connection: close（M-6）
//      ⑤ detail 只透传 AppError 的 detail（P1 的 Task 3「detail 透传断言」已落地）
//    P4 只在其上**追加一件事**：**Retry-After 响应头**（第 6 参 extraHeaders）。
//    ⚠️ detail 透传**不要**改回 err.detail —— 那是 P1 已修好的 I-C 延伸。
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) {
          // ⛔ 预审修正（I7-3）：内部错误原文不外泄 ——
          //    SQLite 错误带表名列名，Node 错误带内部实现细节。只进日志。
          console.error('[server]', err);
          json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
          return;
        }
        const code = domainCode(err, 'BAD_REQUEST');
        // ⛔ 终审修正（Important，I-C 延伸）：**只透传领域错误（AppError）的 message**。
        //    AppError 的 message 是我们自己写的中文文案（"该手机号已注册"…），可以给用户看；
        //    而裸 Error / Node 内置错误 / SQLite 错误的 message 里含**内部原文**
        //    （表名列名、SQL 参数位置、文件路径）——
        //    契约 INTERFACES.md「错误」纪律明写「不外泄 Node 的 ERR_* 与 SQLite 原文」。
        //    实测（修复前）：handler 抛 `e.status=400; e.code='ERR_SQLITE_ERROR'` 时，
        //    响应体是 {"code":"BAD_REQUEST","message":"users.phone UNIQUE constraint failed"}
        //    —— code 挡住了，message 没挡住。
        const message = err instanceof AppError ? err.message : '请求无效';
        // ── P4 追加：限频要带 Retry-After，调用方才知道多久能重试（不静默丢包）──
        const extraHeaders = {};
        if (code === 'RATE_LIMITED' && err.detail?.retryAfterSeconds) {
          extraHeaders['Retry-After'] = String(err.detail.retryAfterSeconds);
        }
        if (status === 413) {
          // 请求体超限：连接已不可用 → 关掉，不复用
          json(res, 413, { error: { code, message } }, { Connection: 'close' });
          return;
        }
        // detail 同理：**只透传 AppError 的 detail** —— detail 可能含表名 / 列名
        //（问卷缺项说明是我们自己写的文案，可给前端看；裸 Error 的 detail 不行）。
        error(res, status, code, message, err instanceof AppError ? err.detail : undefined, extraHeaders);
      }
```

> **【2026-10-21 漂移审计修正 C-1】**（**本计划最危险的一处**）
> **原来错在哪**：「修改处 3」原来是一段**整块替换**，把 P0 终审的错误分支换成：
> ```javascript
> } catch (err) {
>   const status = err.status || 500;
>   const code = err.code || 'INTERNAL';
>   if (status >= 500) console.error('[server]', err);
>   const extraHeaders = {};
>   if (code === 'RATE_LIMITED' && err.detail?.retryAfterSeconds) {
>     extraHeaders['Retry-After'] = String(err.detail.retryAfterSeconds);
>   }
>   error(res, status, code, err.message, err.detail, extraHeaders);
> }
> ```
> **为什么错（抹掉了 P0 终审的四道防线）**：
> ① **I-C（最严重）**：`err.message` 原样外泄 —— 裸 Error / SQLite 错误的 message 里含
> **表名列名、SQL 参数位置、文件路径**（契约 INTERFACES.md「错误」纪律明写「不外泄 Node 的
> ERR_* 与 SQLite 原文」）。同时 `err.detail` 也被原样回传，detail 同样可能含表名。
> ② **`domainCode()` 被顶替**：`err.code || 'INTERNAL'` → `ERR_SQLITE_ERROR` 这类 Node 内置码
> 直接外泄（`domainCode` 是 P0 专门为此新增、并带断言的导出）。
> ③ **I7-3**：5xx 分支被并入同一条路径 → 500 也回显内部细节（P0 原本 5xx 只回「服务内部错误」，
> 内部原文只进 `console.error`）。
> ④ **M-6**：413 分支整段消失 → 丢 `Connection: close`，连接不复用。
> **实跑证据（审计报告 C-1）**：把原片段**逐字**打进 pristine P0（`38c6713` 与 `d077537`
> 两个基线各跑一遍），跑全量 → **3 个 P0 用例当场变红**：
> `not ok 88 - 500 响应只回通用文案，内部细节只进 console.error`、
> `not ok 112 - HTTP 层不把 Node 的 ERR_* 错误码外泄给客户端（端到端）`、
> `not ok 115 - 请求体超限返回 413 且必须带 Connection: close（终审 M-6）`
> （`# tests 151 / # pass 148 / # fail 3`）。
> **改成什么**：这段改为**在当前基线（P1 终态）的 catch 分支上追加**，**逐字保留**基线的
> 5xx 分支（I7-3）、`domainCode(err, 'BAD_REQUEST')`、`AppError`-only message（I-C）、
> 413 分支（M-6）与 **P1 的 detail 透传**（`err instanceof AppError ? err.detail : undefined`
> —— P1 的 Task 3「detail 透传断言」已落地），**只追加一件事**：
> `const extraHeaders = {}` + `Retry-After` 头（限频语义仍是 P4 自己的能力，**排期不变**），
> 并作为 `error()` 的**第 6 参**传出去。
> ⚠️ **detail 透传不要改回 `err.detail`** —— 那是 P1 已修好的 I-C 延伸，改回去等于回退。
> **依据**：基线 `platform/src/server.js` 的 catch 分支逐字（当前基线 = P1 终态；
> 注意 P1 已在该分支落地了 detail 透传，所以本段的锚点是**当前**基线而不是 P0 终态）、
> `platform/src/errors.js`（`AppError`）、
> `docs/superpowers/plans/2026-10-20-platform-P1-registration-team.md` 的 Task 3 Step 6
> （同一处写法）+ 漂移审计报告 C-1。
> **连带**：P4 的 `src/http/respond.js` 的 `error()` 第 6 参 `extraHeaders` **保持不变**
> （向后兼容的追加，默认 `{}`），本处只改**调用点**。

- [ ] **Step 5: 创建 `web/views/audit.js`（trace 抽屉）**

```javascript
// web/views/audit.js — 计算留痕 trace 抽屉
// 依据：设计文档 §9「发榜页：榜单 + trace 抽屉（点任一队伍 → 展开每一步：
//   原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分）；降级告警置顶」
//   + §12 三件套结构 + S-5「降级状态可见」。
// ⛔ 降级告警置顶且不可折叠：榜单页必须显式提示"本轮该维度未做评委宽严归一化（样本不足 5）"。
const STEPS = [
  ['raw', '原始分'],
  ['z', 'z 分'],
  ['trim', '去极值'],
  ['weights', '加权'],
  ['total', '总分'],
  ['tiebreak', '破同分'],
];

export function renderAudit(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card audit-trace';

  const head = document.createElement('div');
  head.innerHTML = '<h1>计算留痕</h1><p class="muted" id="au-msg">加载中…</p>';
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.id = 'au-body';
  wrap.appendChild(body);

  const computationId = ctx.params?.computationId || ctx.getState?.().computationId;
  const msg = wrap.querySelector('#au-msg');

  if (!computationId) {
    msg.textContent = '缺少 computationId：请从发榜页点任一队伍进入。';
    return wrap;
  }

  (async () => {
    let data;
    try {
      data = await ctx.api.get(`/api/audit/computations/${encodeURIComponent(computationId)}`);
    } catch (e) {
      msg.textContent = e.message;
      return;
    }
    msg.textContent = `规则版本 ${data.ruleVersion} ｜ revision ${data.revision} ｜ ${data.createdAt}`;

    // ── 降级告警置顶 ─────────────────────────────────────────
    const warnBox = document.createElement('div');
    warnBox.className = 'card warn-box';
    const norm = data.trace?.normalization ?? {};
    const normWarnings = Object.entries(norm)
      .filter(([, v]) => v && v.normalized === false)
      .map(([dim, v]) => `${dim}：未做评委宽严归一化（${v.fallbackReason ?? '未知原因'}）`);
    const engineWarnings = (data.trace?.warnings ?? []).map((w) => w.message ?? String(w));
    const allWarnings = [...normWarnings, ...engineWarnings];
    if (allWarnings.length) {
      warnBox.innerHTML = `<strong>降级告警（${allWarnings.length}）</strong><ul>${
        allWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')
      }</ul>`;
    } else {
      warnBox.innerHTML = '<strong>降级告警</strong><p class="muted">无</p>';
    }
    body.appendChild(warnBox);

    // ── 每队展开：原始分 → z 分 → 去极值 → 加权 → 总分 → 破同分 ──
    const perTeam = data.trace?.perTeam ?? {};
    const teams = data.output?.teams ?? [];
    const list = document.createElement('div');
    for (const t of teams) {
      const teamId = t.teamId;
      const tr = perTeam[teamId] ?? {};
      const item = document.createElement('details');
      item.className = 'team-trace';
      const rank = t.rank !== undefined ? `第 ${t.rank} 名` : '未排名';
      const tied = Array.isArray(t.tiedWith) && t.tiedWith.length ? `（并列 ${t.tiedWith.join('、')}）` : '';
      item.innerHTML = `<summary>${escapeHtml(teamId)} ｜ ${rank}${tied} ｜ 总分 ${t.total ?? '—'}</summary>
        <ol>${STEPS.map(([key, label]) => {
    const value = key === 'total' ? (t.total ?? '—')
      : key === 'tiebreak' ? (t.tiedWith ? t.tiedWith.join('、') || '未触发破同分' : '未触发破同分')
        : formatStep(tr, key);
    return `<li><strong>${label}</strong>：${escapeHtml(String(value))}</li>`;
  }).join('')}</ol>`;
      list.appendChild(item);
    }
    body.appendChild(list);

    // ── 复算并比对（diff 必须被看见，不能只写一条日志）──────────
    const actions = document.createElement('div');
    actions.className = 'trace-actions';
    const btn = document.createElement('button');
    btn.textContent = '用同一输入复算并比对';
    const diffBox = document.createElement('div');
    diffBox.id = 'au-diff';
    btn.addEventListener('click', async () => {
      diffBox.textContent = '复算中…';
      try {
        const d = await ctx.api.get(`/api/audit/computations/${encodeURIComponent(computationId)}/diff`);
        const warnLines = (d.warnings ?? []).map((w) => `<li>${escapeHtml(w.message ?? w.code)}</li>`).join('');
        const diffLines = (d.diff ?? []).map((x) => `<li><code>${escapeHtml(x.path)}</code>：${escapeHtml(String(x.before))} → ${escapeHtml(String(x.after))}</li>`).join('');
        diffBox.innerHTML = `
          <p><strong>identical = ${String(d.identical)}</strong>（${(d.diff ?? []).length} 处差异）</p>
          ${warnLines ? `<ul>${warnLines}</ul>` : ''}
          ${diffLines ? `<ul>${diffLines}</ul>` : '<p class="muted">无差异</p>'}
        `;
      } catch (e) {
        diffBox.textContent = e.message;
      }
    });
    actions.appendChild(btn);
    actions.appendChild(diffBox);
    body.appendChild(actions);
  })();

  return wrap;
}

function formatStep(tr, key) {
  if (key === 'raw' || key === 'z') {
    const v = tr[key] ?? {};
    const parts = Object.entries(v).map(([k, val]) => `${k}:${typeof val === 'number' ? round2(val) : val}`);
    return parts.length ? parts.join('  ') : '—';
  }
  if (key === 'trim') {
    const steps = (tr.steps ?? []).filter((s) => s.step === 'trim');
    if (!steps.length) return '未触发去极值';
    return steps.map((s) => `${s.dimension ?? ''} 去掉最高 ${s.removed?.max ?? '—'}／最低 ${s.removed?.min ?? '—'}`).join('；');
  }
  if (key === 'weights') {
    const w = tr.weights ?? {};
    const parts = Object.entries(w).map(([k, val]) => `${k}:${val}`);
    return parts.length ? parts.join('  ') : '—';
  }
  return '—';
}

function round2(n) {
  return Number(n).toFixed(2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
```

- [ ] **Step 6: 创建 `web/views/flags.js`（复核队列）**

```javascript
// web/views/flags.js — 复核队列
// 依据：设计文档 §9「组委会视角 → 复核/申诉/改级」、§11.1（检测 → 进人工复核队列）
// ⛔ 检测 ≠ 处罚：队列里只做"确认 / 驳回"的人工判断，系统不改分、不封号。
// ⛔ 裁决必须写理由与证据（证据三列：URL / 发行方 / 独立性，按发行方去重）。
export function renderFlags(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card flags-queue';

  const head = document.createElement('div');
  head.innerHTML = '<h1>复核队列</h1><p class="muted" id="fl-msg">加载中…</p>';
  wrap.appendChild(head);

  const list = document.createElement('div');
  list.id = 'fl-list';
  wrap.appendChild(list);

  const msg = wrap.querySelector('#fl-msg');

  (async () => {
    let data;
    try {
      data = await ctx.api.get('/api/audit/flags');
    } catch (e) {
      msg.textContent = e.message;
      return;
    }
    const rows = data.rows ?? [];
    msg.textContent = `共 ${data.total ?? rows.length} 项待处理（只告警不处罚，改分与封禁由组委会线下决定）`;
    if (!rows.length) {
      list.innerHTML = '<p class="muted">队列为空</p>';
      return;
    }
    for (const flag of rows) {
      list.appendChild(renderFlagRow(ctx, flag));
    }
  })();

  return wrap;
}

function renderFlagRow(ctx, flag) {
  const box = document.createElement('div');
  box.className = 'flag-row card';
  const detail = flag.detail ?? {};
  box.innerHTML = `
    <p><strong>${escapeHtml(flag.kind)}</strong> ｜ 状态 ${escapeHtml(flag.status)} ｜ 赛段 ${escapeHtml(flag.stageId ?? '—')} ｜ 队伍 ${escapeHtml(flag.teamId ?? '—')} ｜ 评委 ${escapeHtml(flag.judgeId ?? '—')}</p>
    <pre class="muted">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
  `;

  if (flag.status === 'open') {
    const form = document.createElement('div');
    form.className = 'flag-form';
    form.innerHTML = `
      <label>裁决<select id="fl-status"><option value="confirmed">确认（确有异常）</option><option value="rejected">驳回（误报）</option></select></label>
      <label>理由<input id="fl-reason" placeholder="写明判断依据（必填）" /></label>
      <fieldset><legend>证据（三列必填：URL / 发行方 / 独立性）</legend>
        <input id="fl-url" placeholder="https://…" />
        <input id="fl-publisher" placeholder="发行方" />
        <label class="inline"><input type="checkbox" id="fl-independent" /> 独立信源</label>
      </fieldset>
      <button id="fl-submit">提交裁决</button>
      <p id="fl-note" class="err"></p>
    `;
    const note = form.querySelector('#fl-note');
    form.querySelector('#fl-submit').addEventListener('click', async () => {
      note.textContent = '';
      const reason = form.querySelector('#fl-reason').value.trim();
      if (!reason) {
        note.textContent = '必须写理由';
        return;
      }
      const evidence = [];
      const url = form.querySelector('#fl-url').value.trim();
      const publisher = form.querySelector('#fl-publisher').value.trim();
      if (url || publisher) {
        evidence.push({
          url,
          publisher,
          independent: form.querySelector('#fl-independent').checked,
        });
      }
      try {
        const out = await ctx.api.post(`/api/audit/flags/${encodeURIComponent(flag.id)}/resolve`, {
          status: form.querySelector('#fl-status').value,
          reason,
          evidence,
        });
        note.className = 'muted';
        note.textContent = `已裁决；独立发行方 ${out.detail?.evidence?.uniquePublishers ?? 0} 个（按发行方去重）`;
      } catch (e) {
        note.textContent = e.message;
      }
    });
    box.appendChild(form);
  }
  return box;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
```

- [ ] **Step 7: 修改 `web/app.js` 与 `scripts/seed.js`**

`platform/web/app.js`（新增 import、路由与导航）：

```text
（以下是并入 platform/web/app.js 对应位置的【片段】，不是独立文件）

// web/app.js —— 修改处 1：import
import { renderAudit } from './views/audit.js';
import { renderFlags } from './views/flags.js';

// web/app.js —— 修改处 2：路由
route('/audit/:computationId', () => renderAudit(ctx));
route('/flags', () => renderFlags(ctx));

// web/app.js —— 修改处 3：首页导航
      <a href="#/login">登录</a>
      <a href="#/leaderboard">榜单</a>
      <a href="#/flags">复核队列</a>
```

`platform/scripts/seed.js`（新增能力点与授权）：

```text
（以下是并入 platform/scripts/seed.js 对应位置的【片段】，不是独立文件）

// scripts/seed.js —— 修改处 1：CAPABILITIES 增加两条
  ['audit:write', '裁决复核项与申诉'],
  ['appeal:write', '提交申诉'],

// scripts/seed.js —— 修改处 2：ROLE_CAPABILITIES 增加授权
  ['admin', 'audit:write'], ['admin', 'appeal:write'],
  ['captain', 'appeal:write'],
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd platform && node --test test/audit-api.test.js`
Expected: PASS（9 个测试全过：audit-api.test.js 9）

- [ ] **Step 9: 提交**

```bash
cd platform && git add src/http/routes/audit.js src/http/respond.js src/server.js web/views web/app.js scripts/seed.js test/audit-api.test.js
git commit -m "feat(P4): 审计 API（7 个接口）、trace 抽屉与复核队列前端"
```

---

### Task 7: 发布前扫描闸 `scripts/audit-scan.js`

**Files:**
- Create: `platform/scripts/audit-scan.js`
- Modify: `platform/scripts/forbidden.txt`
- Test: `platform/test/audit-scan.test.js`

**Interfaces:**
- Consumes: 无（独立脚本）
- Produces:
  - `parseManifest(text)` → `{ terms: [{ term, exemptRegex }], skipPaths: [RegExp], errors: string[] }`
  - `scanText(text, terms, { file })` → `{ violations: [{ file, line, term, text }], exempted: [...] }`
  - `scanRoots(roots, { terms, skipPaths, excludePaths })` → `{ violations, exempted, scannedFiles, excludedPaths }`
  - CLI：`node scripts/audit-scan.js [root...]`；默认扫描 `../docs` 与 `.`（即 `platform/`）

> **⚠️ 本 Task 的灵魂（R-AUD-03）**
> **禁用清单必须真有词条，空清单 ≠ 已保护。** 项目自己的踩坑记录写得很直白：
> 「跑扫描发现 forbidden.txt 存在但无词条 —— 该闸未生效」。
> → 所以：**清单为空 → 脚本直接报错并以非 0 退出**，绝不能"扫了 0 个词，0 个违规，闸通过"。

- [ ] **Step 1: 写失败的测试**

`platform/test/audit-scan.test.js`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseManifest, scanText, scanRoots } from '../scripts/audit-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = join(here, '..');
const SCRIPT = join(PLATFORM_DIR, 'scripts', 'audit-scan.js');
const MANIFEST = join(PLATFORM_DIR, 'scripts', 'forbidden.txt');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-scan-'));
}

/**
 * 造一个「能跑 CLI」的临时工程：<root>/platform/scripts/audit-scan.js（脚本副本）+
 * <root>/platform/scripts/forbidden.txt（清单）+ <root>/docs/（被扫的文件）。
 * CLI 里的 REPO_ROOT = <root>，所以相对路径可预期（docs/bad.md）。
 */
function cliSandbox({ manifest = '', files = {}, manifestMissing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hks-scan-cli-'));
  const scriptsDir = join(root, 'platform', 'scripts');
  const docsDir = join(root, 'docs');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  copyFileSync(SCRIPT, join(scriptsDir, 'audit-scan.js'));
  if (!manifestMissing) writeFileSync(join(scriptsDir, 'forbidden.txt'), manifest);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(docsDir, name), content);
  }
  return { root, scriptsDir, docsDir };
}

function runCli(sandbox, args = []) {
  return spawnSync(process.execPath, [join(sandbox.scriptsDir, 'audit-scan.js'), ...args], {
    encoding: 'utf8',
  });
}

test('清单为空时扫描闸报错（空清单 ≠ 已保护）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'forbidden.txt'), '# 只有注释，没有词条\n\n');
  const parsed = parseManifest('# 只有注释，没有词条\n\n');
  assert.equal(parsed.terms.length, 0);
  assert.ok(parsed.errors.length > 0, '必须报"闸未生效"');
  assert.ok(parsed.errors[0].includes('闸未生效'));
  rmSync(dir, { recursive: true, force: true });
});

test('能拦下故意写错的文档，并报出文件与行号', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'bad.md'), '第一行正常\n第二行写了四维各25%\n第三行正常\n');
  const parsed = parseManifest('四维各25%\n');
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
  assert.equal(report.violations.length, 1);
  assert.ok(report.violations[0].file.endsWith('bad.md'));
  assert.equal(report.violations[0].line, 2);
  assert.ok(report.violations[0].text.includes('四维各25%'));
  rmSync(dir, { recursive: true, force: true });
});

test('禁用词出现在"更正语境"里允许出现（引用规则不是违规）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'good.md'), '说明：四维各25%（原表述有误，已按 C-01 裁决更正）\n');
  const parsed = parseManifest('四维各25%|原表述有误|已更正\n');
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
  assert.equal(report.violations.length, 0, '更正语境不应算违规');
  assert.equal(report.exempted.length, 1, '豁免命中必须被记录（不静默）');
  rmSync(dir, { recursive: true, force: true });
});

test('清单文件本身与测试夹具被排除（排除项必须在报告里列出，不静默）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'forbidden.txt'), '禁用词\n');
  writeFileSync(join(dir, 'a.test.js'), '禁用词\n');
  const parsed = parseManifest('禁用词\n');
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: ['forbidden.txt', '*.test.js'] });
  assert.equal(report.violations.length, 0);
  assert.ok(report.excludedPaths.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('scanText 能逐行定位违规', () => {
  const parsed = parseManifest('禁用词\n');
  const r = scanText('第一行\n含禁用词的行\n', parsed.terms, { file: 'x.md' });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].line, 2);
});

test('仓库自带的 forbidden.txt 非空、每条词条合法、且能被解析', () => {
  const text = readFileSync(MANIFEST, 'utf8');
  const parsed = parseManifest(text);
  assert.ok(parsed.terms.length > 0, '禁用清单不得为空');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  for (const t of parsed.terms) {
    assert.ok(t.term.trim().length > 0);
  }
});

test('仓库自带的 forbidden.txt 里没有重复词条', () => {
  const text = readFileSync(MANIFEST, 'utf8');
  const parsed = parseManifest(text);
  const seen = new Set();
  for (const t of parsed.terms) {
    assert.equal(seen.has(t.term), false, `重复词条：${t.term}`);
    seen.add(t.term);
  }
});

// ── 父代理预审修正用例（2026-10-21）────────────────────────────────────
// 规格自带的 7 条用例盖不住「闸根本没生效」这一类失败：词条写成正则占位
// （`四维各 ?25%`）时，字面匹配下永远命中不了，闸看着在跑、实际一条不拦。
// 下面这批用例把「闸真的生效」钉死。

test('仓库自带清单能拦住「真实写错」的表述（字面串，不是 ? 占位写法）', () => {
  const parsed = parseManifest(readFileSync(MANIFEST, 'utf8'));
  const cases = [
    { wrong: 'CICC 四维各 25%', term: '四维各 25%' },
    { wrong: '初赛企业确认权重 20%', term: '初赛企业确认权重 20%' },
  ];
  for (const c of cases) {
    const dir = tempDir();
    writeFileSync(join(dir, 'wrong.md'), `行业参考：${c.wrong}\n`);
    const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
    assert.ok(
      report.violations.some((v) => v.term === c.term),
      `仓库清单必须能拦住「${c.wrong}」—— 词条写成 ? 占位就拦不住（闸被架空）`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('仓库自带清单里没有「正则占位」写法（字面匹配下 ? / * / .* 永不命中）', () => {
  const parsed = parseManifest(readFileSync(MANIFEST, 'utf8'));
  for (const { term } of parsed.terms) {
    assert.ok(!term.includes('?'), `词条含正则占位「?」，字面匹配下永不命中：${term}`);
    assert.ok(!term.includes('*'), `词条含正则占位「*」，字面匹配下永不命中：${term}`);
    assert.ok(!term.includes('.*'), `词条含正则片段「.*」，字面匹配下永不命中：${term}`);
  }
});

test('清单里有一行只有分隔符没有词条 → 报错（不是当成合法词条放行）', () => {
  const parsed = parseManifest('|原表述有误\n');
  assert.equal(parsed.terms.length, 0);
  assert.ok(
    parsed.errors.some((e) => e.includes('只有分隔符没有词条')),
    parsed.errors.join('；'),
  );
});

test('@skip-path 命中的路径整条跳过，并在排除报告里留痕（不静默）', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'skipped-dir'), { recursive: true });
  writeFileSync(join(dir, 'skipped-dir', 'x.md'), '禁用词\n');
  writeFileSync(join(dir, 'keep.md'), '禁用词\n');
  const parsed = parseManifest('@skip-path skipped-dir\n禁用词\n');
  assert.equal(parsed.skipPaths.length, 1);
  const report = scanRoots([dir], { terms: parsed.terms, skipPaths: parsed.skipPaths, excludePaths: [] });
  assert.equal(report.violations.length, 1, '被跳过的目录不该产生违规');
  assert.ok(
    report.excludedPaths.some((e) => e.path.endsWith('skipped-dir') && e.reason === '@skip-path'),
    '被跳过的路径必须在排除报告里留痕',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('CLI：清单为空（只有注释）→ 退出码 2，并报「禁用清单为空 —— 闸未生效」', () => {
  const sb = cliSandbox({ manifest: '# 只有注释，没有词条\n' });
  const r = runCli(sb);
  assert.equal(r.status, 2, `期望退出码 2，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /禁用清单为空 —— 闸未生效/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：清单文件缺失 → 退出码 2，并报「禁用清单缺失」（闸未生效）', () => {
  const sb = cliSandbox({ manifestMissing: true });
  const r = runCli(sb);
  assert.equal(r.status, 2, `期望退出码 2，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /禁用清单缺失/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：扫到禁用表述 → 退出码 1，并报出文件与行号', () => {
  const sb = cliSandbox({
    manifest: '禁用词\n',
    files: { 'bad.md': '第一行正常\n第二行写了禁用词\n' },
  });
  const r = runCli(sb, [sb.docsDir]);
  assert.equal(r.status, 1, `期望退出码 1，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /bad\.md:2/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：干净清单 + 无违规 → 退出码 0，排除项照样打印（不静默）', () => {
  const sb = cliSandbox({ manifest: '禁用词\n', files: { 'ok.md': '正常内容\n' } });
  const r = runCli(sb, [sb.docsDir]);
  assert.equal(r.status, 0, `期望退出码 0，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /未发现禁用表述/);
  assert.match(r.stdout, /排除 \d+ 项/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('CLI：更正语境豁免会记进报告（不静默）', () => {
  const sb = cliSandbox({
    manifest: '禁用词|已更正\n',
    files: { 'good.md': '说明：禁用词（已更正）\n' },
  });
  const r = runCli(sb, [sb.docsDir]);
  assert.equal(r.status, 0, `期望退出码 0，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /豁免命中 1 处/);
  assert.match(r.stdout, /good\.md:1/);
  rmSync(sb.root, { recursive: true, force: true });
});

test('清单里的非法正则 → 报错（不能静默吞掉）', () => {
  const badSkip = parseManifest('@skip-path (\n禁用词\n');
  assert.ok(
    badSkip.errors.some((e) => e.includes('@skip-path 正则非法')),
    badSkip.errors.join('；'),
  );
  const badExempt = parseManifest('禁用词|(\n');
  assert.ok(
    badExempt.errors.some((e) => e.includes('豁免正则非法')),
    badExempt.errors.join('；'),
  );
});

test('清单里有重复词条 → 报错（不许当成两条不同的词条放行）', () => {
  const parsed = parseManifest('禁用词\n禁用词\n');
  assert.equal(parsed.terms.length, 1);
  assert.ok(
    parsed.errors.some((e) => e.includes('重复词条')),
    parsed.errors.join('；'),
  );
});

test('仓库自带清单必须保住 P0 已证伪的词条（不许被悄悄删掉）', () => {
  const parsed = parseManifest(readFileSync(MANIFEST, 'utf8'));
  const terms = parsed.terms.map((t) => t.term);
  for (const t of ['积分占决赛30%', '积分占决赛 30%', '积分占比决赛30%', '积分占比决赛 30%', '占决赛30%', '占决赛 30%']) {
    assert.ok(terms.includes(t), `P0 已证伪词条不许被删：${t}`);
  }
});

test('CLI：真实仓库跑一遍扫描闸 → 退出码 0（排除项与豁免都打印出来，不静默）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: PLATFORM_DIR });
  assert.equal(r.status, 0, `真实仓库扫描必须通过（退出码 0）\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /未发现禁用表述/);
  assert.match(r.stdout, /排除 \d+ 项/);
  assert.match(r.stdout, /platform\/scripts\/forbidden\.txt（默认排除）/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd platform && node --test test/audit-scan.test.js`
Expected: FAIL —— `Cannot find module '../scripts/audit-scan.js'`

- [ ] **Step 3: 创建 `scripts/audit-scan.js`**

```javascript
// scripts/audit-scan.js — 发布前证据链扫描闸
// 依据：R-AUD-03「禁用词/证伪清单扫描：禁用清单必须真有词条，空清单不等于已保护」
//   溯源：evidence-chain Skill 闸 3；项目自己的踩坑记录——
//   「跑扫描发现 forbidden.txt 存在但无词条 —— 该闸未生效」。
// ⛔ 清单为空 → 直接报错退出（不静默通过）。
// ⛔ 排除项（清单自身、扫描器、测试夹具、被跳过的目录）必须在报告里打印出来——不静默的排除。
// ✅ 语法已与共享 skill 对齐（2026-10-20）：
//    共享的 `~/.minimax/skills/evidence-chain/scripts/audit-evidence.js` 现已支持
//    `@skip-path <路径正则>` 与 `<禁用词>|<豁免正则1>,<豁免正则2>` 两种语法，
//    并且空清单告警、回环地址不计入发行方、占位符密度只统计正文（不含围栏代码块）。
//    本平台的扫描器与它【必须行为一致】——同一个 forbidden.txt 在两边跑，结果不能不同。
// 用法：node scripts/audit-scan.js [root...]   默认扫 ../docs 与 .（即 platform/）
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PLATFORM_DIR, '..');

const TEXT_EXT = new Set(['.md', '.txt', '.js', '.json', '.sql', '.html', '.css', '.yml', '.yaml']);
const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'data', 'dist', 'build', 'coverage',
  'forbidden.txt', 'audit-scan.js', '*.test.js',
];

/**
 * 解析禁用清单。
 * 语法：
 *   <禁用词>[|<豁免正则1>,<豁免正则2>]   命中即违规；同行命中豁免正则 → 记为"更正语境"，不计违规但会出现在报告里
 *   @skip-path <路径正则>                整条路径跳过（相对仓库根；排除项会打印）
 *   # 开头为注释，空行忽略
 */
export function parseManifest(text) {
  const terms = [];
  const skipPaths = [];
  const errors = [];
  const seen = new Set();

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@skip-path')) {
      const pattern = line.slice('@skip-path'.length).trim();
      if (!pattern) {
        errors.push('@skip-path 后面必须跟路径正则');
        continue;
      }
      try {
        skipPaths.push(new RegExp(pattern));
      } catch (e) {
        errors.push(`@skip-path 正则非法：${pattern}（${e.message}）`);
      }
      continue;
    }
    const [term, exemptPart] = splitOnce(line, '|');
    const t = term.trim();
    if (!t) {
      errors.push(`清单里有一行只有分隔符没有词条：${line}`);
      continue;
    }
    if (seen.has(t)) {
      errors.push(`清单里有重复词条：${t}`);
      continue;
    }
    seen.add(t);
    let exemptRegex = null;
    if (exemptPart !== null) {
      const pattern = exemptPart.split(',').map((s) => s.trim()).filter(Boolean).join('|');
      if (pattern) {
        try {
          exemptRegex = new RegExp(pattern);
        } catch (e) {
          errors.push(`词条「${t}」的豁免正则非法：${pattern}（${e.message}）`);
        }
      }
    }
    terms.push({ term: t, exemptRegex });
  }

  if (terms.length === 0) {
    // ⛔ 空清单 = 闸未生效。这是最重要的一个失败。
    errors.push('禁用清单为空 —— 闸未生效（空清单 ≠ 已保护）。请在 scripts/forbidden.txt 写入真实禁用词条。');
  }
  return { terms, skipPaths, errors };
}

function splitOnce(line, ch) {
  const i = line.indexOf(ch);
  if (i < 0) return [line, null];
  return [line.slice(0, i), line.slice(i + 1)];
}

/**
 * 逐行扫描一段文本。
 */
export function scanText(text, terms, { file = '<text>' } = {}) {
  const violations = [];
  const exempted = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const { term, exemptRegex } of terms) {
      if (!line.includes(term)) continue;
      if (exemptRegex && exemptRegex.test(line)) {
        exempted.push({ file, line: idx + 1, term, text: line.trim() });
      } else {
        violations.push({ file, line: idx + 1, term, text: line.trim() });
      }
    }
  });
  return { violations, exempted };
}

function isExcluded(relPath, baseName, excludePaths) {
  for (const pattern of excludePaths) {
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
      if (re.test(baseName) || re.test(relPath)) return true;
    } else if (baseName === pattern || relPath.endsWith(sep + pattern)) {
      return true;
    }
  }
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 扫描一组目录/文件。
 */
export function scanRoots(roots, { terms, skipPaths = [], excludePaths = DEFAULT_EXCLUDES }) {
  const violations = [];
  const exempted = [];
  const scannedFiles = [];
  const excludedPaths = [];
  const visited = new Set();

  const walk = (target) => {
    const abs = resolve(target);
    if (visited.has(abs)) return;
    visited.add(abs);
    if (!existsSync(abs)) return;

    const info = statSync(abs);
    const rel = relative(REPO_ROOT, abs);

    if (skipPaths.some((re) => re.test(rel))) {
      excludedPaths.push({ path: rel, reason: '@skip-path' });
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        if (isExcluded(rel ? join(rel, entry) : entry, entry, excludePaths)) {
          excludedPaths.push({ path: relative(REPO_ROOT, join(abs, entry)), reason: '默认排除' });
          continue;
        }
        walk(join(abs, entry));
      }
      return;
    }
    if (!TEXT_EXT.has(extname(abs).toLowerCase())) return;
    if (isExcluded(rel, abs.split(sep).pop(), excludePaths)) {
      excludedPaths.push({ path: rel, reason: '默认排除' });
      return;
    }
    const text = readFileSync(abs, 'utf8');
    scannedFiles.push(rel);
    const r = scanText(text, terms, { file: rel });
    violations.push(...r.violations);
    exempted.push(...r.exempted);
  };

  for (const root of roots) walk(root);
  return { violations, exempted, scannedFiles, excludedPaths };
}

/**
 * 命令行入口。
 */
export function main(argv = []) {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, 'forbidden.txt');
  if (!existsSync(manifestPath)) {
    console.error('[audit-scan] 禁用清单缺失：scripts/forbidden.txt —— 闸未生效，发布中止');
    return 2;
  }
  const parsed = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (parsed.errors.length) {
    console.error('[audit-scan] 禁用清单不合规：');
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 2;
  }

  const roots = argv.length ? argv : [join(here, '..', '..', 'docs'), join(here, '..')];
  const report = scanRoots(roots, { terms: parsed.terms, skipPaths: parsed.skipPaths });

  console.log(`[audit-scan] 词条 ${parsed.terms.length} 条｜扫描 ${report.scannedFiles.length} 个文件`);
  console.log(`[audit-scan] 排除 ${report.excludedPaths.length} 项（排除不静默）：`);
  for (const e of report.excludedPaths.slice(0, 50)) console.log(`  - ${e.path}（${e.reason}）`);
  if (report.exempted.length) {
    console.log(`[audit-scan] 豁免命中 ${report.exempted.length} 处（更正语境，不计违规）：`);
    for (const e of report.exempted) console.log(`  - ${e.file}:${e.line} 「${e.term}」`);
  }
  if (report.violations.length) {
    console.error(`[audit-scan] ✗ 发现 ${report.violations.length} 处禁用表述：`);
    for (const v of report.violations) console.error(`  - ${v.file}:${v.line} 「${v.term}」 ${v.text}`);
    return 1;
  }
  console.log('[audit-scan] ✓ 未发现禁用表述');
  return 0;
}

// ⚠️ 必须按 realpath 比较：macOS 的 /tmp → /private/tmp、/var → /private/var 都是符号链接，
// 直接比字符串会不相等 ⇒ isMain 判 false ⇒ 脚本【什么都不做、退出码 0】＝静默放行。
// 对一道发布闸来说，「静默通过」是最坏的失败模式（R-AUD-03 的同类病）。
function realPathOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}
const isMain = process.argv[1] && realPathOrSelf(process.argv[1]) === realPathOrSelf(fileURLToPath(import.meta.url));
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 4: 修改 `scripts/forbidden.txt`**

```text
# scripts/forbidden.txt — 发布前证据链扫描闸的禁用词条清单
# 依据：R-AUD-03「禁用清单必须真有词条，空清单不等于已保护」
#   溯源：evidence-chain Skill 闸 3；周报 2026-10-12~18 §4.2 教训 5
#
# 语法：
#   <禁用词>[|<豁免正则1>,<豁免正则2>]
#     · 禁用词：**字面串**（不是正则！）—— 整行包含即算违规
#       ⚠️ 词条里写 `?` 或 `.*` 在字面匹配下**永远不会命中**
#          （scanText 用的是 line.includes(term)，不是正则匹配）——
#          这类占位写法会让清单「看着有词条、实际一条都不拦」＝闸被架空。
#       ⚠️ 空格变体必须各写一条（`四维各25%` 与 `四维各 25%` 是两条词条）。
#     · 豁免正则：同一行命中该正则 → 视为「更正语境」，不计违规，但会出现在扫描报告里
#   @skip-path <路径正则>   整条路径跳过（相对仓库根）。排除项会在报告里打印，不静默。
#   # 开头为注释，空行忽略
#
# ⚠️ 本文件不得为空：清单为空 = 闸未生效，audit-scan.js 直接报错退出（退出码 2）。
#   空清单 ≠ 已保护。每完成一次证伪，就把对应词条写进来。
#
# 实施计划按设计要【引用并纠正】原始错误表述（例如把冲突两方都写出来），
# 对计划文件一刀切会让计划本身写不下去。计划文件不是对外交付物，故整目录跳过。
# ⚠️ 这条规则必须【生效】（不能写成注释）—— 计划目录里逐字引用着禁用词，
#    规则失效时扫描闸会把计划文档本身判成违规（实测退出码 1）。
@skip-path ^docs/superpowers/plans/
#
# ── P4 追加：已被裁决为错误、但仍可能残留的表述 ─────────────────
# C-01：初赛 w_E 裁决为 10%（rule-decisions.md 初赛权重表合计正好 100%）
初赛企业确认权重20%|C-01|冲突|裁决|已更正
初赛企业确认权重 20%|C-01|冲突|裁决|已更正
# 四维各 25% 的旧表述（应为「创新 20% / 技术可行 20% / 完成度 25% / 协作 15%」等六维表）
四维各25%|原表述|有误|已更正|CICC[^，。]*已
四维各 25%|原表述|有误|已更正|CICC[^，。]*已
# 行为分进总分的旧表述（S10 §3.3 行为分只做垫底排序，不进总分）
行为分计入总分|已更正|S10 §3.3|只做
#
# ─────────────────────────────────────────────────────────────
# 2026-10-09 已证伪：AdventureX「积分占决赛 30%」
#
# 证伪依据：该规则无任何官方来源。源头是一份飞书 wiki 内部讨论笔记，
#           作者自己就写着「积分到底靠不靠谱？」。AdventureX 的评审实为
#           「指引者」按创意/技术复杂性/社会影响力三维打分制，并非积分制。
# 危害：曾被 22 个文件、57 处当作已验证先例引用；并于 10/15 从第三条路径
#      回流进另一份深卡，还与同卡另一处的「0%」标注自相矛盾。
# 登记时点：2026-10-09 竞品复核报告（第二轮）
# 残留面：原项目全库 20 个文件仍有残留（39+18+8 处）
#
# 变体全部登记 —— 空格差异是最常见的绕过方式。
积分占决赛30%
积分占决赛 30%
积分占比决赛30%
积分占比决赛 30%
占决赛30%
占决赛 30%
#
# ─────────────────────────────────────────────────────────────
# 后续证伪请继续追加到本节下方，每条注明：证伪日期 / 证伪依据 / 危害 / 残留面。
#
# ⚠ 反例（不要写进本清单）：
#   「CICC 四维各 25%」虽然已被证伪（S7 §1.1 更正为初赛/决赛各 6 维），
#   但它必须能出现在**更正语境**里（说明当初错在哪）。
#   → 本清单用「词条 + 更正语境豁免」处理它：裸引用（当现行规则写）会被拦下；
#     带「原表述 / 有误 / 已更正 / S7 §1.1」等更正标记的引用放行，但记进扫描报告。
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/audit-scan.test.js`
Expected: PASS（20 个测试全过：audit-scan.test.js 20 —— 规格自带 7 + 父代理预审补测 13）

- [ ] **Step 6: 实跑扫描闸**

Run: `cd platform && node scripts/audit-scan.js`
Expected: 输出 `[audit-scan] 词条 11 条｜扫描 N 个文件` … `[audit-scan] ✓ 未发现禁用表述`，退出码 0

- [ ] **Step 7: 验证"闸未生效"会被拦下（人工验证，不改仓库文件）**

Run: `cd platform && D=$(mktemp -d) && cp -R scripts "$D/" && printf '# 只有注释，没有词条\n' > "$D/scripts/forbidden.txt" && node "$D/scripts/audit-scan.js"; echo "退出码=$?"`
Expected: 打印「[audit-scan] 禁用清单不合规：」+「禁用清单为空 —— 闸未生效（空清单 ≠ 已保护）…」，**退出码 2**

> ⚠️ 必须在**副本**上清空清单，不能清空仓库里的 `scripts/forbidden.txt`（闸本身就是靠它生效的）。
> 走副本路径（`/tmp` 是符号链接）正好也验了 `isMain` 的 realpath 修正（P4-22）。
> （原命令只调 `parseManifest`、没跑 CLI、也没验退出码 ⇒ 已改，见 P4-25。）

- [ ] **Step 8: 提交**

```bash
git add platform/scripts/audit-scan.js platform/scripts/forbidden.txt platform/test/audit-scan.test.js docs/superpowers/plans/2026-10-20-platform-P4-audit-anticheat.md
git commit -m "feat(P4): 发布前证据链扫描闸（清单为空即报错，豁免语境可放行）" -- platform/scripts/audit-scan.js platform/scripts/forbidden.txt platform/test/audit-scan.test.js docs/superpowers/plans/2026-10-20-platform-P4-audit-anticheat.md
```

---

## Task 7 父代理预审修正台账（2026-10-21）

> Task 7 是**发布前证据链扫描闸**的落地，也是全局约束「`platform/scripts/forbidden.txt` 不得为空」
> 与 R-AUD-03「空清单 ≠ 已保护」这条纪律的**唯一执行点**。
> 实施前把规格的代码块抽到 `/tmp/p4t7/` 的独立工程实跑（**先跑后派**）——
> 规格自带的代码块在**「闸到底拦不拦得住」这条路径**上有 4 处硬伤：
> 其中 2 处让闸**静默放行**、1 处让闸**永远拦不住任何东西**、1 处让 2 条用例直接红；
> 另有 2 处是规格自身的不自洽（词条条数对不上、验证命令没验到退出码）。
> 变异体 **30** 个 → **KILLED 27 / 等价或不可观测 3 / 有效缺口 0**。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P4-19** | **Critical** | **清单里 3 条词条是「永远命中不了」的死词条** —— 规格的 `scanText()` 用 **`line.includes(term)`**（字面串匹配，规格自己的语法说明也写着「禁用词：整行包含即算违规」），但规格清单里有 3 条写成了**正则占位**：`初赛企业确认权重 ?20%` / `w_E ?= ?20%.*初赛` / `四维各 ?25%` —— `?` 与 `.*` 在字面匹配下没有意义 | 把**真实错误表述**写进文档（`CICC 四维各 25%`、`初赛企业确认权重 20%`）后跑闸 → 输出 `[audit-scan] ✓ 未发现禁用表述`，**退出码 0**；逐条 `text.includes(term)` 全为 `false`（`/tmp/p4t7/probe-bad-entries.txt`） | 按本项目既有约定「**空格变体各写一条**」改成字面串：`初赛企业确认权重20%` / `初赛企业确认权重 20%` / `四维各25%` / `四维各 25%`；`w_E ?= ?20%.*初赛` **整条删掉**（P6 计划 Step 4 已写明同样处置：「它把正则片段（`.*`）写进了字面串，在字面匹配下没有意义」）。**不改 `scanText` 的匹配语义**（与 P6 计划「P4 的行为与测试都不动」一致） |
| **P4-20** | **Critical** | **规格清单里的 `@skip-path` 规则写在注释里 ⇒ 闸失效 ⇒ 闸把计划文档自己判成违规** —— 规格 Step 4 的清单里 `@skip-path ^docs/superpowers/plans/` 前面带 `#`（是注释），规则**不生效** ⇒ 计划目录被扫 ⇒ 计划文档里逐字引用着禁用词 | 按规格原样落地后 `node scripts/audit-scan.js` → **退出码 1**，报 5 处违规，其中 3 处正是禁用词自身的引用（`docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md:1737 / :1776 / :4162`）。⇒ **规格自己的 Step 4 → Step 6 不自洽**（Step 6 期望退出码 0） | `@skip-path ^docs/superpowers/plans/` 改成**生效**的规则（说明文字保留为注释）。⚠️ P0 建的那份清单里这条规则**本来就是生效的** —— 规格 Step 4 的「整文件替换」把它降级成了注释 |
| **P4-21** | **Critical** | **规格 Step 4 用「整文件替换」抹掉了 P0 已证伪的 6 条词条** —— P0 的 `scripts/forbidden.txt` 里登记了 AdventureX「积分占决赛 30%」的 6 个变体（各带证伪依据），规格的整文件块把它们全删了 ⇒ 闸的覆盖面**下降** | `git show 0345ccd:platform/scripts/forbidden.txt` → 6 条词条（`积分占决赛30%` / `积分占决赛 30%` / `积分占比决赛30%` / `积分占比决赛 30%` / `占决赛30%` / `占决赛 30%`）；规格 Step 4 块里**一条都没有** | 保留 P0 的 6 条词条与证伪注释，在其后**追加** P4 的词条（「**补齐**」而不是「替换」）；并补一条用例钉住「P0 已证伪词条不许被悄悄删掉」 |
| **P4-22** | **Critical** | **规格实现的 `isMain` 用字符串比较 ⇒ 符号链接路径下闸【什么都不做、退出码 0】** —— `fileURLToPath(import.meta.url)` 是 **realpath**，`process.argv[1]` 是**调用方给的路径**；macOS 的 `/tmp → /private/tmp`、`/var → /private/var` 都是符号链接 ⇒ 两者不相等 ⇒ `isMain` 假 ⇒ 脚本不执行任何扫描，静默退出 0 | `node /tmp/.../audit-scan.js <root>` → `status=0`、`stdout=""`、`stderr=""`（探针：`argv[1]=/tmp/...` vs `import.meta.url=file:///private/tmp/...`）。**这正是 R-AUD-03 要防的「静默通过」** —— 而且发生在「脚本被绝对路径调用」这种最常见的用法上 | 改成按 **realpath** 比较（`realPathOrSelf()` 包装，解析失败退回原串）。⚠️ 这条是**实跑才暴露**的：规格的 7 条用例全是函数级调用，**没有一条会走 CLI 入口**，所以 `isMain` 写错也不会红 |
| **P4-23** | **Important** | **规格自带的测试文件用了 `readFileSync` 却没 import** —— 第 6、7 条用例要读仓库里的清单，但 import 行只有 `mkdtempSync, writeFileSync, mkdirSync, rmSync` | 按规格原样跑 `node --test test/audit-scan.test.js` → `# tests 7 / # pass 5 / # fail 2`，两条 error 都是 `ReferenceError: readFileSync is not defined` | import 补 `readFileSync`（并加 `copyFileSync` 供 CLI 用例造沙箱） |
| **P4-24** | **Minor** | **规格 Step 6 期望「词条 5 条」，与它自己的清单（4 条）就对不上** | 规格清单解析出 **4** 条词条（3 条还是死词条）；落地后是 **11** 条（P0 6 + P4 5） | Step 6 的 Expected 改成实际条数；Step 5 的 Expected 改成实际用例数（7 → 20） |
| **P4-25** | **Minor** | **规格 Step 7 的验证命令没验到退出码** —— 命令写的是 `printf '# 只有注释\n' > /tmp/empty-forbidden.txt && node -e "…parseManifest…"`：① 写出来的文件**根本没被用**；② 只调了 `parseManifest`，**没有跑 CLI**，而 P4-9 要验的是「清空后**重跑** → 退出码 2」 | 原命令实跑只打印一个 errors 数组，退出码 0 —— 闸的**退出码语义一条都没验到** | Step 7 改成真跑 CLI：复制 `platform/` 到 /tmp → 清空清单 → `node scripts/audit-scan.js` → 期望**退出码 2** + 报「禁用清单为空 —— 闸未生效」 |

### 二、变异检验发现的覆盖盲区（**已补测**，不是实现缺陷）

| # | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|
| — | **「清单里有重复词条」这条检查没有任何用例** —— 规格自带的第 7 条用例只检查**仓库自带清单**没重复，并没有检查 `parseManifest` **会不会发现**重复 ⇒ 把 `if (seen.has(t))` 整段摘掉，20 条用例全绿 | 变异体 **M04 存活**（`exit=0`） | 补用例：`parseManifest('禁用词\n禁用词\n')` ⇒ `terms.length === 1` 且 errors 含「重复词条」。M04 随即被 **KILLED** |
| — | **规格的 7 条用例全是函数级调用，CLI 入口（`main`）一行都没被验到** —— 退出码 0/1/2 三种语义、清单缺失、豁免是否打印、排除是否打印，规格里**一条用例都没有** | 变异体 M21/M22/M23/M24/M25/M26/M27 在规格的 7 条用例下**全部存活** | 补 6 条 CLI 级用例（`spawnSync` 跑真脚本）：清单为空 → 2；清单缺失 → 2；扫到违规 → 1 且报行号；干净 → 0；更正语境豁免记进报告；真实仓库跑一遍 → 0。M21~M27 随即全部被 **KILLED** |
| — | **「闸真的生效」这件事本身没有用例** —— 没有任何一条用例证明「清单里的词条能拦住真实写错的表述」；规格清单里 3 条死词条（P4-19）正因此一条用例都没红 | 变异体 **M28**（把词条改回 `?` 占位写法）在规格的 7 条用例下存活 | 补 2 条用例：① 仓库清单必须能拦住「CICC 四维各 25%」「初赛企业确认权重 20%」；② 清单里不许出现 `?` / `*` / `.*` 这类正则占位。M28 随即被 **KILLED** |

### 三、等价 / 不可观测变异体（**有探针差分实证**，不是凭推理放过）

> 变异脚本：`/tmp/p4t7/mutate.mjs`（30 个变异体，覆盖清单解析 / 词条匹配 / 豁免 / 排除 / 跳过路径 /
> 退出码 / 报告打印 / CLI 入口 / 清单本身）；探针：`/tmp/p4t7/probe.mjs`（对存活体跑「基线副本 vs 变异副本」
> 的扫描闸，逐项对比退出码与 stdout/stderr）。

| # | 级别 | 变异体 | 差分实证 | 结论 |
|---|---|---|---|---|
| **M17** | — | 排除判断去掉 `relPath.endsWith(sep + pattern)` 分支（只剩 `baseName === pattern`） | 探针跑真实仓库扫描闸：退出码 **0 = 0**、stdout **完全一致**、stderr **完全一致** | **等价**：本仓库里被排除的路径（`platform/scripts/forbidden.txt`、`platform/test/*.test.js` 等）**全部**满足两个分支之一，去掉任一分支结果不变 |
| **M18** | — | 排除判断去掉 `baseName === pattern` 分支（只剩 `relPath.endsWith`） | 同上：退出码 / stdout / stderr **三项全一致** | **等价**：两个分支的分歧点只有「仓库根目录下的同名裸文件」（rel 里没有分隔符），本仓库不存在这种路径（`forbidden.txt` 在 `platform/scripts/` 下）⇒ 不可达 |
| **M19** | — | 文件类型白名单失效（什么都读） | 退出码 **0 = 0**、stderr 一致；stdout 只差 1 行：`扫描 121 个文件` vs `扫描 122 个文件` —— 多读的是 `platform/src/.gitkeep`（空文件） | **不可观测（对放行/拦截结论）**：白名单只影响「读哪些文件」，而多读的那个是空文件 ⇒ 违规集、豁免集、退出码**完全不变**，只有报告里的文件计数差 1 |

### 四、Task 7 的测试条数口径与最终结果

**测试条数**：`audit-scan.test.js` **20**（规格自带 **7** + 父代理预审补测 **13**）；
P4 全量 **746/746**（本分支 Task 1 之后的基线实测 **726/726** —— 注：任务书里写的「723」与工作区实测的 726 差 3 条，以实测为准）。

**最终结果**：变异体 **30** → **KILLED 27 / 等价或不可观测 3 / 有效缺口 0**；
`audit-scan.test.js` **20/20**、P4 全量 **746/746**；
`cd platform && node scripts/audit-scan.js` → `[audit-scan] 词条 11 条｜扫描 121 个文件` … `[audit-scan] ✓ 未发现禁用表述`，**退出码 0**；
清单清空后重跑 → **退出码 2** + 「禁用清单为空 —— 闸未生效」。

**已知限制（登记，不在本 Task 修）**：
① 排除项清单**最多逐条打印 50 项**（总数照常打印）—— 真实仓库里是 62 项 ⇒ 最后 12 项只看得见数量、看不见路径；
② 默认扫描范围是 `docs/` 与 `platform/` —— 仓库根的《一页纸-证据链-调研结论质量.md》《周报_2026-10-12_至_10-18_AI大航海.md》里含 P0 词条（均在**更正语境**中），不在默认范围内；若将来把范围扩到仓库根，须先给这批词条加更正语境豁免；
③ 本 Task **没有改 `src/config.js`**（`rules.audit` 的加载与校验是 Task 3 / Task 4 的活）—— 扫描闸不读 `src/config.js`，清单是独立文件。


---

### Task 8: 端到端复算验收

**Files:**
- Test: `platform/test/recompute-e2e.test.js`

**Interfaces:**
- Consumes: Task 2 的 `recordComputation` / `recomputeAndDiff`；P2 的 `scoreStage` 与 `stage_reviews` 表
- Produces: 一条覆盖「打分 → 计算 → 快照 → 改一个原始分 → 复算 → diff 非空」的全链路验收测试

> **本 Task 锁定的跨阶段契约**（与 `INTERFACES.md` §3 一致）：
> `scoreStage({ config, judges, submissions, enterpriseConfirmations, peerReviews })` → `{ teams, warnings, trace }`；
> `stage_reviews(id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at, request_id, calibrated, deleted_at)`。
> 若 P2 的实际实现与该契约不符，**先修 P2**（P2 计划写的是同一份契约），不要在本测试里绕开。

- [ ] **Step 1: 写失败的测试**

`platform/test/recompute-e2e.test.js`：

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
import { scoreStage } from '../src/domain/scoring.js';
import { recordComputation, recomputeAndDiff } from '../src/services/audit.js';
import { getComputationRow } from '../src/db/repo/computations.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4e2e-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  return { db, close, dataDir, rules };
}

const JUDGES = ['j1', 'j2', 'j3', 'j4', 'j5'];
const TEAMS = ['t1', 't2'];
const DIMENSION = 'innovation';

function seedReviews(db) {
  const insert = db.prepare(
    `INSERT INTO stage_reviews (id, stage_id, judge_id, team_id, dimension, raw_score, submitted_at, request_id, calibrated, deleted_at)
     VALUES (?, 'st1', ?, ?, ?, ?, '2026-10-20T00:00:00.000Z', ?, 0, NULL)`,
  );
  let n = 0;
  for (const j of JUDGES) {
    for (const t of TEAMS) {
      n += 1;
      insert.run(`sr_${n}`, j, t, DIMENSION, 70 + n, `req_${n}`);
    }
  }
}

function buildInput(db, config) {
  const rows = db.prepare(
    "SELECT judge_id, team_id, dimension, raw_score FROM stage_reviews WHERE stage_id = 'st1' AND deleted_at IS NULL AND calibrated = 0",
  ).all();
  return {
    configKey: 'scoring.final',
    ruleVersion: `scoring.final@${config.version}`,
    config,
    judges: JUDGES.map((id) => ({ id })),
    submissions: rows.map((r) => ({
      judgeId: r.judge_id, teamId: r.team_id, dimension: r.dimension, rawScore: r.raw_score,
    })),
    enterpriseConfirmations: [],
    peerReviews: [],
  };
}

test('端到端：打分 → 计算 → 快照 → 改一个原始分 → 复算 → diff 非空且 identical=false', () => {
  const { db, close, dataDir, rules } = setup();
  seedReviews(db);
  const config = rules.scoring.final;
  const input = buildInput(db, config);

  const result = scoreStage({
    config,
    judges: input.judges,
    submissions: input.submissions,
    enterpriseConfirmations: input.enterpriseConfirmations,
    peerReviews: input.peerReviews,
  });
  // 跨阶段契约断言
  assert.ok(Array.isArray(result.teams), 'scoreStage 必须返回 teams 数组');
  assert.ok(result.teams.length > 0, 'scoreStage 必须给出队伍分数');
  assert.ok(result.teams.every((t) => t.teamId !== undefined), '每队必须有 teamId（diff 的 path 靠它定位）');

  const { id, revision } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: input.ruleVersion,
    input, output: result, trace: result.trace, now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(revision, 1);

  // ① 改数据之前：复算必须一致
  const before = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T01:00:00.000Z', rules,
  });
  assert.equal(before.identical, true, `改数据之前复算必须一致，warnings=${JSON.stringify(before.warnings)}`);

  // ② 改一个原始分（模拟原始数据被改动）
  db.prepare(
    "UPDATE stage_reviews SET raw_score = raw_score + 10 WHERE stage_id = 'st1' AND team_id = 't1' AND judge_id = 'j1' AND dimension = ?",
  ).run(DIMENSION);

  // ③ 用当前库里的数据重建输入（live 模式）再复算
  const liveInput = buildInput(db, config);
  const after = recomputeAndDiff({
    db, id, actorId: 'u_admin', now: '2026-10-20T02:00:00.000Z', rules, liveInput,
  });
  assert.equal(after.identical, false, '原始分被改后复算必须不一致');
  assert.ok(after.diff.length > 0, 'diff 不能为空');
  const paths = after.diff.map((d) => d.path);
  assert.ok(paths.some((p) => p.includes('t1')), `diff 必须定位到被改的队伍，实际：${JSON.stringify(paths)}`);

  // ④ 旧 revision 保留（重算走 revision + 1，不覆盖历史）
  const { id: id2, revision: revision2 } = recordComputation({
    db, kind: 'stage_score', stageId: 'st1', ruleVersion: input.ruleVersion,
    input: liveInput, output: result, trace: result.trace, now: '2026-10-20T03:00:00.000Z',
  });
  assert.equal(revision2, 2);
  assert.notEqual(id2, id);
  assert.equal(getComputationRow(db, id).revision, 1, '旧 revision 必须保留供复盘');
  close();
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd platform && node --test test/recompute-e2e.test.js`
Expected: PASS（1 个测试全过：recompute-e2e.test.js 1）

> ⚠️ 若这里报 `Cannot find module '../src/domain/scoring.js'`，说明 **P2 尚未落地**（本阶段依赖 P2 的 `scoreStage`）。
> 若报「scoreStage 必须返回 teams 数组」之类的断言失败，说明 P2 的实现与 `INTERFACES.md` §3 的契约不符 —— **修 P2，不要改本测试**。

- [ ] **Step 3: 全量测试**

Run: `cd platform && node --test`
Expected: 全部通过（含 P0 的既有测试）

- [ ] **Step 4: 实跑扫描闸 + 提交**

```bash
cd platform && node scripts/audit-scan.js
cd platform && git add test/recompute-e2e.test.js
git commit -m "test(P4): 端到端复算验收（改一个原始分 → diff 非空）"
```

---

## P4 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| P4-1 | 审计四表建出 | `cd platform && node --test test/audit-repo.test.js` 通过；`node scripts/migrate.js` 输出「迁移完成，当前版本 5」 |
| P4-2 | 复算 diff 能被看见 + 规则版本变更不静默 | `node --test test/audit-snapshot.test.js` 通过；实跑 `GET /api/audit/computations/:id/diff`：快照被改后返回非空 `diff` 且每条带 `path`（如 `teams[t1].total`）；规则版本变更时 `identical=false` 且 `warnings` 含 `rule_version_changed`（消息含「无法严格复算」） |
| P4-3 | 限频超限 429 + Retry-After，且计数落库 | `node --test test/rate-limit.test.js` 通过；实跑：对 `POST /api/appeals` 连发超过配额 → 状态 429、响应头含 `Retry-After`、响应体 `error.detail.retryAfterSeconds ≥ 1`；`select count(*) from rate_limit_events` > 0；换 db 连接（模拟重启）后仍超限 |
| P4-4 | 幂等只生效一次 | 同上文件中的「同一 request_id 重复提交只生效一次」用例通过：业务函数只被调用 1 次，重复请求返回**首次**的响应 |
| P4-5 | 状态机非法迁移被拒 + 幂等守卫不产生二次迁移 | `node --test test/review-state.test.js` 通过：`SUBMITTED → FINALIZED` 抛 409 且不落库；同一 `idempotencyKey` 触发两次 → `applied=false` 且 `audit_log` 里只有 1 条 `review_state.transition` |
| P4-6 | PENDING_REVIEW 分数不可见 | 同上文件中的可见性用例通过：其他评委拿到 `rawScore=null` + `hidden=true`，管理员看到全量；且该过滤发生在服务层（API 层）而非前端 |
| P4-7 | **检测 ≠ 处罚** | `node --test test/anticheat.test.js` 通过：所有 flag 的 `action='alert_only'`；`grep -n "UPDATE stage_reviews\|deactivateUser\|DELETE FROM users" platform/src/domain/anticheat.js platform/src/services/anticheat.js` 无命中（检测器不碰分数与账号） |
| P4-8 | 证据按发行方去重 | 同上文件中的证据用例通过：3 条 URL / 2 个发行方 → `uniquePublishers=2`、`dropped=1`；缺列 → 400 而不是静默丢弃 |
| P4-9 | 扫描闸真生效 | `node --test test/audit-scan.test.js` 通过；`node scripts/audit-scan.js` 退出码 0；把 `scripts/forbidden.txt` 清空后重跑 → 退出码 2 且报「禁用清单为空 —— 闸未生效」；故意写错的文档能被拦下并报出行号；更正语境能豁免但会被记录 |
| P4-10 | 端到端复算 | `node --test test/recompute-e2e.test.js` 通过：改一个原始分后 `identical=false`、`diff` 非空且定位到该队伍；旧 revision 保留 |
| P4-11 | 零依赖 | `node --test test/zero-deps.test.js` 通过；无 `node_modules`、无 `package-lock.json` |

---

## 与接口契约的偏差

### A. 新增模块（**不改动 `INTERFACES.md` 里任何既有签名**，只是把实现拆到本阶段新建的文件里）

| 文件 | 为什么需要它 |
|---|---|
| `src/errors.js` | 契约 §0 要求「抛 `AppError`（**status + code + message + detail，status-first**）」，**P0 的 Task 4 已建**（归属从 P1 提前到 P0）。本阶段只**追加** `badRequest` / `unauthenticated` / `forbidden` / `notFound` / `conflict` / `rateLimited` 六个快捷函数，**不重建 AppError、不重新定义 appError**；429 额外带 `retryAfterSeconds` |
| `src/db/tx.js` | 「事务回滚，无部分写入」（设计文档 §11）需要事务助手；用 SAVEPOINT 实现，可嵌套，调用方自己开了事务也不会炸 |
| `src/domain/diff.js` | 复算 diff 的比对逻辑是纯函数，必须留在 `domain/`（无 IO）；契约未列 |
| `src/domain/evidence.js` | R-AUD-04「证据三列 + 按发行方去重」需要一个纯函数模块 |
| `src/domain/field-dictionary.js` | R-AUD-06「并行前定字段字典」需要一个唯一的字段名来源 |
| `src/services/idempotency.js` | 契约把 `idempotency_keys` 列进了表结构，但没给服务层函数；幂等执行器（只生效一次 + 返回首次响应）需要一个独立模块 |
| `src/services/anticheat.js` | 契约只列了 `src/domain/anticheat.js`（纯函数）。检测结果落 `flagged_reviews`、裁决、复核队列列表属于 IO，放服务层 |
| `src/http/routes/audit.js` | P0 的 `src/server.js` 把路由内联在文件里；P4 有 7 个接口，内联会让 P0 的文件失控。**沿用 P1 / P2 已确立的 `src/http/routes/` 约定**（P1：`registration.js` / `taskPackage.js` / `team.js`；P2：`review.js`）——设计文档 §4.3 的目录清单里 `http/` 下就是 `router.js` / `respond.js` / `body.js` / `static.js` / `sse.js` / `routes/`，**顶层从来没有 `src/routes/`** |

> **【2026-10-21 漂移审计修正 I-4】**
> **原来错在哪**：本计划原来把 P4 的路由放在 **`src/routes/audit.js`**，并在上表里**建议**
> 「P1–P6 统一采用 `src/routes/*.js` 约定」。
> **为什么错**：这个「统一」的方向是**反的** —— P1（已落地）与 P2（已落地计划）用的是
> **`src/http/routes/`**，设计文档 §4.3 的目录清单里也只有 `http/` 下的 `routes/`，
> **顶层根本不存在 `src/routes/`**。照原写法实施 → 同一个项目出现**两个路由目录**，
> 功能上不炸（手工 `router.add`），但后续维护者按 `src/http/routes/` 找路由会**漏掉** P4 的文件，
> 且 P4 的「建议」会把 P5 也带偏。
> **改成什么**：P4 统一改用 `src/http/routes/audit.js` —— Files 清单、代码块文件头注释、
> `src/server.js` 的 import 路径（`'./http/routes/audit.js'`）、`git add` 列表、
> 文件结构树、以及上表的「统一约定」表述，全部改齐（**六处**）。
> **依据**：P1 终态 `platform/src/http/routes/`（3 个文件）、P2 计划 `src/http/routes/review.js`
> + 设计文档 §4.3 的目录清单 + 漂移审计报告 I-4。
| `src/db/repo/tiers.js` | 申诉范围判定要读 P3 的 `tier_records`（只读） |
| `src/db/repo/audit-log.js`（**P2 Task 4 已建**，本阶段只**追加** `queryAuditLog` / `findLatestTransition`） | ⚠️ 原写法是**新建**这个文件并再定义一个 `insertAuditLog`。那样同一张 `audit_log` 会出现**两条写路径**（P2 的 `writeAuditLog` 与 P4 的 `writeAuditLog`），「审计日志唯一入口」失守；且 `Create` 声明会让实施者**整体覆盖** P2 的仓储文件，把 P2 的 `insertAuditLogRow` / `queryAuditLogRows` 抹掉 → P2 的调用点直接崩。改为**单一归属**：SQL 全在 `src/db/repo/audit-log.js`，`src/audit/log.js` 只做薄门面（**P2 已建，本阶段一行不改**）。见 I-8 修正记录 |
| `src/http/routes/audit.js` | 路由属于 HTTP 层。**沿用 P1 / P2 已确立的 `src/http/routes/` 约定** —— 设计文档 §4.3 的目录清单里 `http/` 下就是 `router.js` / `respond.js` / `body.js` / `static.js` / `sse.js` / `routes/`，**顶层从来没有 `src/routes/`**。见 I-4 修正记录 |
| `rules/audit.json` | 限频配额、防作弊阈值、复核与申诉策略、留档月数、TOP10 回访——全部是「待组委会确认的机制件」，必须配置化（溯源表结论：60 条机制件不得硬编码） |

### B. 既有签名的**可选**扩展（保持向后兼容，按契约原样调用仍然成立）

| 契约签名 | 本阶段扩展 | 说明 |
|---|---|---|
| `recomputeAndDiff({ db, id, actorId, now })` | `+ rules?, liveInput?, engine?` | `rules` 用于规则版本比对（不传则退化为纯重放）；`liveInput` 用于「用当前库数据复算」；`engine` 默认 P2 的 `scoreStage`，测试可注入确定性桩 |
| `checkRateLimit({ db, subjectKey, rule, now })` | `+ limits, subjects?` | `limits` 必填（缺失直接 500，不静默用默认值放行）；`subjects` 允许同一 profile 里的不同层用不同 subject（如评委级小时配额按 judge 维度计数） |
| `recordComputation({ db, kind, editionId, stageId, teamId, ruleVersion, input, output, trace })` | `+ actorId?, now?` | 写审计日志需要操作者与时间戳 |
| `listAuditLog({ db, filter, viewer })` | `+ rules?, now?` | 留档窗口（6 个月）从 `rules.audit.retention` 取，不在代码里写死数字 |

### C. 枚举扩展（`flagged_reviews.kind`）

契约注释列了 5 个 kind，本阶段新增 2 个：

- `tied_mutual_peer_rate` —— R-RNK-08「同分互投率过高由组委会复核」需要一个落库位置（该 kind 不在契约的枚举里）
- `reverse_audit` —— R-JDG-16「TOP10 反向抽查」需要一个进复核队列的位置

另外：`flagged_reviews` 的 `stage_id` / `team_id` / `judge_id` 在契约里没有 `NOT NULL`，本阶段允许为空（多账号检测的产出可能没有单一赛段/队伍）。

**额外提供的接口**：`GET /api/appeals`（申诉列表）—— 契约 §5 的 API 清单里没有这一条，但委员会要在复核队列里看申诉。本阶段**只新增、不改动**契约内的 7 个接口。

### D. 需要上游配合的跨阶段契约（**不是对契约的修改，是把契约落到可执行**）

| 项 | 要求 | 找谁 |
|---|---|---|
| 快照 `input_json` 结构 | `{ configKey, ruleVersion, config, judges, submissions, enterpriseConfirmations, peerReviews }`；`config` 是权重表的**完整拷贝**；`ruleVersion` 形如 `scoring.final@2026-10-20` | P2 的 `computeStage` 必须按此写快照，否则 P4 无法重放 |
| `scoreStage` 返回值 | `{ teams: [{ teamId, seatP, seatE, total, perDimension }], warnings, trace }` | P2（与契约 §3 一致） |
| `stage_reviews` 表 | P2 的 `003_review.sql` | P2 |
| `tier_records` 表 | P3 的 `004_leaderboard.sql`（P4 只读） | P3 |
| `review-state` 接口过滤 | P2 的 `GET /api/stages/:stageId/review-state` 必须调用 `filterVisibleScores(...)`（**前端隐藏 = 已泄露**） | P2 |

### E. 发现的存量冲突（**本阶段不修**，需上游处理）

1. **迁移版本号撞车** —— ✅ **已消解**（2026-10-21 订正，见下方修正记录）：
   P0 终态 `platform/db/migrations/` 下**只有 `001_init.sql`**，**从未建过 `002_user_roles.sql`**；
   P1 的迁移是 `002_registration.sql`。全局唯一序位是 `001=P0`、`002=P1`、`003=P2`、
   `004=P3`、`005=P4`、`006=P5`，**没有两份计划抢同一个号**。本阶段的 `005_audit.sql` 编号与契约一致。
2. **P0 声明了但没建的文件**：P0 的 File Structure 里有 `src/audit/log.js`，但 P0 的 7 个 Task
   都没有创建它 —— **该文件由 P2 的 Task 4 建**（`src/db/repo/audit-log.js` + 薄门面）。
   本阶段**只复用**，不重复实现（见 I-8 修正记录）。
3. **P0 的 `error()` 没有自定义响应头能力**：`src/http/respond.js` 的 `error(res, status, code, message, detail)` 装不下 `Retry-After`。本阶段追加可选第 6 参 `extraHeaders`（向后兼容，P0 现有调用不用改）。
   ⚠️ **但调用点不得回退 P0 终审 I-C**（2026-10-21 漂移审计修正 C-1）：追加第 5、6 参时，
   第 4 参 `message` 必须**仍是** `err instanceof AppError ? err.message : '请求无效'`
   （不是 `err.message`），第 5 参 `detail` 必须**仍是** `err instanceof AppError ? err.detail : undefined`
   （不是 `err.detail`）—— 否则 4xx 会把 SQLite 原文重新放回响应体。
   照做会当场让 P0 的 3 个用例变红（审计实跑：`not ok 88` / `not ok 112` / `not ok 115`）。
   详见 C-1 修正记录。

> **【2026-10-21 漂移审计修正 I-9 + M-4】**（§E 第 1 条）
> **原来错在哪**：这一条原来写的是「P0 计划 Task 6 建了 `db/migrations/002_user_roles.sql`，
> 而 `INTERFACES.md` §2 规定 P1 的迁移是 `002_registration.sql`。两者的版本号都是 2 …
> **P1 执行前必须改号（建议 P1 的 `002_registration` → `003_registration`）**」。
> **为什么错（两层）**：
> ① **事实已过期** —— P0 终态的 `platform/db/migrations/` 下**只有 `001_init.sql`**，
> `002_user_roles.sql` **从未存在**；P1 落地的是 `002_registration.sql`，两者本就不同号，
> 这个「冲突」在 P1 落地时就不存在。
> ② **建议本身是危险的** —— 若被采纳，把 P1 的 `002` 改成 `003`，就会与 **P2 自己的
> `003_review.sql` 撞号**（全局唯一序位 `001=P0 / 002=P1 / 003=P2 / 004=P3 / 005=P4 / 006=P5`），
> 把「P0/P1 撞号」换成「P1/P2 撞号」→ `applyMigrations` 的重复版本号检测**响亮抛错**
> （基线 `src/db/migrate.js` 的 `readMigrationFiles()`）→ **`003_review.sql` 永远建不出来**，
> P2 的全部评审表缺失，后面 004/005/006 全部建在错误的基线上。
> **改成什么**：改写为「**已消解**」的现状陈述，显式钉住全局唯一序位，**删除「建议改号」**。
> **依据**：`git ls-tree` 实测 —— `.worktrees/p0-foundation` 的 `platform/db/migrations/`
> 只有 `001_init.sql`；`.worktrees/p1-registration` 的有 `001_init.sql` + `002_registration.sql`；
> 基线 `platform/src/db/migrate.js` 的重复版本号检测（抛「迁移版本号重复」）+
> 漂移审计报告 I-9 / M-4。同一事实的另一半在 P2 的偏差表 D-18，已按同一口径改写。

### F. 一处口径调和（不是冲突，是把两句话的适用边界写清楚）

- 全局约束「列表不满足 → 200 + 空集」与 R-AUD-05「空结果必须显式报错」**适用范围不同**：
  - **读取类列表**（`GET /api/audit/log`、`GET /api/audit/flags`、`GET /api/appeals`）→ 仍按三态返回 `200 + 空集`（不暴露"有但不给看"）。
  - **批量写入 / 批处理类**（批量评分、批量提交、申诉提交、复算、扫描）→ 返回空必须 4xx。本阶段的落点：申诉理由为空 → 400、证据缺列 → 400、禁用清单为空 → 退出码 2、复算输入缺失 → 抛错、限频未配置 → 500。

### G. Task 1 实施后的偏差（与 `INTERFACES.md` 的文件归属表对齐）

| # | 偏差 | `INTERFACES.md` 的写法 | 本阶段的写法 | 理由 |
|---|---|---|---|---|
| 1 | **`src/db/repo/computations.js` 的 `nextRevision` / `insertSnapshot` 被**扩展**而非重定义** | 文件归属表写「`src/db/repo/computations.js` = **P2**，P4 **追加** `nextRevision` / `listComputationRows`」 | P4 **扩展** P2 已有的 `nextRevision`（加可选 `teamId`）与 `insertSnapshot`（加可选 `id`），**只新增** `listComputationRows`；**不建** `insertComputation` / `getComputationRow` 这对与 P2 近义的函数 | ① P2 的 `nextRevision` **已经存在**（`src/services/compute.js:204` 在用），契约那行「P4 追加 `nextRevision`」是**照 P2 落地前的设想写的**，实际落地时 P2 已建 —— 照字面「追加」= 同名导出重复声明 = **整个平台加载不了**（已实跑三种读法全部失败）。② 契约同表明写「计算快照表由 P2 的 `003_review.sql` 建，写入方是 P2 的 `computeStage`」⇒ P4 不该另起一条写路径。③ `listComputationRows` 与 P2 的 `listSnapshots` **语义不同**（最近优先 + 分页 vs 赛段内按 revision 升序），不是同一件事的第二个名字 |
| 2 | **`insertIdempotency` 用「try + 只认唯一约束」而不是 `INSERT OR IGNORE`** | 契约只给了 `idempotency_keys(key, scope, request_id, response_json, created_at, PRIMARY KEY(key, scope))` 的表结构，**未规定实现** | try INSERT + 兜底正则只认 `UNIQUE constraint failed: idempotency_keys`，其它错误照抛 | `INSERT OR IGNORE` 会把**所有**约束冲突（含 NOT NULL 违规、磁盘写满）一并吞掉 ⇒ 返回 `false`（=「重复请求」）⇒ **调用方以为写成功了，实际一条都没落库**。这正是 P1 的 T-7 踩过的坑，P2 的 `claimRequestKey` 也是同款实现 ⇒ 与全项目口径一致 |

### H. Task 2 实施后的偏差

| # | 偏差 | 规格的写法 | 本阶段的写法 | 理由 |
|---|---|---|---|---|
| 1 | **`src/services/audit.js` 复用 P2 的 `insertSnapshot` / `getSnapshot`** | 规格调 `insertComputation` / `getComputationRow` | 改成 `insertSnapshot` / `getSnapshot`（P2 已建，`src/services/compute.js` 在用） | 与 §G 第 1 行**同款裁决**：P2 已建这两个函数；另起近义名 = 同一张表两条写路径 + 同名导出重复声明的风险。**依据**：`INTERFACES.md` 文件归属表「`src/db/repo/computations.js` = **P2**，P4 追加」 |
| 2 | **测试补 `seedRefs(db)` 外键夹具** | 规格用例直接用 `'u_admin'` / `'st1'` | 加 `seedRefs(db)`：建 `users` / `editions` / `stages` / `teams` 四类被引用的行 | `PRAGMA foreign_keys = ON`（`src/db/sqlite.js`）；不建被引用的行必然 `FOREIGN KEY constraint failed`（与 P4-5 同款） |
| 3 | **测试补 8 例** | 规格自带 11 例 | 19 例 | 变异检验暴露的**有效缺口**（详见「Task 2 父代理预审修正台账」二）；补测**只加断言不改语义** |

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

---

## Task 1 父代理预审修正台账（2026-10-21）

> Task 1 是 P4 的地基：**4 张新表 + 仓储层 + 事务/错误基础设施**。
> 实施前做了一次**独立工程实跑**（把规格的代码块抽到 `/tmp` 的副本里跑通再落盘 —— 「先跑后派」），
> **实证了 5 处规格自带缺陷**；实施完成后做**变异检验**，变异体 **20** 个，
> 首轮 **8 条存活**，补完用例后 **20/20 杀灭**。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P4-1** | **Critical** | **`src/db/repo/computations.js` 的写法会让**整个平台无法加载**。P2 的 Task 6 已经建了这个文件里的 `nextRevision`（`src/services/compute.js:204` 在用它），而规格的代码块**又定义了一遍** `nextRevision` / `insertComputation` / `getComputationRow` —— 同名导出重复声明 ⇒ `SyntaxError` ⇒ 模块加载失败 ⇒ **平台全挂** | 沙箱实跑三种字面读法：**读法 A**（片段当整文件覆盖）→ `AppError`/`appError` 被抹、`audit_log` 的 P2 写入口消失 → `src/audit/log.js` 导入失败；**读法 B**（片段按追加）→ `nextRevision` 重复导出 + `randomUUID` 重复 import → SyntaxError；**读法 C**（整文件覆盖）→ P2 的 `insertSnapshot`/`getSnapshot`/`getSnapshotInStage`/`upsertStageResult`/`resetStageResults` 全被抹 → `src/services/compute.js` 导入失败。**三种读法都让 `server.js` 加载不了** | **不重定义 P2 的函数**：`nextRevision` **加可选 `teamId`**（不传时行为与 P2 一字不差）、`insertSnapshot` **加可选 `id`**（默认仍是随机 UUID）；P4 **直接复用** P2 的 `insertSnapshot` / `getSnapshot`，**只新增** `listComputationRows`（语义与 P2 的 `listSnapshots` 不同：最近优先 + 分页，给审计列表用）。**依据**：`INTERFACES.md` 的文件归属表「`src/db/repo/computations.js` = **P2**，P4 追加」 |
| **P4-2** | **Critical** | **`src/errors.js` 与 `src/db/repo/audit-log.js` 是「追加型片段」**，规格却把它们写成整文件代码块。照抄即**抹掉 P0 的 `AppError`/`appError` 与 P2 的 `insertAuditLogRow`/`queryAuditLogRows`** | 同上「读法 A」的实跑输出 | 两个块改成「**追加段**」：计划里放的正是实现相对上游**多出来的那一段**（逐字），并在块首写明「P0/P2 已建，本阶段只追加」 |
| **P4-3** | **Important** | **`insertIdempotency` 用 `INSERT OR IGNORE`** —— 那会把**所有**约束冲突（含 NOT NULL 违规、磁盘写满）一并吞掉 ⇒ 返回 `false`（=「重复请求」）⇒ 调用方以为写成功了，实际一条都没落库。**这正是 P1 的 T-7 踩过的坑**（registrations 的兜底正则被收紧） | 变异 M17（兜底放宽成「所有错误都返回 false」）→ 存活：没有用例能区分「重复请求」与「写失败」 | 改成 **P2 `claimRequestKey` 同款**：try INSERT + **只认** `UNIQUE constraint failed: idempotency_keys` 的兜底正则，其它错误照抛；并补一条「NOT NULL 违规必须继续往上抛」的用例 |
| **P4-4** | **Important** | **规格自带的用例本身有三处与实现矛盾**（照抄必然红） | ① `listFlagRows` / `listAppealRows` 规格实现返回 `{rows, total}`，但用例按数组用（`after.length` / `after[0].reviewed_by`）—— 而 Task 4/5 的代码块（`const { rows, total } = listFlagRows(...)`）证明**对象形状才是正确口径**，是这三条用例写错了；② `assert.throws(..., /BOOM/)` 匹配的是 `message`，而 `appError(500,'BOOM','中途失败')` 的 `message` 是「中途失败」、`code` 才是 `BOOM`；③ 限频用例给两个 bucket 传了**同一个 `now`**，但注释与断言描述的是「一个在窗口内、一个在窗口外」 | 跑规格自带用例 → 4 条红（2 条 FOREIGN KEY + 1 条 `/BOOM/` + 1 条限频计数 0≠2） | ① 用例改成解构 `{ rows }`；② 改成按 **`code`** 断言；③ 限频数据集改成**两个 bucket 落在窗口内外两侧**（s:100 在窗口内 count 2、s:050 在窗口外 count 1），并补一条「全量口径 3 ≠ 窗口口径 2」的判别性断言 |
| **P4-5** | **Important** | **规格的测试没有建被外键引用的行** —— `audit_log.actor_id REFERENCES users(id)`、`computation_snapshots.stage_id REFERENCES stages(id)`、`team_id REFERENCES teams(id)` ⇒ 照抄用例直接 `FOREIGN KEY constraint failed` | 跑规格自带用例 → 4 条红 | 测试加一个 `seedRefs(db)`：`u_admin` / `ed_1` / `st1` / `t1` / `t2` |

### 二、变异检验发现的实现盲区

> 变异体 **20** 个（迁移的表/列/约束改写 / 错误函数状态码改写 / 事务回滚摘除 /
> 审计查询的过滤与排序改写 / revision 编号与 teamId 收窄摘除 / 快照 id 与排序摘除 /
> flag 的 open 过滤与 status 过滤与 reviewed_by 写入摘除 / 幂等兜底放宽 /
> 滑动窗口放宽 / 锁过期判断摘除 / 申诉裁决字段摘除），
> 在 `/tmp/p4t1/work` 的副本上跑 `test/audit-repo.test.js`，**测试必须失败才算杀灭**。
> 变异脚本：`/tmp/p4-mutate/t1.mjs`。

**首轮 8 条存活**，根因分三类：

| 现象 | 根因 | 处置 |
|---|---|---|
| M02 / M05 存活 | **NOT NULL / DEFAULT 零覆盖** —— `flagged_reviews.status`、`appeals.status` 的必填与默认值没有任何断言 | 补「005 迁移的 NOT NULL / DEFAULT 符合契约」用例（`PRAGMA table_info` 逐列断言） |
| M06 存活 | **错误快捷函数零覆盖** —— 用例只测了 `appError` 本身，六个快捷函数的状态码一个都没断言（`notFound` 改成 400 也没人发现） | 补「错误快捷函数的状态码必须逐个正确」用例（含 `instanceof AppError` 与 `detail` 透传） |
| M13 存活 | **`listComputationRows` 零覆盖** —— 仓储里加了函数却没有任何用例 | 补用例：倒序 + kind/stageId 过滤 + total 不受 limit 影响 |
| M14 / M15 存活 | **数据集不判别** —— 库里只有 1 条 flag ⇒「按 status 过滤」与「不过滤」结果相同；`findOpenFlag` 也从没查过「已裁决的 flag 还在不在 open 集合里」 | 补第二条 flag（一条 open、一条 confirmed），并断言「已裁决的不再被未决查询找到」 |
| M10 存活 | **数据集不判别** —— 两支队的 revision 都是 1 ⇒「按队伍收窄」与「赛段级」算出的下一轮都是 2 | 两队的 revision 改成**不对称**（t1=3、t2=1）⇒ 收窄口径 4/2、赛段口径 4，三者互不相同 |
| M12 构造失效 | 变异锚点写成 `}).run(id, ...`，实现里是 `).run(id, ...` | 锚点修正后立即被杀灭 |

**Task 1 的测试条数口径**：audit-repo **17**（规格自带 12 + 变异检验补测 5）。

**最终结果**：变异体 20 → **KILLED 20 / 等价变异体 0 / 有效缺口 0**；
`audit-repo.test.js` **17/17**；P4 全量 **726/726**（P3 的 709 + P4 的 17）
> ⚠️ **数字订正（2026-10-21 复核）**：此处原写「723/723」，**实测为 726/726** ——
> `git worktree add --detach 0345ccd` 的纯净态跑 `node --test` 得到的真实数字是 726。
> 订正依据：P4 Task 7 的 worker 与 Task 2 的父代理**各自独立实测**，结论一致（726）。以实测为准。
`node scripts/migrate.js` 连跑两次 → 第二次「本次无新迁移」，输出 `迁移完成，当前版本 5`。
---

## Task 2 父代理预审修正台账（2026-10-21）

> Task 2 = **计算快照与复算 diff**（`src/domain/diff.js` + `src/services/audit.js` + `test/audit-snapshot.test.js`）。
> 实施前做了一次**独立工程实跑**（把规格的代码块抽到副本里跑通再落盘 —— 「先跑后派」），
> **实证了 3 处规格自带缺陷**；实施完成后做**变异检验**，变异体 **28** 个，分 **4 轮**，
> 最终 **28/28 杀灭**（等价变异体 0、有效缺口 0）。

### 一、预审发现的规格缺陷（**规格自带代码块里的错**，不是实现跑偏）

| # | 级别 | 缺陷 | 实跑证据 | 处置 |
|---|---|---|---|---|
| **P4-T2-1** | **Critical** | 规格的 `src/services/audit.js` 调 `insertComputation` / `getComputationRow` —— 这两个函数**不存在**。P2 已建的是 `insertSnapshot` / `getSnapshot`（同款近义名） | 落地首跑：`TypeError: insertComputation is not a function` | 改成**复用 P2 的 `insertSnapshot` / `getSnapshot`**（§H 第 1 行；与 P4-1 同款裁决：**不重定义 P2 的函数**） |
| **P4-T2-2** | **Critical** | 规格的 `src/services/audit.js` 里 `getComputationRow` 出现**两次**（`getComputation` 与 `recomputeAndDiff` 各一处）—— 只替换首个会漏掉第二处 | 首轮替换后残留一处旧名 ⇒ 脚本的「还有没换掉的旧名字」断言拦下 | 改成**全局替换**（`split/join`），并保留「旧名一个都不能剩」的断言 |
| **P4-T2-3** | **Important** | 规格的测试**没有建被外键引用的行** —— `audit_log.actor_id → users(id)`、`computation_snapshots.stage_id → stages(id) → editions(id)`、`team_id → teams(id)`；而 `PRAGMA foreign_keys = ON` | 跑规格自带用例 → **7 条红**（`FOREIGN KEY constraint failed`） | 测试加 `seedRefs(db)`：`u_admin`/`u_judge` + `editions(e1)` + `stages(st1)` + `teams(tm1,tm2)` |

### 二、变异检验发现的实现盲区

> 变异体 **28** 个（diff 的 epsilon / 数组 path 主键 / 新增键 / 同值短路 / 数字分支 /
> audit 的四项入参校验 / teamId 透传 / 权限判定 / input·output 原样返回 /
> 规则版本识别与入 diff / 当前规则参与复算 / 严格重放比对 / 两条告警 / identical 取值 /
> 审计 action / live 模式 / 可见性过滤 / 留档窗口 / 自然月回推 / detail 记规则版本），
> 在 `/tmp/p4t2/work` 的副本上跑 `test/audit-snapshot.test.js`，**测试必须失败才算杀灭**。
> 变异脚本：`/tmp/p4-mutate/t2.mjs`。

| 轮次 | 存活 | 根因 | 处置 |
|---|---|---|---|
| 第 1 轮 | M04 / M08 / M09 / M10 / M18 / M20 / M23 / M25 | **有效缺口** —— 用例没覆盖「after 新增的键」「缺 kind」「缺 input」「缺 output」「teamId 透传」「live 模式」「留档兜底」「`output_mismatch` 告警」 | 补 7 例（用例 12/13/14/16/18）+ 2 条断言（用例 7 的 `output_mismatch`、用例 13 的缺 output） |
| 第 2 轮 | M05 / M18 / M20 / M24 | **有效缺口**（续）—— 「null 同值不得假差异」「当前规则真参与复算」「留档兜底为 null」「审计 detail 记规则版本」 | 补用例 15/17/19，并引入**判别性引擎** `configSensitiveEngine` |
| 第 3 轮 | M28 | 变异锚点写成 6 空格缩进，实现是 4 空格 ⇒ 锚点没命中 | 锚点修正后立即被杀灭 |
| 第 4 轮 | — | — | **28/28 全杀** |

**⭐ 判别性数据集的一处关键教训（与 P3 终审 M-1/M-2 同源）**：
规格自带的 `stubEngine` **完全不看 `config`** —— 于是「用当前规则复算」与「用快照规则复算」算出来的结果
**恰好相同**，期望值相同 ⇒ 测不出「当前规则到底有没有真的参与复算」（M18 首轮存活）。
处置：新增 `configSensitiveEngine`（`total = rawScore × config.dimensions[0].weight`），
并用「权重 0.2 → 0.5」的**不对称数据集** —— 只有当前规则真的参与，`teams[t1].total` 才会变。

**Task 2 的测试条数口径**：audit-snapshot **19**（规格自带 11 + 父代理预审补测 8）。

**最终结果**：变异体 28 → **KILLED 28 / 等价变异体 0 / 有效缺口 0**；
`audit-snapshot.test.js` **19/19**；P4 全量 **745/745**（Task 1 后的 726 + Task 2 的 19）。

> **关于全量基线数字**：Task 1 台账原写「723/723」，**实测为 726/726**
> （`git worktree add --detach 0345ccd` 纯净态实跑；P4 Task 7 的 worker 独立实测结论一致）。
> 本阶段起一律**以实跑数字为准**。

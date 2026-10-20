# P4 审计与防作弊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每一次发榜都能被复算、让每一次异常都能被看见。具体交付：计算快照（带规则版本）+ 复算 diff、落库的三层限频 + 幂等键、四个防作弊检测器 + 复核队列、复核与申诉状态机、审计 API 与前端 trace 抽屉，以及一个「清单为空即报错」的发布前扫描闸。

**Architecture:** 延续 P0 的单进程零依赖架构。`src/domain/` 放纯函数（diff / anticheat / evidence / field-dictionary，无 IO、无 `Date.now()`、无 `Math.random()`）；`src/services/` 放用例编排（audit / rate-limit / idempotency / review-state / anticheat）；所有 SQL 收在 `src/db/repo/`；`src/routes/audit.js` 挂 7 个 P4 路由；`web/views/audit.js`（trace 抽屉）与 `web/views/flags.js`（复核队列）是两个原生 ESM 视图，无构建。**本阶段的灵魂不是"加日志"，而是"让空结果与降级必须显式暴露"**：批量返回空 → 4xx；限频超限 → 429 + `retryAfterSeconds`；复算不一致 → diff 出现在 API 响应与前端（不是只写一条日志）；禁用清单为空 → 扫描闸直接报错退出。

**Tech Stack:** Node ≥22.5（生产建议 24）｜`node:sqlite`｜`node:crypto`（scrypt）｜`node:test`｜原生 ESM 前端，无构建｜**npm 依赖 0 个**

> **上游依赖（执行前确认）**：本阶段消费 P0（基础设施 / `audit_log` 表 / 权限与 `can()`）、**P2**（`src/domain/scoring.js` 的 `scoreStage` 纯函数、`computation_snapshots` 表）、**P3**（`tier_records` 表，用于申诉范围判定）。若 P2/P3 尚未落地，P4 的测试会以「找不到模块 / 缺表」失败——这是依赖缺失，不是本阶段的 bug。

## Global Constraints

（代码块，逐字复制 P0 约束块 + 本阶段追加）

```
运行时      Node ≥ 22.5（不使用任何 Node-24-only API；URLPattern 不可用，路由手写）
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
│   │       ├── audit-log.js        audit_log（P0 建表，本阶段真正写起来）
│   │       ├── computations.js     computation_snapshots（读 + revision 递增）
│   │       ├── flags.js            flagged_reviews
│   │       ├── idempotency.js      idempotency_keys
│   │       ├── rate-limit.js       rate_limit_events
│   │       ├── appeals.js          appeals
│   │       └── tiers.js            tier_records 读（P3 建表，本阶段只读）
│   ├── audit/
│   │   └── log.js                  审计日志写入（P0 目录结构声明过但没实现，本阶段补齐）
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
│   └── routes/
│       └── audit.js                7 个 P4 路由
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
platform/src/server.js              挂载 src/routes/audit.js；错误响应带上 detail 与 Retry-After
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
- Create: `platform/src/db/repo/audit-log.js`
- Create: `platform/src/db/repo/flags.js`
- Create: `platform/src/db/repo/idempotency.js`
- Create: `platform/src/db/repo/rate-limit.js`
- Create: `platform/src/db/repo/appeals.js`
- Modify: `platform/src/errors.js`（**P1 Task 3 已建**；本阶段只**追加**快捷函数，不改 `appError(status, code, message, detail?)` 的签名）
- Modify: `platform/src/audit/log.js`（**P2 Task 4 已建**；本阶段只**追加** `writeAuditLog` 的领域字段，不重建文件）
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
import { insertComputation, getComputationRow, nextRevision } from '../src/db/repo/computations.js';
import { withTransaction } from '../src/db/tx.js';
import { appError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4repo-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
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

test('限频计数落库：同一 bucket 递增，滑动窗口只数窗口内的', () => {
  const { db, close, dataDir } = setup();
  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100', now: '2026-10-20T00:00:00.000Z' });
  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(countBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:100' }), 2);

  incrementBucket(db, { subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', bucket: 's:050', now: '2026-10-20T00:00:00.000Z' });
  // 窗口 60 秒：now=00:00:20 时，00:00:50 这一桶还在窗口内，00:00:00 之前的不算
  const n = slidingWindowCount(db, {
    subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', now: '2026-10-20T00:01:20.000Z', windowSeconds: 60,
  });
  assert.equal(n, 2, '只有 00:00:50 起的 2 次在窗口内');
  const events = slidingWindowEvents(db, {
    subjectKey: 'judge:u1', rule: 'sliding:reviewSubmit', now: '2026-10-20T00:01:20.000Z', windowSeconds: 60,
  });
  assert.equal(events.length, 1);
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
  const after = listFlagRows(db, { status: 'confirmed' });
  assert.equal(after.length, 1);
  assert.equal(after[0].reviewed_by, 'u_admin');
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
  assert.equal(listAppealRows(db, { status: 'accepted' }).length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('computation_snapshots：revision 递增，旧 revision 保留（不覆盖历史）', () => {
  const { db, close, dataDir } = setup();
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 1);
  insertComputation(db, {
    id: 'c1', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 1 }, output: { total: 80 }, trace: {}, revision: 1, now: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(nextRevision(db, { kind: 'stage_score', stageId: 'st1' }), 2);
  insertComputation(db, {
    id: 'c2', kind: 'stage_score', stageId: 'st1', ruleVersion: 'scoring.final@2026-10-20',
    input: { a: 2 }, output: { total: 81 }, trace: {}, revision: 2, now: '2026-10-20T01:00:00.000Z',
  });
  assert.equal(getComputationRow(db, 'c1').revision, 1, '旧 revision 必须保留供复盘');
  assert.equal(getComputationRow(db, 'c2').revision, 2);
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
    /BOOM/,
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

- [ ] **Step 4: 创建 `src/errors.js` 与 `src/db/tx.js`**

`platform/src/errors.js`：

```javascript
// src/errors.js — 统一错误类型
// 依据：跨阶段接口契约 §0「错误：抛 AppError（code + message + status）」
//   P0 的 server.js 约定读 err.status / err.code，本模块只是把它们规范化。
//
// ⚠️ 本文件由 **P1 的 Task 3 建立**（`export class AppError extends Error`，
//    构造签名 `AppError(status, code, message, detail)`），本阶段【只追加快捷函数】。
//    ⛔ 不要在这里重写 AppError 类：P3 的 12 处 `new AppError(...)` 调用按
//       **status-first** 顺序写死，重写成别的签名会让 err.status / err.code 互换。
//    ✅ 下面这段直接【追加到 P1 已建的 src/errors.js 末尾】。

export function appError(status, code, message, detail = undefined) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

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

- [ ] **Step 5: 追加 `src/audit/log.js` 的仓储委托，并创建 6 个仓储文件**

`platform/src/audit/log.js` 由 **P2 的 Task 4 建立**（含 `writeAuditLog` / `listAuditLog`）。
本阶段**只做两件事**，**不要重建文件**：

```javascript
// src/audit/log.js —— 【追加/改造】到 P2 已建的文件里
// 依据：设计文档 §11.2「每次状态迁移写 audit_log(actor, from_state, to_state, reason, at)」
//   P0 的目录结构里声明了这个文件，P2 实现了它；本阶段真正把它用起来。
//   本文件【不含 SQL】——SQL 全在 src/db/repo/（全局约束：SQL 边界）。
//
// ⚠️ 改造点：P2 的 writeAuditLog 里 SQL 是内联的。本阶段把它的 SQL 下沉到
//    src/db/repo/audit-log.js，**函数签名一个字都不改**（db, { actorId, action, entity, entityId, detail, now }），
//    这样 P2 已有的调用点不需要跟着改。
import { insertAuditLog } from '../db/repo/audit-log.js';

export function writeAuditLog(db, {
  actorId = null,
  action,
  entity = null,
  entityId = null,
  detail = null,
  now = new Date().toISOString(),
}) {
  if (!action) throw new Error('写审计日志必须给 action（没有 action 的日志无法检索）');
  return insertAuditLog(db, { actorId, action, entity, entityId, detail, now });
}
```

⚠️ **P2 已有的 `listAuditLog` 保留不动**；P4 新增的查询能力走 `src/db/repo/audit-log.js` 的
`queryAuditLog` / `findLatestTransition`，由 `src/services/audit.js` 调用。两处不重复实现同一个查询。

`platform/src/db/repo/audit-log.js`：

```javascript
// src/db/repo/audit-log.js — 审计日志仓储
// 依据：设计文档 §12（可复算）+ §11.2（迁移日志）；表由 P0 的 001_init.sql 建好。
import { randomUUID } from 'node:crypto';

export function insertAuditLog(db, {
  actorId = null, action, entity = null, entityId = null, detail = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actorId, action, entity, entityId, detail === null ? null : JSON.stringify(detail), now);
  return id;
}

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

`platform/src/db/repo/computations.js`（**P2 Task 6 已建**；本阶段**追加** `nextRevision` / `listComputationRows`，**不要重建文件**、不要改 P2 已有的函数签名）：

```javascript
// src/db/repo/computations.js — 计算快照仓储
// 依据：设计文档 §12「每次计算产出三件套 rule_version / input / output / trace」
//   表由 P2 的 003_review.sql 建好；P2 的 computeStage 复用本仓储。
//   ⛔ 重算走 revision + 1，旧 revision 保留（设计文档 §11.1「事后篡改」防护）。
//   ⚠️ 本文件由 P2 建立。本阶段【追加】下面两个函数，P2 已有的 insertComputation /
//      getComputationRow 保持不动（签名一个字都不改）。
import { randomUUID } from 'node:crypto';

export function nextRevision(db, { kind, stageId = null, teamId = null }) {
  const row = db.prepare(
    `SELECT MAX(revision) AS r FROM computation_snapshots
      WHERE kind = ? AND IFNULL(stage_id, '') = ? AND IFNULL(team_id, '') = ?`,
  ).get(kind, stageId ?? '', teamId ?? '');
  return (row?.r ?? 0) + 1;
}

export function insertComputation(db, {
  id = randomUUID(), kind, editionId = null, stageId = null, teamId = null,
  ruleVersion, input, output, trace, revision, now = new Date().toISOString(),
}) {
  db.prepare(
    `INSERT INTO computation_snapshots
       (id, kind, edition_id, stage_id, team_id, rule_version, input_json, output_json, trace_json, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, kind, editionId, stageId, teamId, ruleVersion,
    JSON.stringify(input), JSON.stringify(output), JSON.stringify(trace), revision, now,
  );
  return id;
}

export function getComputationRow(db, id) {
  return db.prepare('SELECT * FROM computation_snapshots WHERE id = ?').get(id) ?? null;
}

export function listComputationRows(db, { kind = null, stageId = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (stageId) { where.push('stage_id = ?'); params.push(stageId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM computation_snapshots ${clause} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit);
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
  const res = db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, scope, request_id, response_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(key, scope, requestId, response === null ? null : JSON.stringify(response), now);
  return res.changes === 1;
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
Expected: PASS（12 个测试全过）

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
- Consumes: Task 1 的 `insertComputation` / `getComputationRow` / `nextRevision` / `writeAuditLog` / `queryAuditLog`；P2 的 `scoreStage`（`src/domain/scoring.js`）
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
  return { db, close, dataDir };
}

// 注入用的确定性引擎：让 diff 机制的断言不依赖 P2 的内部实现细节。
function stubEngine(input) {
  return {
    teams: input.submissions.map((s) => ({ teamId: s.teamId, total: s.rawScore, seatP: s.rawScore, seatE: 0 })),
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
import { insertComputation, getComputationRow, nextRevision } from '../db/repo/computations.js';
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
  const id = insertComputation(db, {
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
  const row = getComputationRow(db, id);
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
  const row = getComputationRow(db, id);
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
Expected: PASS（11 个测试全过）

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
import { countBucket } from '../src/db/repo/rate-limit.js';

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

`platform/src/config.js`（修改：加载并校验第 10 份规则）：

```text
（以下是并入 platform/src/config.js 对应位置的【片段】，不是独立文件）

// src/config.js —— 修改处 1：FILES 增加 audit
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
  audit: 'audit.json',          // ← P4 新增
};

// src/config.js —— 修改处 2：grouped 增加 audit
const grouped = {
  scoring: { initial: rules.scoringInitial, final: rules.scoringFinal },
  tiebreak: rules.tiebreak,
  ranks: rules.ranks,
  behavior: rules.behavior,
  visibility: rules.visibility,
  registration: rules.registration,
  solvability: rules.solvability,
  milestones: rules.milestones,
  audit: rules.audit,            // ← P4 新增
};

// src/config.js —— 修改处 3：validateRules 末尾追加（fail-fast，校验不过拒绝启动）
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
        if (layer !== 'lock' && !(Number.isInteger(l.seconds) && l.seconds > 0)) {
          errors.push(`audit.rateLimit.${name}.${layer}.seconds 必须是正整数`);
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
Expected: PASS（11 个测试全过）

- [ ] **Step 7: 提交**

```bash
cd platform && git add src/services/rate-limit.js src/services/idempotency.js rules/audit.json src/config.js test/rate-limit.test.js
git commit -m "feat(P4): 三层限频（落库）+ 评委级小时配额 + 幂等键执行器"
```

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
- Consumes: Task 1 的 `createFlag` / `findOpenFlag` / `listFlagRows` / `resolveFlagRow` / `writeAuditLog`
- Produces（领域层，纯函数：无 IO / 无 `Date.now()` / 无 `Math.random()`）：
  - `detectIdenticalPeerPattern({ peerReviews, minOverlap })` → `{ flags }`
  - `detectBurstSubmission({ events, windowSeconds, threshold })` → `{ flags, maxCount }`
  - `detectLowVariance({ scoreStats, threshold })` → `{ flags }`
  - `detectMultiAccount({ users, keyFields })` → `{ flags }`
  - `detectTiedMutualPeerRate({ peerReviews, results, threshold })` → `{ flags }`（R-RNK-08）
  - `normalizeEvidence({ items })` → `{ columns, items, uniquePublishers, dropped, violations }`（R-AUD-04）
  - `assertKnownFields(kind, detail)` / `assertMutuallyExclusive(detail)` / `assertConfidenceLabel(v)`（R-AUD-06）
- Produces（服务层）：
  - `runDetection({ db, stageId, peerReviews, events, scoreStats, users, rules, now })` → `{ created, skipped, flags }`
  - `resolveFlag({ db, flagId, status, reviewerId, reason, evidence, now })` → flag
  - `listFlags({ db, filter, viewer })` → `{ rows, total }`
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
import { runDetection, resolveFlag, listFlags, buildReverseAuditTasks } from '../src/services/anticheat.js';
import { queryAuditLog } from '../src/db/repo/audit-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p4ac-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  return { db, close, dataDir };
}

const VIEWER = { id: 'u_admin', is_superadmin: 1, active: 1 };

test('互评相对顺序完全相同 → 疑似串通，进复核队列', () => {
  const peerReviews = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
    { judgeId: 'j2', teamId: 't1', score: 75 }, { judgeId: 'j2', teamId: 't2', score: 85 }, { judgeId: 'j2', teamId: 't3', score: 95 },
  ];
  const r = detectIdenticalPeerPattern({ peerReviews, minOverlap: 3 });
  assert.equal(r.flags.length, 0, '顺序相反不算串通');

  const same = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
    { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 70 }, { judgeId: 'j2', teamId: 't3', score: 80 },
  ];
  const r2 = detectIdenticalPeerPattern({ peerReviews: same, minOverlap: 3 });
  assert.equal(r2.flags.length, 1);
  assert.equal(r2.flags[0].kind, 'identical_peer_pattern');
  assert.deepEqual([r2.flags[0].voterA, r2.flags[0].voterB].sort(), ['j1', 'j2']);
  assert.equal(r2.flags[0].overlap, 3);
});

test('重叠项目少于 minOverlap 时不报（样本太少没有判定力）', () => {
  const peerReviews = [
    { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 },
    { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 70 },
  ];
  const r = detectIdenticalPeerPattern({ peerReviews, minOverlap: 3 });
  assert.equal(r.flags.length, 0);
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

  const events2 = [...events, { subjectId: 'j1', at: '2026-10-20T00:00:15.000Z' }];
  const r2 = detectBurstSubmission({ events: events2, windowSeconds: 60, threshold: 3 });
  assert.equal(r2.flags.length, 1);
  assert.equal(r2.flags[0].kind, 'burst_submit');
  assert.equal(r2.flags[0].subjectId, 'j1');
  assert.equal(r2.flags[0].count, 4);
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

test('评委打分方差异常小/大都告警，但标死 action=alert_only（只告警不处罚）', () => {
  const scoreStats = [
    { judgeId: 'j1', dimension: 'innovation', n: 10, mean: 80, sum_sq: 64000 },  // stdev = 0
    { judgeId: 'j2', dimension: 'innovation', n: 10, mean: 70, sum_sq: 100000 }, // stdev ≈ 47
  ];
  const r = detectLowVariance({ scoreStats, threshold: { min: 3, max: 25 } });
  assert.equal(r.flags.length, 2);
  const low = r.flags.find((f) => f.judgeId === 'j1');
  const high = r.flags.find((f) => f.judgeId === 'j2');
  assert.equal(low.direction, 'too_low');
  assert.equal(high.direction, 'too_high');
  for (const f of r.flags) {
    assert.equal(f.action, 'alert_only', '检测器不得产出任何处罚动作');
    assert.equal(f.kind, 'low_variance');
  }
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

test('runDetection 把检测结果写进 flagged_reviews，且不重复建同一 flag', () => {
  const { db, close, dataDir } = setup();
  const args = {
    db,
    stageId: 'st1',
    peerReviews: [
      { judgeId: 'j1', teamId: 't1', score: 90 }, { judgeId: 'j1', teamId: 't2', score: 80 }, { judgeId: 'j1', teamId: 't3', score: 70 },
      { judgeId: 'j2', teamId: 't1', score: 60 }, { judgeId: 'j2', teamId: 't2', score: 70 }, { judgeId: 'j2', teamId: 't3', score: 80 },
    ],
    events: [],
    scoreStats: [],
    users: [],
    rules: { audit: { antiCheat: { identicalPeer: { minOverlap: 3 }, burst: { windowSeconds: 60, threshold: 5 }, lowVariance: { min: 3, max: 25 }, multiAccount: { keyFields: ['phone'] }, tiedMutualPeerRate: { threshold: 0.8 } } } },
    now: '2026-10-20T00:00:00.000Z',
  };
  const first = runDetection(args);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].kind, 'identical_peer_pattern');
  const second = runDetection(args);
  assert.equal(second.created.length, 0, '同一问题不得重复建 flag');
  assert.equal(second.skipped.length, 1);
  close();
  rmSync(dataDir, { recursive: true, force: true });
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
    rules: { audit: { antiCheat: { identicalPeer: { minOverlap: 3 }, burst: { windowSeconds: 60, threshold: 5 }, lowVariance: { min: 3, max: 25 }, multiAccount: { keyFields: ['phone'] }, tiedMutualPeerRate: { threshold: 0.8 } } } },
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
  const { rows } = queryAuditLog(db, { action: 'flag.resolve' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, flagId);
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('复核队列：无权访问返回空集（列表不满足 → 200 + 空集）', () => {
  const { db, close, dataDir } = setup();
  const r = listFlags({ db, filter: {}, viewer: { id: 'u_judge', is_superadmin: 0, active: 1 } });
  assert.deepEqual(r.rows, []);
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

export const FLAG_DETAIL_FIELDS = {
  self_vs_judge: ['teamId', 'dimension', 'judgeScore', 'selfScore', 'delta', 'action'],
  burst_submit: ['subjectId', 'count', 'windowStart', 'windowEnd'],
  identical_peer_pattern: ['voterA', 'voterB', 'overlap', 'targets', 'matchRatio'],
  low_variance: ['judgeId', 'dimension', 'stdev', 'n', 'mean', 'direction', 'action'],
  multi_account: ['keyField', 'keyValue', 'userIds', 'count'],
  tied_mutual_peer_rate: ['tiedPairs', 'rate', 'threshold'],
  reverse_audit: ['teamId', 'rank', 'signoffs', 'instruction'],
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
    const rate = mutual / tiedPairs.length;
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
import { createFlag, findOpenFlag, listFlagRows, resolveFlagRow } from '../db/repo/flags.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { badRequest, notFound } from '../errors.js';

/**
 * 跑一遍全部检测器，把命中的问题写进 flagged_reviews（status='open'）。
 * @returns {{ created: Array, skipped: Array }}
 */
export function runDetection({
  db, stageId = null, peerReviews = [], events = [], scoreStats = [], results = [],
  users = [], rules, now = new Date().toISOString(),
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
  ];

  for (const flag of candidates) {
    // 字段字典校验：不在字典里的字段名不进库（R-AUD-06）
    const fieldErrors = [...assertKnownFields(flag.kind, flag), ...assertMutuallyExclusive(flag)];
    if (fieldErrors.length) {
      throw badRequest(`flag 明细字段不合规（${flag.kind}）：${fieldErrors.join('；')}`);
    }
    const judgeId = flag.judgeId ?? flag.voterA ?? flag.subjectId ?? null;
    const teamId = flag.teamId ?? (flag.tiedPairs?.[0]?.[0] ?? null);
    const existing = findOpenFlag({ db, kind: flag.kind, stageId, teamId, judgeId });
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
  const { rows } = listFlagRows(db, { limit: 1000 });
  const row = rows.find((r) => r.id === flagId);
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
  }));
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd platform && node --test test/anticheat.test.js test/field-dictionary.test.js`
Expected: PASS（anticheat 15 个 + field-dictionary 5 个全过）

- [ ] **Step 8: 提交**

```bash
cd platform && git add src/domain/anticheat.js src/domain/evidence.js src/domain/field-dictionary.js src/services/anticheat.js test/anticheat.test.js test/field-dictionary.test.js
git commit -m "feat(P4): 五个防作弊检测器、证据三列去重与审计字段字典（只告警不处罚）"
```

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
    const existing = db.prepare(
      'SELECT response_json FROM idempotency_keys WHERE key = ? AND scope = ?',
    ).get(idempotencyKey, scope);
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
    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, scope, request_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(idempotencyKey, scope, idempotencyKey, JSON.stringify(result), at);
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

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/review-state.test.js`
Expected: PASS（12 个测试全过）

- [ ] **Step 6: 提交**

```bash
cd platform && git add src/services/review-state.js src/db/repo/tiers.js test/review-state.test.js
git commit -m "feat(P4): 复核与申诉状态机、幂等守卫与 PENDING_REVIEW 分数可见性过滤"
```

---

### Task 6: 审计 API + 前端 trace 抽屉 + 复核队列

**Files:**
- Create: `platform/src/routes/audit.js`
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

- [ ] **Step 3: 创建 `src/routes/audit.js`**

```javascript
// src/routes/audit.js — P4 的 7 个接口
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
import { registerAuditRoutes } from './routes/audit.js';

// src/server.js —— 修改处 2：createApp 内挂载路由（放在 /api/health 之后）
  router.add('GET', '/api/health', async () => ({ ok: true, at: new Date().toISOString() }));
  registerAuditRoutes(router, { db, rules });

// src/server.js —— 修改处 3：错误分支带上 detail 与 Retry-After
      } catch (err) {
        const status = err.status || 500;
        const code = err.code || 'INTERNAL';
        if (status >= 500) console.error('[server]', err);
        const extraHeaders = {};
        // ⛔ 限频必须带 Retry-After，调用方才知道多久能重试（不静默丢包）
        if (code === 'RATE_LIMITED' && err.detail?.retryAfterSeconds) {
          extraHeaders['Retry-After'] = String(err.detail.retryAfterSeconds);
        }
        error(res, status, code, err.message, err.detail, extraHeaders);
      }
```

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
Expected: PASS（9 个测试全过）

- [ ] **Step 9: 提交**

```bash
cd platform && git add src/routes src/http/respond.js src/server.js web/views web/app.js scripts/seed.js test/audit-api.test.js
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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, scanText, scanRoots } from '../scripts/audit-scan.js';

const here = dirname(fileURLToPath(import.meta.url));

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-scan-'));
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
  const text = readFileSync(join(here, '..', 'scripts', 'forbidden.txt'), 'utf8');
  const parsed = parseManifest(text);
  assert.ok(parsed.terms.length > 0, '禁用清单不得为空');
  assert.equal(parsed.errors.length, 0, parsed.errors.join('；'));
  for (const t of parsed.terms) {
    assert.ok(t.term.trim().length > 0);
  }
});

test('仓库自带的 forbidden.txt 里没有重复词条', () => {
  const text = readFileSync(join(here, '..', 'scripts', 'forbidden.txt'), 'utf8');
  const parsed = parseManifest(text);
  const seen = new Set();
  for (const t of parsed.terms) {
    assert.equal(seen.has(t.term), false, `重复词条：${t.term}`);
    seen.add(t.term);
  }
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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
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
#     · 禁用词：整行包含即算违规
#     · 豁免正则：同一行命中该正则 → 视为「更正语境」，不计违规，但会出现在扫描报告里
#   @skip-path <路径正则>   整条路径跳过（相对仓库根）。排除项会在报告里打印，不静默。
#   # 开头为注释，空行忽略
#
# ⚠️ 本文件不得为空：清单为空 = 闸未生效，audit-scan.js 直接报错退出。
#
# @skip-path ^docs/superpowers/plans/
#   实施计划按设计要【引用并纠正】原始错误表述（例如把冲突两方都写出来），
#   对计划文件一刀切会让计划本身写不下去。计划文件不是对外交付物，故整目录跳过。
#
# ── 已被裁决为错误、但仍可能残留的表述 ─────────────────────────
# C-01：初赛 w_E 裁决为 10%（rule-decisions.md 初赛权重表合计正好 100%）
初赛企业确认权重 ?20%|C-01|冲突|裁决|已更正
w_E ?= ?20%.*初赛|C-01|冲突|裁决|已更正
# 四维各 25% 的旧表述（应为「创新 20% / 技术可行 20% / 完成度 25% / 协作 15%」等六维表）
四维各 ?25%|原表述|有误|已更正|CICC[^，。]*已
# 行为分进总分的旧表述（S10 §3.3 行为分只做垫底排序，不进总分）
行为分计入总分|已更正|S10 §3.3|只做
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd platform && node --test test/audit-scan.test.js`
Expected: PASS（7 个测试全过）

- [ ] **Step 6: 实跑扫描闸**

Run: `cd platform && node scripts/audit-scan.js`
Expected: 输出 `[audit-scan] 词条 5 条｜扫描 N 个文件` … `[audit-scan] ✓ 未发现禁用表述`，退出码 0

- [ ] **Step 7: 验证"闸未生效"会被拦下（人工验证，不改仓库文件）**

Run: `cd platform && printf '# 只有注释\n' > /tmp/empty-forbidden.txt && node -e "import('./scripts/audit-scan.js').then(m=>{const p=m.parseManifest('# 只有注释\n');console.log(p.errors);})"`
Expected: 输出含「禁用清单为空 —— 闸未生效」的数组元素

- [ ] **Step 8: 提交**

```bash
cd platform && git add scripts/audit-scan.js scripts/forbidden.txt test/audit-scan.test.js package.json
git commit -m "feat(P4): 发布前证据链扫描闸（清单为空即报错，豁免语境可放行）"
```

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
Expected: PASS（1 个测试全过）

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
| `src/errors.js` | 契约 §0 要求「抛 `AppError`（code + message + status）」，但 P0 没有这个模块。统一构造 `status` / `code` / `detail`，供 429 带 `retryAfterSeconds` 用 |
| `src/db/tx.js` | 「事务回滚，无部分写入」（设计文档 §11）需要事务助手；用 SAVEPOINT 实现，可嵌套，调用方自己开了事务也不会炸 |
| `src/domain/diff.js` | 复算 diff 的比对逻辑是纯函数，必须留在 `domain/`（无 IO）；契约未列 |
| `src/domain/evidence.js` | R-AUD-04「证据三列 + 按发行方去重」需要一个纯函数模块 |
| `src/domain/field-dictionary.js` | R-AUD-06「并行前定字段字典」需要一个唯一的字段名来源 |
| `src/services/idempotency.js` | 契约把 `idempotency_keys` 列进了表结构，但没给服务层函数；幂等执行器（只生效一次 + 返回首次响应）需要一个独立模块 |
| `src/services/anticheat.js` | 契约只列了 `src/domain/anticheat.js`（纯函数）。检测结果落 `flagged_reviews`、裁决、复核队列列表属于 IO，放服务层 |
| `src/routes/audit.js` | P0 的 `src/server.js` 把路由内联在文件里；P4 有 7 个接口，内联会让 P0 的文件失控。**建议 P1–P6 统一采用 `src/routes/*.js` 约定** |
| `src/db/repo/tiers.js` | 申诉范围判定要读 P3 的 `tier_records`（只读） |
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

1. **迁移版本号撞车（会连锁影响 P1 之后的所有迁移）**：P0 计划 Task 6 建了 `db/migrations/002_user_roles.sql`，而 `INTERFACES.md` §2 规定 P1 的迁移是 `db/migrations/002_registration.sql`。两者的版本号都是 2，而 `applyMigrations` 按 `version` 去重 → **后执行的那张表永远建不出来**。P1 执行前必须改号（建议 P1 的 `002_registration` → `003_registration`），否则 `003_review` / `004_leaderboard` / `005_audit` 之后的一切都建在错误的基线上。本阶段的 `005_audit.sql` 编号与契约一致。
2. **P0 声明了但没建的文件**：P0 的 File Structure 里有 `src/audit/log.js`，但 P0 的 7 个 Task 都没有创建它。审计日志的写入入口本阶段补齐（Task 1）。
3. **P0 的 `error()` 没有自定义响应头能力**：`src/http/respond.js` 的 `error(res, status, code, message, detail)` 装不下 `Retry-After`。本阶段追加可选第 6 参 `extraHeaders`（向后兼容，P0 现有调用不用改）。

### F. 一处口径调和（不是冲突，是把两句话的适用边界写清楚）

- 全局约束「列表不满足 → 200 + 空集」与 R-AUD-05「空结果必须显式报错」**适用范围不同**：
  - **读取类列表**（`GET /api/audit/log`、`GET /api/audit/flags`、`GET /api/appeals`）→ 仍按三态返回 `200 + 空集`（不暴露"有但不给看"）。
  - **批量写入 / 批处理类**（批量评分、批量提交、申诉提交、复算、扫描）→ 返回空必须 4xx。本阶段的落点：申诉理由为空 → 400、证据缺列 → 400、禁用清单为空 → 退出码 2、复算输入缺失 → 抛错、限频未配置 → 500。

---

*配套：`../specs/2026-10-20-heikesong-platform-design.md`｜`../requirements-traceability.md`｜`../rule-decisions.md`｜`../`*

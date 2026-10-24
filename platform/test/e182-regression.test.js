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

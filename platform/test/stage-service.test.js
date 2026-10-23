// platform/test/stage-service.test.js —— 赛段生命周期的**服务层**单测（P11 新建）
//
// ⛔ **这个文件为什么必须存在**：
//   P11 真机实测：生产库 `stages = 0, stage_team = 0` ⇒ 全新部署的平台一条赛段都没有。
//   根因是 `insertStage` / `assignStageJudge` / `registerStageTeams` **在生产上零调用方**。
//   本文件把服务层的**校验与错误码**钉死：
//   每个「写动作」都必须有确定的失败语义（404 / 400 / 409），
//   否则这些动作接上路由之后就是「随手一个入参就能把库写坏」。
//
// 规则溯源：
//   · 赛段类型 initial|final|roadshow|landing → db/migrations/003_review.sql（stages.kind 列注释）
//   · 席位 judge|enterprise|observer → 003_review.sql（stage_judges.seat 列注释）
//   · 权重表 initial|final → rules/scoring-initial.json / rules/scoring-final.json
//   · 利益冲突声明随派评委写入 → R-JDG-18（S7 §3.4）
//   · 留痕可复算 → 设计文档 §12（每个写动作一条 audit_log）
//   · 三态状态码 → 设计文档 §7.3
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

import {
  createStage,
  updateStage,
  assignStageJudgeToStage,
  removeStageJudge,
  registerStageTeamRoster,
  removeStageTeam,
} from '../src/services/stage.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-stage-svc-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const otherEdition = createEdition(db, {
    name: '第二届 · 北京', city: '北京', startsAt: '2027-10-01', endsAt: '2027-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900005001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900005002', password: 'pw' });
  const enterprise = createUser(db, { name: '出题企业', phone: '13900005003', password: 'pw' });

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const otherPkg = createTaskPackage(db, {
    editionId: otherEdition.id, enterpriseId: enterprise.id, enterpriseName: '某某企业',
    title: '别届期的题', painPoint: '别的赛道的痛点',
    expectedDelivery: '可运行的原型', acceptanceCriteria: '能给出测算',
    submittedBy: admin.id, now: NOW,
  });

  const teams = [];
  for (let i = 0; i < 2; i += 1) {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: `1390000${5010 + i}`, password: 'pw' });
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id,
      taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    teams.push({ team, captain });
  }
  const foreignCaptain = createUser(db, { name: '外届期队长', phone: '13900005030', password: 'pw' });
  const foreignTeam = insertTeam(db, {
    editionId: otherEdition.id, name: '外来队', captainId: foreignCaptain.id,
    taskPackageId: otherPkg.id, status: 'active', now: NOW,
  });

  return {
    db, close, dataDir, rules, edition, otherEdition, admin, judge, enterprise, teams, foreignTeam,
  };
}

/** 建一个初始赛段（服务层直调）。 */
function makeStage(ctx, patch = {}) {
  return createStage({
    db: ctx.db,
    editionId: ctx.edition.id,
    key: 's1',
    name: '初赛',
    kind: 'initial',
    startsAt: '2026-10-01',
    endsAt: '2026-10-10',
    scoringConfigKey: 'initial',
    actorId: ctx.admin.id,
    now: NOW,
    rules: ctx.rules,
    ...patch,
  });
}

/** 断言：抛出的领域错误的 (status, code)。 */
function assertDomainError(fn, status, code, label) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `${label}：应当抛错，但没有抛`);
  assert.equal(caught.status, status, `${label}：status 不符（实际 ${caught.status} / ${caught.message}）`);
  assert.equal(caught.code, code, `${label}：code 不符（实际 ${caught.code}）`);
  assert.equal(caught.name, 'AppError', `${label}：必须是 AppError（否则 HTTP 层会把 message 换成通用文案）`);
}

test('建赛段：写进库 + 状态 draft + 留审计 stage.create', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    assert.ok(stage.id, '必须有 id');
    assert.equal(stage.edition_id, ctx.edition.id);
    assert.equal(stage.key, 's1');
    assert.equal(stage.name, '初赛');
    assert.equal(stage.kind, 'initial');
    assert.equal(stage.scoring_config_key, 'initial');
    assert.equal(stage.status, 'draft', '新建赛段一律 draft（不是建好就开闸）');

    const rows = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').all(stage.id);
    assert.equal(rows.length, 1, '赛段必须真的落库');

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.create' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '建赛段必须留一条审计（§12 留痕可复算）');
    assert.equal(audit[0].actor_id, ctx.admin.id, '审计必须带操作者');
    assert.equal(audit[0].created_at, NOW, '审计必须带时间戳');
    const detail = JSON.parse(audit[0].detail_json);
    assert.equal(detail.key, 's1');
    assert.equal(detail.scoringConfigKey, 'initial');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('建赛段的校验链：每一档错误码都要准', () => {
  const ctx = setup();
  try {
    // 届期不存在 → 404
    assertDomainError(
      () => makeStage(ctx, { editionId: 'ed_nope' }),
      404, 'EDITION_NOT_FOUND', '届期不存在',
    );
    // key 空 → 400
    assertDomainError(() => makeStage(ctx, { key: '  ' }), 400, 'INVALID_STAGE_FIELD', 'key 为空');
    // key 字符集非法 → 400
    assertDomainError(() => makeStage(ctx, { key: '初赛/1' }), 400, 'INVALID_STAGE_KEY', 'key 非法字符');
    // name 空 → 400
    assertDomainError(() => makeStage(ctx, { name: '' }), 400, 'INVALID_STAGE_FIELD', 'name 为空');
    // kind 非法 → 400
    assertDomainError(() => makeStage(ctx, { kind: 'warmup' }), 400, 'INVALID_STAGE_KIND', 'kind 非法');
    // scoringConfigKey 不在枚举内 → 400 SCORING_CONFIG_NOT_FOUND
    assertDomainError(
      () => makeStage(ctx, { scoringConfigKey: 'mid' }), 400, 'SCORING_CONFIG_NOT_FOUND', '权重表键非法',
    );
    // 权重表在规则里不存在（枚举内但规则缺） → 400 SCORING_CONFIG_NOT_FOUND
    assertDomainError(
      () => makeStage(ctx, { scoringConfigKey: 'initial', rules: { scoring: {} } }),
      400, 'SCORING_CONFIG_NOT_FOUND', '规则里没有权重表',
    );
    // 时间窗反了 → 400 INVALID_STAGE_WINDOW
    assertDomainError(
      () => makeStage(ctx, { startsAt: '2026-10-10', endsAt: '2026-10-01' }),
      400, 'INVALID_STAGE_WINDOW', '开始晚于结束',
    );
    // 时间窗相等 → 同样 400（必须**早于**结束）
    assertDomainError(
      () => makeStage(ctx, { startsAt: '2026-10-01', endsAt: '2026-10-01' }),
      400, 'INVALID_STAGE_WINDOW', '开始等于结束',
    );
    // 时间不可解析 → 400
    assertDomainError(
      () => makeStage(ctx, { endsAt: '下个月' }), 400, 'INVALID_STAGE_WINDOW', '时间不可解析',
    );

    // 同一个 key 建第二次 → 409
    makeStage(ctx);
    let dupErr = null;
    try {
      makeStage(ctx);
    } catch (err) {
      dupErr = err;
    }
    assert.ok(dupErr, '同届期 key 重复必须报错');
    assert.equal(dupErr.status, 409);
    assert.equal(dupErr.code, 'STAGE_KEY_EXISTS');
    // ⚠️ 文案要能分辨「历史已有」与「刚刚并发创建」两档（两档都是 409，但下一步动作不同）
    assert.match(dupErr.message, /本届期已存在/, `重复 key 的报错文案不对：${dupErr.message}`);

    // 另一个届期可以用同一个 key（UNIQUE 是 (edition_id, key)）
    const other = createStage({
      db: ctx.db,
      editionId: ctx.otherEdition.id,
      key: 's1', name: '初赛', kind: 'initial',
      startsAt: '2027-10-01', endsAt: '2027-10-10',
      scoringConfigKey: 'initial', actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
    });
    assert.ok(other.id, '另一个届期可以用同一个 key');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('改赛段配置：改名生效 + 留审计 stage.update；赛段不存在 → 404', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const updated = updateStage({
      db: ctx.db, stageId: stage.id, name: '初赛（延期）', actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
    });
    assert.equal(updated.name, '初赛（延期）');
    const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
    assert.equal(row.name, '初赛（延期）', '改名必须真的落库');
    assert.equal(row.starts_at, '2026-10-01', '没传的字段不得被改动');

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.update' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '改配置必须留审计');
    const detail = JSON.parse(audit[0].detail_json);
    assert.equal(detail.before.name, '初赛');
    assert.equal(detail.after.name, '初赛（延期）', '审计要能看出改前改后');

    assertDomainError(
      () => updateStage({ db: ctx.db, stageId: 'st_nope', name: 'x', actorId: ctx.admin.id, now: NOW, rules: ctx.rules }),
      404, 'STAGE_NOT_FOUND', '赛段不存在',
    );
    // 时间窗非法 → 400
    assertDomainError(
      () => updateStage({
        db: ctx.db, stageId: stage.id, startsAt: '2026-10-20', endsAt: '2026-10-01',
        actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
      }),
      400, 'INVALID_STAGE_WINDOW', '改成时间窗反了',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('改权重表：赛段已有评分 ⇒ 409 STAGE_HAS_REVIEWS（历史评分必须可复算）；无评分可改', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    // 写一条评分
    insertReview(ctx.db, {
      stageId: stage.id, judgeId: ctx.judge.id, teamId: ctx.teams[0].team.id,
      dimension: 'track_fit', rawScore: 88, requestId: 'r-1', calibrated: 0, now: NOW,
    });
    assertDomainError(
      () => updateStage({
        db: ctx.db, stageId: stage.id, scoringConfigKey: 'final',
        actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
      }),
      409, 'STAGE_HAS_REVIEWS', '有评分时换权重表',
    );
    const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(stage.id);
    assert.equal(row.scoring_config_key, 'initial', '被拒的改动不得落库');

    // 没有评分的赛段 ⇒ 可以换
    const empty = makeStage(ctx, { key: 's2', name: '决赛' });
    const updated = updateStage({
      db: ctx.db, stageId: empty.id, scoringConfigKey: 'final',
      actorId: ctx.admin.id, now: NOW, rules: ctx.rules,
    });
    assert.equal(updated.scoring_config_key, 'final');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('派评委：席位 + 利益冲突声明同事务写入（R-JDG-18），并回填声明 id', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const judges = assignStageJudgeToStage({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge',
      actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(judges.length, 1);
    assert.equal(judges[0].seat, 'judge');

    const seat = ctx.db.prepare('SELECT * FROM stage_judges WHERE stage_id = ? AND user_id = ?').get(stage.id, ctx.judge.id);
    assert.ok(seat, 'stage_judges 必须有一行');
    assert.ok(seat.conflict_declaration_id, '利益冲突声明 id 必须回填到席位行');
    assert.ok(seat.conflict_declared_at, '签署时间必须回填');

    const decl = ctx.db.prepare('SELECT * FROM conflict_declarations WHERE id = ?').get(seat.conflict_declaration_id);
    assert.ok(decl, '声明必须真的落在 conflict_declarations 表里');
    assert.equal(decl.judge_id, ctx.judge.id);
    assert.equal(decl.stage_id, stage.id);
    assert.equal(decl.has_conflict, 0);
    assert.ok(decl.statement.length > 0, '声明必须有正文');

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.judge.assign' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '派评委必须留审计');
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('派评委的校验：赛段/用户不存在 → 404；席位非法 → 400；重复派 → 409', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: 'st_nope', userId: ctx.judge.id, seat: 'judge', now: NOW,
      }),
      404, 'STAGE_NOT_FOUND', '赛段不存在',
    );
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: stage.id, userId: 'u_nope', seat: 'judge', now: NOW,
      }),
      404, 'USER_NOT_FOUND', '用户不存在',
    );
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'boss', now: NOW,
      }),
      400, 'INVALID_JUDGE_SEAT', '席位非法',
    );
    assignStageJudgeToStage({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge', now: NOW,
    });
    assertDomainError(
      () => assignStageJudgeToStage({
        db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge', now: NOW,
      }),
      409, 'JUDGE_ALREADY_ASSIGNED', '重复派同一评委',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('撤评委（逆向路径）：席位被撤 + 留审计；没派过 → 404 JUDGE_NOT_ASSIGNED', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    assignStageJudgeToStage({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, seat: 'judge', now: NOW,
    });
    const removed = removeStageJudge({
      db: ctx.db, stageId: stage.id, userId: ctx.judge.id, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(removed.removed, 1);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_judges WHERE stage_id = ?').get(stage.id).n,
      0, '席位必须真的被撤掉',
    );
    // ⚠️ 声明是历史事实：撤席**不删**声明（R-JDG-17：赛后可查）
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM conflict_declarations WHERE stage_id = ?').get(stage.id).n,
      1, '撤席不得删掉已签署的利益冲突声明',
    );
    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.judge.remove' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '撤评委必须留审计');

    assertDomainError(
      () => removeStageJudge({ db: ctx.db, stageId: stage.id, userId: ctx.judge.id, now: NOW }),
      404, 'JUDGE_NOT_ASSIGNED', '撤一个没派过的评委',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('报名册：幂等（重复登记静默跳过）+ 留审计；队伍不存在 → 404；外届期队伍 → 400', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const ids = ctx.teams.map((t) => t.team.id);
    const first = registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: ids, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(first.registered, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.teamIds.length, 2);

    // ⛔ 幂等：重复登记**不报错**，也不重复插入
    const second = registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: ids, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(second.registered, 0, '重复登记不得重复插入');
    assert.equal(second.skipped, 2, '重复登记必须计入 skipped');
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      2, '名册行数不得翻倍',
    );

    // 部分重复：只补新的
    const extraCaptain = createUser(ctx.db, { name: '队长3', phone: '13900005040', password: 'pw' });
    const pkg = ctx.db.prepare('SELECT task_package_id FROM teams WHERE id = ?').get(ids[0]);
    const third = insertTeam(ctx.db, {
      editionId: ctx.edition.id, name: '3队', captainId: extraCaptain.id,
      taskPackageId: pkg.task_package_id, status: 'active', now: NOW,
    });
    const mixed = registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: [ids[0], third.id], actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(mixed.registered, 1);
    assert.equal(mixed.skipped, 1);

    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.roster.register' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 3, '每次登记都要留审计（含幂等那两次）');

    assertDomainError(
      () => registerStageTeamRoster({
        db: ctx.db, stageId: stage.id, teamIds: ['t_nope'], actorId: ctx.admin.id, now: NOW,
      }),
      404, 'TEAM_NOT_FOUND', '队伍不存在',
    );
    assertDomainError(
      () => registerStageTeamRoster({
        db: ctx.db, stageId: stage.id, teamIds: [ctx.foreignTeam.id], actorId: ctx.admin.id, now: NOW,
      }),
      400, 'TEAM_NOT_IN_EDITION', '外届期的队伍',
    );
    assertDomainError(
      () => registerStageTeamRoster({
        db: ctx.db, stageId: stage.id, teamIds: [], actorId: ctx.admin.id, now: NOW,
      }),
      400, 'INVALID_TEAM_IDS', '空名册',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('退名册（逆向路径）：行被删 + 留审计；不在册 → 404 TEAM_NOT_IN_ROSTER', () => {
  const ctx = setup();
  try {
    const stage = makeStage(ctx);
    const teamId = ctx.teams[0].team.id;
    registerStageTeamRoster({
      db: ctx.db, stageId: stage.id, teamIds: [teamId], actorId: ctx.admin.id, now: NOW,
    });
    const removed = removeStageTeam({
      db: ctx.db, stageId: stage.id, teamId, actorId: ctx.admin.id, now: NOW,
    });
    assert.equal(removed.removed, 1);
    assert.equal(removed.teamIds.length, 0);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM stage_team WHERE stage_id = ?').get(stage.id).n,
      0, '名册行必须真的被删掉',
    );
    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'stage.roster.remove' AND entity_id = ?").all(stage.id);
    assert.equal(audit.length, 1, '退名册必须留审计');

    assertDomainError(
      () => removeStageTeam({ db: ctx.db, stageId: stage.id, teamId, actorId: ctx.admin.id, now: NOW }),
      404, 'TEAM_NOT_IN_ROSTER', '退一个不在册的队伍',
    );
  } finally {
    ctx.close(); rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

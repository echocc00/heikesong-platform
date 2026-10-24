import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules, validateRules, getDefaultRules } from '../src/config.js';
import { createEdition } from '../src/db/repo/editions.js';
import { createUser } from '../src/db/repo/users.js';
import { insertStage } from '../src/db/repo/stages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { registerStageTeams, listStageTeamIds, isTeamInStage, hasStageRoster } from '../src/db/repo/stage-teams.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'rules');
const NOW = '2026-10-20T12:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p3-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  return { db, close, dataDir };
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);

test('004 迁移建出 4 张榜单表，字段与 INTERFACES.md §4 逐字一致', () => {
  const { db, close, dataDir } = setup();
  assert.deepEqual(cols(db, 'points_ledger'),
    ['id', 'edition_id', 'stage_id', 'team_id', 'user_id', 'kind', 'points', 'created_at']);
  assert.deepEqual(cols(db, 'tier_records'),
    ['id', 'team_id', 'tier', 'milestone_count', 'business_signoff_count', 'reasons_json', 'computed_at', 'deleted_at']);
  assert.deepEqual(cols(db, 'behavior_events'),
    // ⚠️ subject_id 是 M0-1（2026-10-26）加的列（迁移 009）：按**里程碑**计次的事件
    //    把里程碑 id 记在这里 ⇒ 一支队伍最多计 7 次「交付里程碑」，而不是终身 1 次。
    ['id', 'team_id', 'user_id', 'type', 'points', 'evidence', 'created_at', 'subject_id']);
  assert.deepEqual(cols(db, 'leaderboard_snapshots'),
    ['id', 'edition_id', 'stage_id', 'scope', 'payload_json', 'created_at']);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ stage_results 里没有任何行为分字段（表结构层隔离）', () => {
  const { db, close, dataDir } = setup();
  const bad = cols(db, 'stage_results').filter((c) => /behavior|bonus|event_points/i.test(c));
  assert.deepEqual(bad, [], `stage_results 出现行为分字段：${bad.join(',')}`);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('points_ledger 与 behavior_events 是追加式：没有 deleted_at / updated_at', () => {
  const { db, close, dataDir } = setup();
  for (const t of ['points_ledger', 'behavior_events']) {
    assert.ok(!cols(db, t).includes('deleted_at'), `${t} 不该有 deleted_at`);
    assert.ok(!cols(db, t).includes('updated_at'), `${t} 不该有 updated_at`);
  }
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('补齐了里程碑 / 签字 / 加时陈述四张补充表，且一人一票由唯一约束保证', () => {
  const { db, close, dataDir } = setup();
  for (const t of ['milestones', 'milestone_signoffs', 'tiebreak_round', 'tiebreak_votes']) {
    assert.ok(cols(db, t).length > 0, `缺表 ${t}`);
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tiebreak_votes'").get().sql;
  assert.ok(sql.includes('PRIMARY KEY (tiebreak_round_id, voter_id, team_id)'));
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('rules/points.json 与 INTERFACES.md §4 一致（10/8/5 · 前 3 名 · MVP 4 赛段 · 1224）', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(rules.points.stagePoints, [10, 8, 5]);
  assert.equal(rules.points.stagePointsOnlyTopN, 3);
  assert.deepEqual(rules.points.mvp, { stagesCounted: 4, roadshowWeight: 1.0, perPackage: 1 });
  // ⚠️ personal 组在 P5 修复轮（I-3）里多了两项：atomicKinds / rollupKind ——
  //    个人积分口径的**唯一规则来源**（原来散在 rules.pools.talentPointKinds 与
  //    rules.points.personal 两处，两处口径还不一样）。
  assert.deepEqual(rules.points.personal, {
    lifetime: true,
    includeMvpVote: true,
    atomicKinds: ['stage_rank', 'mvp', 'roadshow'],
    rollupKind: 'personal_rollup',
  });
  assert.equal(rules.points.tieRankStyle, '1224');
  assert.equal(rules.points.fallbackPolicy.enabled, false, 'R-JDG-21 权重回退默认关闭');
  assert.equal(rules.points.fallbackPolicy.enterpriseWeight, 0.15);
});

test('rules/criteria.json 承载段位附加条件与行为分证据要求', () => {
  const { rules } = loadRules(rulesDir);
  assert.deepEqual(rules.criteria.tier.dataOrPrototypeMilestones, ['data_connected', 'demo_ready']);
  assert.ok(rules.criteria.tier.businessDepartmentKeywords.includes('业务'));
  assert.ok(rules.criteria.tier.technicalDepartmentKeywords.includes('技术'));
  assert.equal(rules.criteria.mvp.awardPointsSource, 'stage_points_sum');
  assert.deepEqual(rules.criteria.mvp.tiebreak, ['roadshow_points', 'team_id'], 'MVP 决胜链默认以 team_id 收尾');
  assert.deepEqual(rules.criteria.behaviorEvidence.weekly_progress.required, ['repo', 'version']);
});

test('配置校验会拒绝非法 / 缺失的 MVP 决胜链', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  delete bad.criteria.mvp.tiebreak;                        // 缺决胜链 → 同分 MVP 由入参顺序决定
  assert.ok(validateRules(bad).some((e) => e.includes('tiebreak')));
  const bad2 = structuredClone(rules);
  bad2.criteria.mvp.tiebreak = ['roadshow_points', 'lottery'];   // 未知决胜键
  assert.ok(validateRules(bad2).some((e) => e.includes('lottery')));
  const bad3 = structuredClone(rules);
  bad3.criteria.mvp.tiebreak = ['roadshow_points'];        // 缺 team_id 收尾 → 非确定性兜底
  assert.ok(validateRules(bad3).some((e) => e.includes('team_id')));
});

test('配置校验会拒绝非法的 points 配置', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.points.stagePointsOnlyTopN = 5;              // 与 stagePoints 长度不一致
  assert.ok(validateRules(bad).some((e) => e.includes('points')));
  const bad2 = structuredClone(rules);
  bad2.points.tieRankStyle = 'dense';
  assert.ok(validateRules(bad2).some((e) => e.includes('tieRankStyle')));
  const bad3 = structuredClone(rules);
  bad3.points.mvp.perPackage = 2;                  // 每个任务包只能 1 个 MVP
  assert.ok(validateRules(bad3).some((e) => e.includes('perPackage')));
});

test('getDefaultRules 能独立读出 rules/ 目录（服务层无注入时的兜底）', () => {
  const r = getDefaultRules();
  assert.deepEqual(r.points.stagePoints, [10, 8, 5]);
  assert.equal(r.tiebreak.chain.at(-1).key, 'team_id');
});

// ═══════════════════════════════════════════════════════════════════════════
// 父代理变异检验追加的用例（2026-10-21）
//   —— 下面这些行为在实现里是对的，但**没有用例钉住** → 变异体会存活。
// ═══════════════════════════════════════════════════════════════════════════

test('★ 004 迁移的引用型外键齐全（引用完整性不留裸列）', () => {
  const { db, close, dataDir } = setup();
  const fks = (t) => db.prepare(`PRAGMA foreign_key_list(${t})`).all()
    .map((r) => `${r.from}->${r.table}`).sort();
  assert.deepEqual(fks('points_ledger'),
    ['edition_id->editions', 'stage_id->stages', 'team_id->teams', 'user_id->users']);
  assert.deepEqual(fks('tier_records'), ['team_id->teams']);
  assert.deepEqual(fks('behavior_events'), ['team_id->teams', 'user_id->users']);
  assert.deepEqual(fks('leaderboard_snapshots'), ['edition_id->editions', 'stage_id->stages']);
  assert.deepEqual(fks('milestones'), ['stage_id->stages', 'team_id->teams']);
  assert.deepEqual(fks('milestone_signoffs'), ['milestone_id->milestones', 'signatory_user_id->users']);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('004 迁移的 NOT NULL / DEFAULT / 类型约束符合契约', () => {
  const { db, close, dataDir } = setup();
  const col = (t, name) => db.prepare(`PRAGMA table_info(${t})`).all().find((r) => r.name === name);
  // 积分流水：kind 必填、points 是数值（不是字符串）
  assert.equal(col('points_ledger', 'kind').notnull, 1);
  assert.equal(col('points_ledger', 'points').type, 'REAL');
  // 榜单快照：scope 必填
  assert.equal(col('leaderboard_snapshots', 'scope').notnull, 1);
  // 里程碑：默认计入段位
  assert.equal(col('milestones', 'counts_toward_tier').dflt_value, '1');
  // 段位记录是软删除（必须有 deleted_at）
  assert.ok(col('tier_records', 'deleted_at'), 'tier_records 必须有 deleted_at（软删除）');
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ stage_team 赛段名册表：字段 + 唯一约束 + 外键（P2 的 D-33 登记在 P3）', () => {
  const { db, close, dataDir } = setup();
  assert.deepEqual(cols(db, 'stage_team'), ['id', 'stage_id', 'team_id', 'registered_at']);
  const fks = db.prepare('PRAGMA foreign_key_list(stage_team)').all()
    .map((r) => `${r.from}->${r.table}`).sort();
  assert.deepEqual(fks, ['stage_id->stages', 'team_id->teams']);
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('★ 赛段名册仓储：登记 / 判定 / 重复登记被唯一约束挡住', () => {
  const { db, close, dataDir } = setup();
  const edition = createEdition(db, {
    name: '首届', city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  const captain = createUser(db, { name: '队长', phone: '13800002001', password: 'pw123' });
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captain.id, status: 'active', now: NOW,
  });
  const outsider = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: captain.id, status: 'active', now: NOW,
  });

  assert.equal(isTeamInStage(db, stage.id, team.id), false, '未登记前不得判定为在册');
  assert.equal(hasStageRoster(db, stage.id), false, '登记前名册为空');
  const added = registerStageTeams(db, { stageId: stage.id, teamIds: [team.id], now: NOW });
  assert.equal(added, 1);
  assert.equal(hasStageRoster(db, stage.id), true, '登记后名册非空');
  assert.equal(isTeamInStage(db, stage.id, team.id), true);
  assert.equal(isTeamInStage(db, stage.id, outsider.id), false, '未登记的队伍不在赛段名册内');
  assert.deepEqual(listStageTeamIds(db, stage.id), [team.id]);
  // 重复登记必须被唯一约束挡住（幂等由服务层判定，仓储层不吞）
  assert.throws(() => registerStageTeams(db, { stageId: stage.id, teamIds: [team.id], now: NOW }));
  close(); rmSync(dataDir, { recursive: true, force: true });
});

test('配置校验会拒绝非法 criteria 配置 / 缺 points / personal.lifetime 非布尔', () => {
  const { rules } = loadRules(rulesDir);
  const bad1 = structuredClone(rules);
  bad1.criteria.tier = undefined;
  assert.ok(validateRules(bad1).some((e) => e.includes('criteria.tier')));
  const bad2 = structuredClone(rules);
  bad2.criteria.tier.dataOrPrototypeMilestones = [];
  assert.ok(validateRules(bad2).some((e) => e.includes('dataOrPrototypeMilestones')));
  const bad3 = structuredClone(rules);
  bad3.criteria.tier.businessDepartmentKeywords = [];
  assert.ok(validateRules(bad3).some((e) => e.includes('businessDepartmentKeywords')));
  const bad4 = structuredClone(rules);
  bad4.points = undefined;
  assert.ok(validateRules(bad4).some((e) => e.includes('points 缺失')));
  const bad5 = structuredClone(rules);
  bad5.points.personal.lifetime = 'yes';
  assert.ok(validateRules(bad5).some((e) => e.includes('personal.lifetime')));
});

test('⛔ 行为分 sortUse 必须恒为 tiebreak_only（R-PTS-08 是硬保证，不是可配置项）', () => {
  const { rules } = loadRules(rulesDir);
  const bad = structuredClone(rules);
  bad.behavior.sortUse = 'primary';
  assert.ok(validateRules(bad).some((e) => e.includes('sortUse')),
    '行为分被改成主评分口径时必须拒绝启动');
  assert.equal(validateRules(rules).length, 0, '出厂配置必须零报错');
});

test('⛔ 占位策略不得被擅自启用（观众票 / 权重回退 / 未知部门口径 / 对接会时长）', () => {
  const { rules } = loadRules(rulesDir);
  // R-OPS-11 观众票：权重无规则依据，只占位不启用
  assert.equal(rules.points.demoDayAudienceVote.enabled, false);
  assert.equal(rules.points.demoDayAudienceVote.weight, null);
  // R-JDG-21 权重回退：首届后回测
  assert.equal(rules.points.fallbackPolicy.enabled, false);
  // 签字部门写错**不得**默认算业务部门（S 档会凭空达标）
  assert.equal(rules.criteria.tier.unknownDepartmentCountsAsBusiness, false);
  // R-JDG-15 对接会：30 分钟 / 2 周内
  assert.equal(rules.criteria.enterpriseCompliance.meetingDurationMinutes, 30);
  assert.equal(rules.criteria.enterpriseCompliance.deadlineDays, 14);
});

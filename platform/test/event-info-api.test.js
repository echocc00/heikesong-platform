// platform/test/event-info-api.test.js —— 赛事规则公开接口（落地页的数据源）
//
// 规则溯源：
//   - 「规则全部配置化 + 计算留 trace」→ 全局约束
//   - 「可见性在 API 层过滤」→ 全局约束（这里过滤的是**规则**，不是数据）
//   - P9「UI 重构：落地页」→ docs/superpowers/plans/2026-10-22-platform-P9-ui-redesign.md
//
// ⚠️ 本文件为什么存在：
//   落地页要「介绍赛事与赛制」⇒ 赛制数字必须从 rules/*.json 来，不能在前端硬编码。
//   本文件守住三件事：
//     ① 投影是**白名单**：内部备注（"待组委会确认""首届后回测"…）不许进公开响应；
//     ② 投影的**形状固定**：缺配置也给空数组，不给 undefined（前端不必到处判空）；
//     ③ 投影与 rules **同源**：改 rules/*.json，落地页自动跟着变（不用改前端）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/config.js';
import { buildEventInfo } from '../src/domain/event-info.js';
import { getEventInfo } from '../src/services/public-api.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⛔ 临时目录隔离：本用例要建一个临时 SQLite 库 ⇒ 必须 import 隔离器
//    （scripts/temp-leak-scan.js 的 R1 闸会拦「建了临时目录却没有回收机制」）。
//    ⚠️ R2 闸还要求隔离器**先于**第一处临时目录调用执行 ⇒ 这行必须排在用例之前。
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const rulesDir = join(here, '..', 'rules');
const { rules } = loadRules(rulesDir);

// ══════════════════════════════════════════════════════════════════
// 一、投影的基本形状
// ══════════════════════════════════════════════════════════════════

test('投影：顶层字段固定（缺配置也给空数组，不给 undefined）', () => {
  const info = buildEventInfo({});
  const keys = Object.keys(info).sort();
  assert.deepEqual(keys, [
    'advancement', 'behaviorEvents', 'behaviorMaxWeightShare', 'formation', 'funnel',
    'redLines', 'registration', 'scoring', 'scoringPoints', 'solvability', 'stages', 'tiebreak',
    'tierNeverUnlocks', 'tiers', 'visibility',
  ].sort());
  assert.deepEqual(info.stages, []);
  assert.deepEqual(info.tiers, []);
  assert.deepEqual(info.funnel, []);
  assert.deepEqual(info.redLines, []);
  assert.equal(info.behaviorMaxWeightShare, 0);
});

test('投影：rules 为 null / undefined 时不炸（返回空骨架）', () => {
  assert.deepEqual(buildEventInfo(null).stages, []);
  assert.deepEqual(buildEventInfo(undefined).funnel, []);
});

test('投影：数值字段拒绝 NaN / Infinity（前端会渲染成 "NaN"）', () => {
  const info = buildEventInfo({
    schedule: { stages: [], advancement: { rate: Infinity, finalTopN: NaN } },
    points: { stagePoints: [10, 'x', Infinity] },
  });
  assert.equal(info.advancement.rate, 0, 'Infinity 必须被兜底成 0');
  assert.equal(info.advancement.finalTopN, 0, 'NaN 必须被兜底成 0');
  assert.deepEqual(info.scoringPoints.stagePoints, [10, 0, 0]);
});

test('投影：配置写错形状时不炸（维度不是数组 → 空数组）', () => {
  const info = buildEventInfo({ scoring: { initial: { dimensions: 'oops' } } });
  assert.deepEqual(info.scoring.initial.dimensions, []);
});

// ── P10 · W4-a：六维可解性规格投影 ──────────────────────────────────
test('P10：投影带出六维可解性规格（生产站冷启动也拿得到评估表）', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.solvability.dimensions.length, 6, '六维');
  assert.equal(info.solvability.grades.length, 4, '四档');
  assert.ok(info.solvability.vetoes.length >= 1);
  const dim = info.solvability.dimensions[0];
  assert.deepEqual(Object.keys(dim).sort(), ['key', 'label', 'max', 'weight']);
  assert.ok(dim.label.length > 0, '维度要有人读的名字');
  assert.ok(info.solvability.grades.every((g) => typeof g.minScore === 'number'));
});

test('P10：可解性投影**不泄内部备注与判定条件**（只给白名单字段）', () => {
  const info = buildEventInfo(rules);
  const veto = info.solvability.vetoes.find((v) => v.auto);
  assert.ok(veto, '至少有一条自动否决项');
  // ⛔ 判定条件（维度 + 取值）**不投影**出去：投影它等于把判定规则交给前端重算
  assert.equal(veto.dimension, undefined, '不许带判定维度');
  assert.equal(veto.equals, undefined, '不许带判定取值');
  // ⛔ 任务包配比体检是组委会的事，不进公开投影
  assert.equal(info.solvability.taskMix, undefined, '配比口径不进公开投影');
  assert.equal(info.solvability.note, undefined, '内部备注不进公开投影');
});

test('P10：可解性配置缺失时给空骨架（不炸、不给 undefined）', () => {
  const info = buildEventInfo({});
  assert.deepEqual(info.solvability.dimensions, []);
  assert.deepEqual(info.solvability.grades, []);
  assert.deepEqual(info.solvability.vetoes, []);
});

// ══════════════════════════════════════════════════════════════════
// 二、与真实 rules 的对应（投影**不许漏项、不许编项**）
// ══════════════════════════════════════════════════════════════════

test('投影：赛段表与 rules/schedule.json 一致（五段赛程与交付物）', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.stages.length, 5, '本赛事是五段赛程');
  assert.deepEqual(info.stages.map((s) => s.key), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.equal(info.stages[0].name, '调研');
  assert.ok(info.stages[0].deliverables.length > 0, '赛段要有交付物');
  assert.equal(info.stages[0].start, '10-01');
  assert.equal(info.stages[0].hardRequirement, true);
  assert.equal(info.stages.at(-1).hardRequirement, false, 'S5 落地赛段不做硬性要求');
  assert.equal(info.advancement.rate, 0.25, '入围率 25%');
  assert.equal(info.advancement.finalTopN, 32, '决赛 TOP32');
});

test('投影：初赛/决赛权重表与 rules/scoring-*.json 一致', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.scoring.initial.dimensions.length, 6);
  assert.equal(info.scoring.final.dimensions.length, 6);
  const sum = (list) => list.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(sum(info.scoring.initial.dimensions) - 1) < 1e-9, '初赛权重合计必须是 1');
  assert.ok(Math.abs(sum(info.scoring.final.dimensions) - 1) < 1e-9, '决赛权重合计必须是 1');
  const ent = info.scoring.final.dimensions.find((d) => d.key === 'enterprise');
  assert.equal(ent.weight, 0.25, '决赛「企业确认」权重 25%');
});

test('投影：段位表与权益与 rules/ranks.json 一致', () => {
  const info = buildEventInfo(rules);
  assert.deepEqual(info.tiers.map((t) => t.key), ['D', 'C', 'B', 'A', 'S']);
  const s = info.tiers.find((t) => t.key === 'S');
  assert.equal(s.requiresBusinessSignoff, true);
  assert.ok(s.benefits.includes('完赛证明'));
  assert.ok(info.tierNeverUnlocks.includes('奖金'), '段位永不解锁奖金（落地页要说明）');
});

test('投影：漏斗与 rules/registration.json 一致（末段 rate 为 null）', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.funnel.length, 5);
  assert.equal(info.funnel[0].rate, 0.3);
  assert.equal(info.funnel.at(-1).rate, null, '辅导期比例待定 ⇒ null（不是 0）');
});

test('投影：破同分链保留顺序与作用域', () => {
  const info = buildEventInfo(rules);
  assert.equal(info.tiebreak[0].label, '总分');
  assert.equal(info.tiebreak.at(-1).key, 'team_id', '最后必须是确定性兜底（队伍编号）');
  assert.equal(info.tiebreak.at(-1).deterministic, true);
  assert.deepEqual(info.tiebreak.map((c) => c.order), info.tiebreak.map((_, i) => i + 1));
});

test('投影：合规红线与 rules/compliance.json 一致', () => {
  const info = buildEventInfo(rules);
  assert.ok(info.redLines.length >= 5, '合规红线至少 5 条');
  assert.ok(info.redLines.some((r) => r.key === 'ip_no_infringement'));
});

// ══════════════════════════════════════════════════════════════════
// 三、白名单：内部备注一律不许进公开响应
// ══════════════════════════════════════════════════════════════════

test('⛔ 白名单闸：内部备注不许进公开响应', () => {
  const dumped = JSON.stringify(buildEventInfo(rules));
  for (const secret of ['待组委会确认', 'awardPointsNote', 'note', 'source', 'conflictRef']) {
    assert.ok(!dumped.includes(`"${secret}"`), `公开响应里不得出现内部字段/备注：${secret}`);
  }
  assert.ok(!dumped.includes('首届后回测'), '内部口径说明不得出现');
  assert.ok(!dumped.includes('占位题面'), '内部占位说明不得出现');
});

test('⛔ 白名单闸：赛段 note 一律不带（内部溯源说明不进公开响应）', () => {
  const info = buildEventInfo(rules);
  for (const s of info.stages) {
    assert.equal(s.note, undefined, `赛段 ${s.key} 不得带 rules 的原始 note`);
  }
  // 「这个赛段不做硬性要求」由布尔位表达，落地页据此自己写一句话。
  assert.equal(info.stages.at(-1).hardRequirement, false);
});

// ══════════════════════════════════════════════════════════════════
// 四、服务层
// ══════════════════════════════════════════════════════════════════

test('服务层：getEventInfo 与领域层投影**逐字段一致**', () => {
  assert.deepEqual(getEventInfo(rules), buildEventInfo(rules));
});

test('服务层：规则没加载时报业务错误（不是崩栈）', () => {
  assert.throws(() => getEventInfo(null), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.code, 'RULES_MISSING');
    return true;
  });
});

// ══════════════════════════════════════════════════════════════════
// 五、端点（真服务器 + 真 HTTP）
// ══════════════════════════════════════════════════════════════════

test('端点：GET /api/event-info 匿名可读，返回 200 与正确形状', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { openDatabase } = await import('../src/db/sqlite.js');
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { createApp } = await import('../src/server.js');
  const { callJson } = await import('../test-helpers/http-call.js');

  const dataDir = mkdtempSync(join(tmpdir(), 'hks-eventinfo-'));
  const { db } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  const app = createApp({ db, rules, webDir: join(here, '..', 'web') });
  try {
    const res = await callJson(app, 'GET', '/api/event-info');
    assert.equal(res.status, 200, '规则本来就该公开 ⇒ 匿名可读');
    const body = res.json;
    assert.equal(body.stages.length, 5);
    assert.ok(body.scoring.initial.dimensions.length > 0);
    assert.ok(body.tiers.length > 0);
    assert.ok(!JSON.stringify(body).includes('待组委会确认'), '内部备注不得进公开响应');
  } finally {
    db.close?.();
  }
});

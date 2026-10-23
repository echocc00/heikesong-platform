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
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

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
  // ⚠️ 每个事件必须带 **actionId**（= 一次提交动作的标识）：检测器的单位是「提交动作」
  //    而不是「评分格子」（F10）⇒ 没有 actionId 的事件**不计入**（宁可漏报也不误报）。
  const events = [
    { subjectId: 'j1', actionId: 'r1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', actionId: 'r2', at: '2026-10-20T00:00:05.000Z' },
    { subjectId: 'j1', actionId: 'r3', at: '2026-10-20T00:00:10.000Z' },
    { subjectId: 'j2', actionId: 'r4', at: '2026-10-20T00:00:01.000Z' },
  ];
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  assert.equal(r.flags.length, 0, '刚好等于阈值不报');
  assert.equal(r.maxCount, 3, 'maxCount 要如实反映窗口内最大提交数');

  const events2 = [...events, { subjectId: 'j1', actionId: 'r5', at: '2026-10-20T00:00:15.000Z' }];
  const r2 = detectBurstSubmission({ events: events2, windowSeconds: 60, threshold: 3 });
  assert.equal(r2.flags.length, 1);
  assert.equal(r2.flags[0].kind, 'burst_submit');
  assert.equal(r2.flags[0].subjectId, 'j1');
  assert.equal(r2.flags[0].count, 4);
  assert.equal(r2.flags[0].action, 'alert_only');
});

test('突发提交：同一个动作标识的多行只算一次（F10 的核心口径）', () => {
  // 判别性数据：一次提交动作写 10 行（队伍 × 维度）⇒ 若按**行**计数，必然撞穿阈值 5 ⇒ 误报。
  // 修复前（按行计数）：flags.length = 1（count 6 > 5）
  // 修复后（按动作计数）：10 行同属 1 个动作 ⇒ 只算 1 次 ⇒ 不报。
  const events = Array.from({ length: 10 }, (_, i) => ({
    subjectId: 'u_judge_A', actionId: 'req_1', at: `2026-10-23T10:00:0${i}.000Z`,
  }));
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 5 });
  assert.equal(r.flags.length, 0, '一次提交写 10 行不得被判为突发提交');
  assert.equal(r.maxCount, 1, '同一个动作标识只算一次');
  assert.equal(r.unidentified, 0);
});

test('突发提交：没有动作标识的事件不计入（不猜），并如实回报盲区条数', () => {
  // 判别性数据：10 条**没有 actionId** 的事件（旧的「按行喂」口径就是这种）
  //   ⇒ 修复后一条都不计（无法归并成动作）⇒ 不报 + 回报 unidentified = 10
  const events = Array.from({ length: 10 }, (_, i) => ({
    subjectId: 'u_judge_A', at: `2026-10-23T10:00:0${i}.000Z`,
  }));
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 5 });
  assert.equal(r.flags.length, 0, '无法归并成动作的事件不得被当成提交动作');
  assert.equal(r.maxCount, 0);
  assert.equal(r.unidentified, 10, '盲区条数必须如实回报（不静默）');
});

test('突发提交：窗口外的提交不计入', () => {
  const events = [
    { subjectId: 'j1', actionId: 'r1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', actionId: 'r2', at: '2026-10-20T00:10:00.000Z' },
    { subjectId: 'j1', actionId: 'r3', at: '2026-10-20T00:20:00.000Z' },
  ];
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  assert.equal(r.flags.length, 0);
});

test('突发提交：同一主体只报一次（连续爆发不重复报）', () => {
  // 判别性数据：窗口内 6 次提交、阈值 3 —— 循环里每多一个 end 都会再次越过阈值。
  //   「同一主体只报一次」的 break 在不在，结果差 3 倍（1 条 vs 3 条）。
  const events = Array.from({ length: 6 }, (_, i) => ({
    subjectId: 'j1', actionId: `r${i}`, at: `2026-10-20T00:00:0${i}.000Z`,
  }));
  const r = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  assert.equal(r.flags.length, 1, '同一主体只报最早的那次爆发');
  assert.equal(r.flags[0].count, 4);
});

test('突发提交：窗口边界 —— 相隔正好 windowSeconds 算同一窗口（判别性数据）', () => {
  // 判别性数据：窗口是「开区间右闭」—— 差值**正好**等于窗口长度仍算同一窗口，
  // 差 1 毫秒才算出窗。只测「差 10 分钟」测不出 `>` 写成 `>=`。
  const inside = [
    { subjectId: 'j1', actionId: 'r1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', actionId: 'r2', at: '2026-10-20T00:01:00.000Z' },
  ];
  const r = detectBurstSubmission({ events: inside, windowSeconds: 60, threshold: 1 });
  assert.equal(r.flags.length, 1, '正好相隔 60 秒仍算同一窗口');
  assert.equal(r.flags[0].count, 2);

  const outside = [
    { subjectId: 'j1', actionId: 'r1', at: '2026-10-20T00:00:00.000Z' },
    { subjectId: 'j1', actionId: 'r2', at: '2026-10-20T00:01:00.001Z' },
  ];
  const r2 = detectBurstSubmission({ events: outside, windowSeconds: 60, threshold: 1 });
  assert.equal(r2.flags.length, 0, '超出窗口 1 毫秒就不算同一窗口');
});

test('突发提交：findingKey 是稳定标识（不含时间戳 ⇒ 重算不会刷屏）', () => {
  // 判别性数据：同一批事件算两次，findingKey 必须**逐字相同**；
  //   而 windowStart 之类的**原始字段**不进键 ⇒ 键里不得出现 ISO 时间戳。
  const events = Array.from({ length: 8 }, (_, i) => ({
    subjectId: 'j1', actionId: `r${i}`, at: `2026-10-20T00:00:0${i}.000Z`,
  }));
  const a = detectBurstSubmission({ events, windowSeconds: 60, threshold: 3 });
  const b = detectBurstSubmission({ events: events.map((e) => ({ ...e })), windowSeconds: 60, threshold: 3 });
  assert.equal(a.flags.length, 1);
  assert.equal(a.flags[0].findingKey, b.flags[0].findingKey, '同一批数据重算必须得到同一个 findingKey');
  assert.ok(
    !/20\d\d-\d\d-\d\dT/.test(a.flags[0].findingKey),
    `findingKey 里不得含时间戳：${a.flags[0].findingKey}`,
  );
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
    subjectId: 'j1', actionId: `r${i}`, at: `2026-10-20T00:00:0${i}.000Z`,
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
  const events = Array.from({ length: 6 }, (_, i) => ({ subjectId: 'j1', actionId: `r${i}`, at: `2026-10-20T00:00:0${i}.000Z` }));
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
    events: [
      { subjectId: 'j1', actionId: 'r0', at: '2026-10-20T00:00:00.000Z' },
      { subjectId: 'j1', actionId: 'r1', at: '2026-10-20T00:00:01.000Z' },
      { subjectId: 'j1', actionId: 'r2', at: '2026-10-20T00:00:02.000Z' },
      { subjectId: 'j1', actionId: 'r3', at: '2026-10-20T00:00:03.000Z' },
      { subjectId: 'j1', actionId: 'r4', at: '2026-10-20T00:00:04.000Z' },
      { subjectId: 'j1', actionId: 'r5', at: '2026-10-20T00:00:05.000Z' },
    ],
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

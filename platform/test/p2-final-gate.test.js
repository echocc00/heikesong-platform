// platform/test/p2-final-gate.test.js —— P2 整分支终审的回归闸门
//
// 依据：P2 阶段终审（verifier 独立实跑审计）结论 **NOT PASS**：
//   0 Critical / **2 Important** / **5 Minor** —— 全部是「已上线接口的可达缺陷」
//   且**未在偏差表登记**。本文件是这 7 条修复的**专项回归**：
//   每一处修完的行为都在这里钉死，防止后续阶段改回去。
//
// ⚠️ 为什么单独开一个文件而不是并进 review-api / compute 的既有用例：
//   这 7 条是**终审修复**这一组变更的验收物，单独成文件才能一眼看出「修了什么、
//   有没有回归」。既有测试文件的用例是「功能」的，不是「修复」的。
//
// 规则溯源：
//   - 进度分母必须用维度全集 → 设计文档 §11「没有任何评分的队伍不参与排名」
//     + P2 计划 Task 6 修正 ④（队伍轴）+ 本次 I-1（维度轴）
//   - 评委池下限与席构成 → S7 §3.4（R-JDG-10 / R-JDG-11）
//   - 回避必须留档、撤销也要留痕 → S7 §4.2（R-JDG-09）
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
import { createUser } from '../src/db/repo/users.js';
import { createEdition } from '../src/db/repo/editions.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertStage, assignStageJudge, listStageTeams } from '../src/db/repo/stages.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { listReviewCells } from '../src/db/repo/reviews.js';
import { computeStage } from '../src/services/compute.js';
import { reinstateRecusal } from '../src/services/review.js';
import { listRecusals } from '../src/db/repo/recusals.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

/** 初赛权重表里的**评委席**维度全集（D-32 的白名单同源）。 */
const JUDGE_DIMS_INITIAL = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p2gate-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  const app = createApp({ db, rules, webDir });

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const judge = createUser(db, { name: '评委甲', phone: '13900009001', password: 'pw' });
  const judge2 = createUser(db, { name: '评委乙', phone: '13900009002', password: 'pw' });
  const admin = createUser(db, { name: '组委会', phone: '13900009003', password: 'pw' });
  const captain = createUser(db, { name: '队长', phone: '13900009004', password: 'pw' });
  const captain2 = createUser(db, { name: '队长二', phone: '13900009005', password: 'pw' });

  for (const [key, description] of [
    ['score:write', '写入评分'], ['stage:compute', '触发计算发榜'],
    ['audit:read', '读取审计与计算快照'], ['self_review:write', '提交本队自评'],
  ]) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(judge.id, 'score:write');
  grant(judge2.id, 'score:write');
  grant(admin.id, 'score:write');
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(captain.id, 'self_review:write');

  const stage = insertStage(db, {
    editionId: edition.id, key: 's1', name: '初赛', kind: 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: 'initial', status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });
  assignStageJudge(db, { stageId: stage.id, userId: judge2.id, seat: 'judge', now: NOW });

  const captainUser = captain;
  const team = insertTeam(db, {
    editionId: edition.id, name: '一队', captainId: captainUser.id, status: 'active', now: NOW,
  });
  const team2 = insertTeam(db, {
    editionId: edition.id, name: '二队', captainId: captain2.id, status: 'active', now: NOW,
  });

  return {
    db, close, dataDir, app, stage, team, team2, judge, judge2, admin, captain,
    tokenJudge: createSession(db, judge.id).token,
    tokenJudge2: createSession(db, judge2.id).token,
    tokenAdmin: createSession(db, admin.id).token,
    tokenCaptain: createSession(db, captain.id).token,
  };
}

function cleanup(ctx) {
  rmSync(ctx.dataDir, { recursive: true, force: true });
  ctx.close();
}

const postReviews = (app, token, stageId, teamId, dimension, rawScore) => call(app, 'POST', `/api/stages/${stageId}/reviews`, {
  token, body: { items: [{ teamId, dimension, rawScore }] },
});

// ═══════════════════════════════════════════════════════════════════════
// I-1（Important）：进度分母只统计「已出现过打分的维度」
// ═══════════════════════════════════════════════════════════════════════

test('★ I-1 组委会视角的进度分母用维度全集（只交 1 个维度时报 100% 的老 bug）', async () => {
  const ctx = setup();
  try {
    // 只交 innovation 一个维度（2 评委 × 1 队）
    const r1 = await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const r2 = await postReviews(ctx.app, ctx.tokenJudge2, ctx.stage.id, ctx.team.id, 'innovation', 85);
    assert.equal(r1.status, 200, r1.body);
    assert.equal(r2.status, 200, r2.body);

    const res = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/review-state`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    const teamCount = listStageTeams(ctx.db, ctx.stage.id).length;
    // 分母 = 评委数(2) × 队伍数(名册) × 评委席维度全集(5)
    assert.equal(body.total, 2 * teamCount * JUDGE_DIMS_INITIAL.length,
      `分母应为 ${2 * teamCount * JUDGE_DIMS_INITIAL.length}（维度全集），实际 ${body.total}`);
    assert.deepEqual(Object.keys(body.dimensionProgress).sort(), [...JUDGE_DIMS_INITIAL].sort(),
      '从未有人评过的维度也必须出现在 dimensionProgress 里');
    // missing = 应交单元格总数 − 已交 = 评委数 × 队伍数 × 维度全集 − 已交(2)
    const cells = 2 * teamCount * JUDGE_DIMS_INITIAL.length;
    assert.equal(body.missing.length, cells - 2,
      `missing 应为 ${cells - 2} 条，实际 ${body.missing.length}`);
    // 每个评委席维度都必须出现在 missing 里
    // （哪怕 innovation 已经交过 —— 「二队」的 innovation 单元格仍未交）
    const dimsInMissing = new Set(body.missing.map((m) => m.dimension));
    assert.deepEqual([...dimsInMissing].sort(), [...JUDGE_DIMS_INITIAL].sort(),
      '每个评委席维度都必须出现在 missing 里');
    const innovationMissing = body.missing.filter((m) => m.dimension === 'innovation');
    assert.equal(innovationMissing.length, 2,
      'innovation 只交了「一队」——「二队」的 2 个单元格必须出现在 missing 里');
    assert.ok(innovationMissing.every((m) => m.teamId === ctx.team2.id));
  } finally {
    cleanup(ctx);
  }
});

test('★ I-1 评委视角的进度分母同样用维度全集', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const res = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/review-state`, { token: ctx.tokenJudge });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    const teamCount = listStageTeams(ctx.db, ctx.stage.id).length;
    // 评委视角：分母 = 队伍数(名册) × 维度全集(5)
    assert.equal(body.total, teamCount * JUDGE_DIMS_INITIAL.length, `实际 ${body.total}`);
    assert.equal(body.missing.length, teamCount * JUDGE_DIMS_INITIAL.length - 1, `实际 ${body.missing.length}`);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// I-2（Important）：checkJudgePool 零调用方 → 评委池规则形同虚设
// ═══════════════════════════════════════════════════════════════════════

test('★ I-2 评委池不合规时 compute 必须显式告警（judge_pool_invalid）', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    const w = body.warnings.find((x) => x.code === 'judge_pool_invalid');
    assert.ok(w, `warnings 里必须有 judge_pool_invalid：${JSON.stringify(body.warnings)}`);
    // 初赛下限 7 人，本赛段只有 2 人 → 必须报出「人数不足」
    assert.ok(w.errors.some((e) => e.code === 'judge_pool_too_small'), JSON.stringify(w.errors));
    // 企业席占比 0% < 30% → 也必须报出来
    assert.ok(w.errors.some((e) => e.code === 'enterprise_share_too_low'), JSON.stringify(w.errors));
  } finally {
    cleanup(ctx);
  }
});

test('★ I-2 评委池构成必须进快照（input + trace）—— 事后复算要能看出当次发榜合不合规', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin });
    const body = JSON.parse(res.body);
    const snap = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/computations/${body.computationId}`, { token: ctx.tokenAdmin });
    assert.equal(snap.status, 200, snap.body);
    const s = JSON.parse(snap.body);
    assert.ok(s.input.judgePool, '快照 input 里必须有 judgePool');
    assert.equal(s.input.judgePool.ok, false);
    assert.ok(Array.isArray(s.input.judgePool.errors) && s.input.judgePool.errors.length > 0);
    assert.ok(s.trace.judgePool, '快照 trace 里必须有 judgePool');
    assert.equal(s.trace.judgePool.stats.voting, 2);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-1：listReviewCells 不过滤 deleted_at（与 D-35 的 listReviews 口径不一致）
// ═══════════════════════════════════════════════════════════════════════

test('★ M-1 软删除的打分不进「已评分单元格」集合（与 listReviews 的 D-35 口径一致）', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    assert.equal(listReviewCells(ctx.db, ctx.stage.id).length, 1);
    ctx.db.prepare('UPDATE stage_reviews SET deleted_at = ? WHERE stage_id = ?').run(NOW, ctx.stage.id);
    assert.deepEqual(listReviewCells(ctx.db, ctx.stage.id), [],
      '软删除的打分不得留在「已评分单元格」集合里（否则进度分母永远填不满）');
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-4：回避「撤销」只有读侧、没有写路径
// ═══════════════════════════════════════════════════════════════════════

test('★ M-4 评委本人不能撤销自己的回避（撤销比申报更严）', async () => {
  const ctx = setup();
  try {
    const rec = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '利益冲突' },
    });
    assert.equal(rec.status, 200, rec.body);
    const back = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { action: 'reinstated', teamId: ctx.team.id, reason: '其实没关系' },
    });
    assert.equal(back.status, 403, `自撤销应被拒：${back.body}`);
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 组委会可以撤销回避，且撤销后该评委的打分重新计入榜单', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    await postReviews(ctx.app, ctx.tokenJudge2, ctx.stage.id, ctx.team.id, 'innovation', 60);
    const rec = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '误报' },
    });
    assert.equal(rec.status, 200, rec.body);

    // 回避生效 → 评委甲的分被剔除
    const first = JSON.parse((await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin })).body);
    const firstTeam = first.teams.find((t) => t.teamId === ctx.team.id);
    assert.ok(first.warnings.some((w) => w.code === 'recusal_excluded'), '应报告回避剔除');
    assert.ok(firstTeam, '应有结果行');

    // 组委会撤销
    const back = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '核实后无冲突' },
    });
    assert.equal(back.status, 200, back.body);

    // 撤销后重新计算 → 不再有 recusal_excluded
    const second = JSON.parse((await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/compute`, { token: ctx.tokenAdmin })).body);
    assert.ok(!second.warnings.some((w) => w.code === 'recusal_excluded'),
      '撤销后不应再剔除该评委的打分');
    const secondTeam = second.teams.find((t) => t.teamId === ctx.team.id);
    assert.ok(secondTeam.seatP > firstTeam.seatP,
      `撤销后评委席分应回升：${firstTeam.seatP} → ${secondTeam.seatP}`);
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 撤销不存在的回避记录 → 404（单条不存在）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '撤销' },
    });
    assert.equal(res.status, 404, res.body);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-5：review-state 注释声称队长可访问，实际 403（注释与行为不符）
// ═══════════════════════════════════════════════════════════════════════

test('★ M-5 队长读 review-state → 403（注释已按实际行为改正，行为不得放宽）', async () => {
  const ctx = setup();
  try {
    const res = await call(ctx.app, 'GET', `/api/stages/${ctx.stage.id}/review-state`, { token: ctx.tokenCaptain });
    assert.equal(res.status, 403, `队长当前不应被放行：${res.body}`);
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-6：listStageTeams 用随机 UUID 排序（未对齐「兜底排序键用 rowid」约定）
// ═══════════════════════════════════════════════════════════════════════

test('★ M-6 赛段名册的排序必须确定（同一 created_at 时按 rowid，即登记顺序）', () => {
  const ctx = setup();
  try {
    const sameTime = '2026-10-20T00:00:00.000Z';
    const a = insertTeam(ctx.db, { editionId: ctx.stage.edition_id, name: '甲队', captainId: ctx.captain.id, status: 'active', now: sameTime });
    const b = insertTeam(ctx.db, { editionId: ctx.stage.edition_id, name: '乙队', captainId: ctx.captain.id, status: 'active', now: sameTime });
    const c = insertTeam(ctx.db, { editionId: ctx.stage.edition_id, name: '丙队', captainId: ctx.captain.id, status: 'active', now: sameTime });
    const ids = listStageTeams(ctx.db, ctx.stage.id).map((t) => t.teamId);
    const mine = ids.filter((id) => [a.id, b.id, c.id].includes(id));
    assert.deepEqual(mine, [a.id, b.id, c.id],
      '同一 created_at 时必须按登记顺序（rowid），不得按随机 UUID');
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// I-2 配套：权重表缺 judgePool 段 → 拒绝计算（而不是按默认值静默算）
// ═══════════════════════════════════════════════════════════════════════

test('★ I-2 权重表缺 judgePool 段时 compute 必须拒绝计算', async () => {
  const ctx = setup();
  try {
    await postReviews(ctx.app, ctx.tokenJudge, ctx.stage.id, ctx.team.id, 'innovation', 80);
    const { rules } = loadRules(rulesDir);
    const broken = structuredClone(rules);
    delete broken.scoring.initial.judgePool;
    assert.throws(
      () => computeStage({
        db: ctx.db, stageId: ctx.stage.id, actorId: ctx.admin.id, now: NOW, rules: broken,
      }),
      /judgePool 段/,
    );
  } finally {
    cleanup(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M-4 配套：同秒多条回避必须可复现地取最后一条；重复撤销 / 不填原因都要挡住
// ═══════════════════════════════════════════════════════════════════════

test('★ M-4 同一秒申报的多条回避必须可复现地取最后一条（rowid 兜底）', async () => {
  const ctx = setup();
  try {
    const sameTime = '2026-10-20T08:00:00.000Z';
    ctx.db.prepare(
      `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('rec-1', ctx.stage.id, ctx.judge.id, ctx.team.id, '第一次', 'declared', sameTime, ctx.judge.id, 'recused');
    ctx.db.prepare(
      `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('rec-2', ctx.stage.id, ctx.judge.id, ctx.team.id, '第二次', 'declared', sameTime, ctx.judge.id, 'recused');
    const rows = listRecusals(ctx.db, { stageId: ctx.stage.id, judgeId: ctx.judge.id });
    assert.deepEqual(rows.map((r) => r.id), ['rec-1', 'rec-2'], '同秒并列时必须按 rowid 排序');
    assert.equal(rows[rows.length - 1].id, 'rec-2');
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 赛段级回避列表在同秒并列时必须按登记顺序（rowid 兜底，索引序会乱）', () => {
  const ctx = setup();
  try {
    // 本条针对 `listRecusals(db, { stageId })` 这条**赛段级**分支：
    // 它走 `idx_recusals_lookup(stage_id, judge_id)` 的索引扫描，
    // 并列行的自然顺序是「judge_id 升序」而不是「登记顺序」。
    // 少了 `, rowid` 兜底，SQLite 的临时 B 树会把这个索引序原样吐出来 → 顺序错乱。
    // （上面那条带 `judgeId` 过滤的用例查不到这个洞：同 judge_id 时索引序恰好等于 rowid 序。）
    const judge3 = createUser(ctx.db, { name: '评委丙', phone: '13900009006', password: 'pw' });
    assignStageJudge(ctx.db, { stageId: ctx.stage.id, userId: judge3.id, seat: 'judge', now: NOW });

    const sameTime = '2026-10-20T09:00:00.000Z';
    // 按 id 升序排列后【倒序插入】—— 登记顺序必然与 judge_id 升序相反
    const judgeIds = [ctx.judge.id, ctx.judge2.id, judge3.id].sort();
    const insert = ctx.db.prepare(
      `INSERT INTO recusal_records (id, stage_id, judge_id, team_id, reason, source, declared_at, audit_by, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const inserted = [];
    for (const [i, judgeId] of [...judgeIds].reverse().entries()) {
      const id = `rec-par-${i}`;
      insert.run(id, ctx.stage.id, judgeId, ctx.team.id, '同秒申报', 'declared', sameTime, judgeId, 'recused');
      inserted.push(id);
    }
    const rows = listRecusals(ctx.db, { stageId: ctx.stage.id });
    assert.deepEqual(rows.map((r) => r.id), inserted,
      '赛段级 listRecusals 在 declared_at 并列时必须按登记顺序（rowid）返回，不能是索引序');
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 重复撤销 → 409；撤销不填原因 → 400', async () => {
  const ctx = setup();
  try {
    const rec = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '误报' },
    });
    assert.equal(rec.status, 200, rec.body);

    const noReason = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id },
    });
    assert.equal(noReason.status, 400, `撤销必须填原因：${noReason.body}`);

    const first = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '核实后无冲突' },
    });
    assert.equal(first.status, 200, first.body);
    const second = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '再来一次' },
    });
    assert.equal(second.status, 409, `重复撤销应 409：${second.body}`);
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 撤销必须写审计（事后要能查是谁撤的、为什么撤）', async () => {
  const ctx = setup();
  try {
    await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenJudge, body: { teamId: ctx.team.id, reason: '误报' },
    });
    const back = await call(ctx.app, 'POST', `/api/stages/${ctx.stage.id}/recusals`, {
      token: ctx.tokenAdmin, body: { action: 'reinstated', judgeId: ctx.judge.id, teamId: ctx.team.id, reason: '核实后无冲突' },
    });
    assert.equal(back.status, 200, back.body);
    const row = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'recusal.reinstate'").get();
    assert.ok(row, 'audit_log 里必须有 recusal.reinstate');
    assert.equal(row.actor_id, ctx.admin.id);
    const detail = JSON.parse(row.detail_json);
    assert.equal(detail.judgeId, ctx.judge.id);
    assert.ok(detail.supersedes, '审计里要记被撤销的那条记录 id');
  } finally {
    cleanup(ctx);
  }
});

test('★ M-4 服务层 reinstateRecusal 也要校验评委在名单内（不靠路由层代偿）', () => {
  const ctx = setup();
  try {
    const stranger = createUser(ctx.db, { name: '陌生人', phone: '13900009099', password: 'pw' });
    assert.throws(
      () => reinstateRecusal({
        db: ctx.db, stageId: ctx.stage.id, judgeId: stranger.id,
        teamId: ctx.team.id, reason: '撤销', actorId: ctx.admin.id, now: NOW,
      }),
      /未被分配到本赛段/,
    );
  } finally {
    cleanup(ctx);
  }
});

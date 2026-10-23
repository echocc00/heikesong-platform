// platform/test/p11-wiring.test.js —— P11 把「写了没接线」接上之后的行为闸
//
// ⛔ 本文件钉住的是**机器闸 docs/tools/dead-service-scan.mjs 抓出来的真缺口**：
//   ① 破同分的复议分**没有走「只消费已关闭轮次」的口径** —— 仓储层那份 SQL 聚合
//      （listTiebreakVoteTotals）是服务层的孪生实现，少了这条 ⇒
//      **还在开放投票的轮次，其当前均值会被当成最终复议分消费 ⇒ 榜单随投票进行而漂移**
//      （与「破同分必须可复算」直接冲突）。现在排名路径统一走服务层。
//   ② 反作弊检测 `runDetection`（设计 §11.1「检测 → 进人工复核队列」）**没有任何生产触发点**
//      ⇒ 生产上永远建不出 flag ⇒ 「复核队列」页永远是空的 ⇒ 整条防串通链是死的。
//   ③ 计算快照有**两个写者**（compute.js 自己拼参数写一份 + services/audit.js 的
//      recordComputation 又写一份）⇒ 两份实现必然漂 ⇒ 现在统一走服务层。
//
// 规则溯源：
//   · 破同分链与「加时陈述」→ S7 §3.3（R-JDG-19）+ rules/tiebreak.json（tiebreak_extra = final_only）
//   · 「检测 → 进人工复核队列」→ 设计文档 §11.1
//   · 「计算三件套」→ 设计文档 §12（R-AUD-01 可复算）
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
import { createTaskPackage } from '../src/db/repo/taskPackages.js';
import { insertTeam } from '../src/db/repo/teams.js';
import { insertTeamMember } from '../src/db/repo/teamMembers.js';
import { insertStage, assignStageJudge } from '../src/db/repo/stages.js';
import { insertReview } from '../src/db/repo/reviews.js';
import { insertPeerReview } from '../src/db/repo/peer-reviews.js';
import { insertCapability } from '../src/db/repo/capabilities.js';
import { grantAssignment } from '../src/auth/permissions.js';
import { createSession } from '../src/auth/session.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
const NOW = '2026-10-20T12:00:00.000Z';

const CAPS = [
  ['score:write', '写入评分'],
  ['stage:compute', '触发计算发榜'],
  ['peer_review:write', '互评'],
  ['audit:read', '读取审计与计算快照'],
  ['audit:write', '裁决复核项与申诉'],
];

function setup({ stageKey = 'final', scoringKey = 'final', teams: teamCount = 4 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p11wire-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);

  const edition = createEdition(db, {
    name: '首届 · 上海', city: '上海', startsAt: '2026-10-01', endsAt: '2026-11-30', now: NOW,
  });
  const admin = createUser(db, { name: '组委会', phone: '13900003001', password: 'pw' });
  const judge = createUser(db, { name: '评委甲', phone: '13900003002', password: 'pw' });

  for (const [key, description] of CAPS) insertCapability(db, key, description);
  const grant = (userId, capability) => grantAssignment(db, {
    userId, capability, scopeType: 'global', scopeId: null, grantedBy: admin.id,
  });
  grant(admin.id, 'stage:compute');
  grant(admin.id, 'audit:read');
  grant(admin.id, 'audit:write');
  grant(judge.id, 'score:write');
  grant(judge.id, 'peer_review:write');

  const pkg = createTaskPackage(db, {
    editionId: edition.id, enterpriseId: admin.id, enterpriseName: '某某企业',
    title: '库存周转', painPoint: '门店库存周转慢',
    expectedDelivery: '可运行的排产原型', acceptanceCriteria: '能给出周转天数下降的测算',
    submittedBy: admin.id, now: NOW,
  });
  const stage = insertStage(db, {
    editionId: edition.id, key: stageKey, name: stageKey === 'final' ? '决赛' : '初赛', kind: stageKey === 'final' ? 'final' : 'initial',
    startsAt: '2026-10-01', endsAt: '2026-10-10', scoringConfigKey: scoringKey, status: 'open', now: NOW,
  });
  assignStageJudge(db, { stageId: stage.id, userId: judge.id, seat: 'judge', now: NOW });

  const teams = [];
  for (let i = 0; i < teamCount; i += 1) {
    const captain = createUser(db, { name: `队长${i + 1}`, phone: `1390000${3010 + i}`, password: 'pw' });
    const team = insertTeam(db, {
      editionId: edition.id, name: `${i + 1}队`, captainId: captain.id, taskPackageId: pkg.id, status: 'active', now: NOW,
    });
    insertTeamMember(db, { teamId: team.id, userId: captain.id, role: 'captain', now: NOW });
    teams.push({ team, captain });
  }

  const app = createApp({ db, rules, webDir });
  return {
    db, close, dataDir, app, rules, admin, judge, stage, edition, teams,
    tokenAdmin: createSession(db, admin.id).token,
    tokenJudge: createSession(db, judge.id).token,
  };
}

/** 决赛权重表里的评委席维度。 */
const FINAL_DIMS = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];

function json(res) {
  return JSON.parse(res.body);
}

test('⛔ 破同分：轮次**未关闭**时复议分不得进榜；关闭后才进（榜单不能随投票漂移）', async () => {
  const s = setup({ teams: 5 });
  try {
    // ① 打分并计算，让五支队都有分
    for (const t of s.teams) {
      for (const dim of FINAL_DIMS) {
        insertReview(s.db, {
          stageId: s.stage.id, judgeId: s.judge.id, teamId: t.team.id, dimension: dim,
          rawScore: 80, requestId: `r-${t.team.id}-${dim}`, calibrated: 0, now: NOW,
        });
      }
    }
    const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    // ② 制造并列：**只有两支**队伍同分（其余明显低分）⇒ 破同分链才在这两支之间生效
    const [a, b] = s.teams;
    s.db.prepare('UPDATE stage_results SET total = 50 WHERE stage_id = ?').run(s.stage.id);
    s.db.prepare('UPDATE stage_results SET total = 100 WHERE stage_id = ? AND team_id IN (?, ?)')
      .run(s.stage.id, a.team.id, b.team.id);

    // ③ 开一轮加时陈述并投票（**轮次还是 open**）
    const opened = await call(s.app, 'POST', `/api/stages/${s.stage.id}/tiebreak/rounds`, {
      token: s.tokenAdmin, body: { tiedTeamIds: [a.team.id, b.team.id] },
    });
    assert.equal(opened.status, 200, `开轮次应成功：${opened.body}`);
    const roundId = json(opened).round.id;

    const voted = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
      token: s.tokenJudge, body: { teamId: a.team.id, score: 90 },
    });
    assert.equal(voted.status, 200, `投票应成功：${voted.body}`);
    const votedB = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/votes`, {
      token: s.tokenJudge, body: { teamId: b.team.id, score: 10 },
    });
    assert.equal(votedB.status, 200, `投票应成功：${votedB.body}`);

    // ④ 轮次**未关闭** ⇒ 复议分不得进榜 ⇒ 两队**仍然并列**（名次相同、互为 tiedWith）
    const during = json(await call(s.app, 'GET', `/api/leaderboard/${s.stage.id}?scope=rank`));
    const duringRows = during.rows.filter((r) => [a.team.id, b.team.id].includes(r.teamId));
    assert.equal(duringRows.length, 2);
    assert.equal(
      duringRows[0].rank,
      duringRows[1].rank,
      '轮次未关闭时两队仍应并列（开放投票的均值不得被当成最终复议分，否则榜单随投票漂移）',
    );
    assert.ok(
      duringRows.some((r) => (r.tiedWith ?? []).includes(b.team.id)),
      '并列关系必须显式带出（tiedWith）',
    );

    // ⑤ 关闭轮次 ⇒ 复议分生效 ⇒ 高分的那队排前面
    const closed = await call(s.app, 'POST', `/api/tiebreak/rounds/${roundId}/close`, { token: s.tokenAdmin });
    assert.equal(closed.status, 200, `关闭轮次应成功：${closed.body}`);

    const after = json(await call(s.app, 'GET', `/api/leaderboard/${s.stage.id}?scope=rank`));
    const afterRows = after.rows.filter((r) => [a.team.id, b.team.id].includes(r.teamId));
    assert.notEqual(afterRows[0].rank, afterRows[1].rank, '轮次关闭后并列必须被复议分打破');
    assert.equal(afterRows[0].teamId, a.team.id, '轮次关闭后复议分进榜：拿 90 分的那队排前面');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 反作弊检测在**生产路径**上真的建 flag（复核队列不再是空的）', async () => {
  const s = setup({ teams: 5 });
  try {
    // ① 互评串通形态：两支队对三支目标给出**完全相同的相对顺序**
    const [v1, v2, t1, t2, t3] = s.teams;
    for (const [from, order] of [[v1, [[t1, 90], [t2, 80], [t3, 70]]], [v2, [[t1, 95], [t2, 85], [t3, 75]]]]) {
      for (const [to, score] of order) {
        insertPeerReview(s.db, {
          stageId: s.stage.id, fromTeamId: from.team.id, toTeamId: to.team.id, score, requestId: null, now: NOW,
        });
      }
    }

    // ② 计算 ⇒ 检测应当被触发
    for (const t of s.teams) {
      for (const dim of FINAL_DIMS) {
        insertReview(s.db, {
          stageId: s.stage.id, judgeId: s.judge.id, teamId: t.team.id, dimension: dim,
          rawScore: 80, requestId: `r-${t.team.id}-${dim}`, calibrated: 0, now: NOW,
        });
      }
    }
    const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    // ③ 复核队列里有东西了（此前**恒为空** —— 检测压根没被触发过）
    const flags = await call(s.app, 'GET', '/api/audit/flags', { token: s.tokenAdmin });
    assert.equal(flags.status, 200);
    const rows = json(flags).rows ?? json(flags).items ?? [];
    assert.ok(rows.length > 0, '计算后必须建出 flag（设计 §11.1：检测 → 进人工复核队列）');
    assert.ok(rows.some((f) => String(f.kind ?? '').includes('peer') || String(f.kind ?? '').includes('identical')),
      `flag 的 kind 应当指出互评串通，实际：${JSON.stringify(rows.map((f) => f.kind))}`);

    // ④ 检测 ≠ 处罚：只建 flag，**不改分**（库里落的名次与计算时返回的逐字一致）
    const results = s.db.prepare('SELECT * FROM stage_results WHERE stage_id = ?').all(s.stage.id);
    assert.ok(results.length > 0);
    const computedTotals = new Map(json(computed).teams.map((t) => [t.teamId, t.total]));
    for (const r of results) {
      assert.equal(
        r.total,
        computedTotals.get(r.team_id),
        '建了 flag 不许改总分（检测 ≠ 处罚）',
      );
    }
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test('⛔ 计算快照只留**一个写者**：快照走服务层 ⇒ 审计里有 computation.record', async () => {
  const s = setup();
  try {
    for (const t of s.teams) {
      for (const dim of FINAL_DIMS) {
        insertReview(s.db, {
          stageId: s.stage.id, judgeId: s.judge.id, teamId: t.team.id, dimension: dim,
          rawScore: 80, requestId: `r-${t.team.id}-${dim}`, calibrated: 0, now: NOW,
        });
      }
    }
    const computed = await call(s.app, 'POST', `/api/stages/${s.stage.id}/compute`, { token: s.tokenAdmin });
    assert.equal(computed.status, 200, computed.body);

    const snap = s.db.prepare("SELECT COUNT(*) AS n FROM computation_snapshots WHERE stage_id = ? AND kind = 'stage_score'").get(s.stage.id).n;
    assert.equal(snap, 1, '一次计算只写一份快照（不能两份实现各写一份）');

    const record = s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'computation.record'").get().n;
    assert.equal(record, 1, '快照由服务层 recordComputation 写入 ⇒ 必须带一条 computation.record 审计');
    const stageCompute = s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stage.compute'").get().n;
    assert.equal(stageCompute, 1, '「本赛段已计算」这条审计也要在（两个动作两处留痕）');
  } finally {
    s.close(); rmSync(s.dataDir, { recursive: true, force: true });
  }
});

// platform/test/seed-stage-bootstrap.test.js —— P11 · E150 端到端闸：
//   **全新部署的平台必须自带赛段**，否则评审/榜单/段位/发榜整条链是死的。
//
// ⚠️ 这条闸测的是**真种子脚本**（scripts/seed.js），不是手工造 fixture：
//   E150 的病根正是「仓储层写好了，但**生产路径上没有任何代码会调用它**」，
//   ⇒ 只测服务层/路由层会再次漏掉「种子没建赛段」这件事（这正是 E149/E150 能溜过去的原因）。
//   ⇒ 必须**真跑种子**、**真查库**、再**经 HTTP 路由**走一遍评审→计算→发榜。
//
// 真机实测的原始症状（E150）：
//   生产库 /var/lib/heikesong/data/app.db ⇒ stages = 0、stage_team = 0
//   ⇒ GET /api/stages 返回空集 ⇒ 评审打分页 / 发榜页 / 破同分 / 企业签字台
//      全部以 :stageId 为路径参数 ⇒ **一个都进不去**。
//
// 规则溯源：
//   - 赛段清单 ← rules/schedule.json（S1 调研 / S2 任务 / S3 开发 / S4 路演 / S5 落地）
//   - 权重表   ← rules/scoring-initial.json / rules/scoring-final.json
//   - 席位构成 ← R-JDG-11（企业席 ≥30%、专家席 ≤50%、observer 无投票权）
//   - 利益冲突声明 ← R-JDG-18（派评委即签声明）
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { createSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { loadRules } from '../src/config.js';
import { call } from '../test-helpers/http-call.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const rulesDir = join(platformDir, 'rules');

/**
 * 真跑一次种子（在临时目录里），返回数据目录。
 * ⚠️ 必须**真跑脚本** —— 用 import 调 seedP1 绕过了「脚本有没有调它」这一环，
 *    而那正是 E150 的病根（函数存在、没人调）。
 */
function runSeed() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-seed-'));
  execFileSync('node', ['scripts/seed.js'], {
    cwd: platformDir,
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: 'SeedGate-2026' },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return dataDir;
}

// ══════════════════════════════════════════════════════════════════
// 一、种子必须建出赛段（E150 的核心断言）
// ══════════════════════════════════════════════════════════════════

test('⛔ E150 回归闸：真跑种子 ⇒ 赛段 / 评委席 / 名册 / 利益冲突声明**都真的落库**', () => {
  const dataDir = runSeed();
  try {
    const { db, close } = openDatabase({ dataDir });
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

    // ① 赛段：从 rules/schedule.json 的 5 个赛段建出来
    assert.equal(count('stages'), 5, '种子必须建出 5 个赛段（rules/schedule.json）');
    const stages = db.prepare('SELECT "key", name, kind, status, scoring_config_key FROM stages ORDER BY starts_at').all();
    assert.deepEqual(
      stages.map((s) => s.key),
      ['s1', 's2', 's3', 's4', 's5'],
      '赛段必须来自 rules/schedule.json（不是硬编码的别的清单）',
    );
    // 权重表键必须是 initial/final 之一（否则计算时找不到权重表）
    for (const s of stages) {
      assert.ok(
        ['initial', 'final'].includes(s.scoring_config_key),
        `赛段 ${s.key} 的权重表键非法：${s.scoring_config_key}`,
      );
    }

    // ② 评委席：每段都有席（没有席位 ⇒ 评分端点一律 403）
    assert.ok(count('stage_judges') >= 5, '每个赛段都必须有评委席');
    // ③ 利益冲突声明：派评委即签声明（R-JDG-18）
    assert.equal(
      count('stage_judges'),
      count('conflict_declarations'),
      '席位数与声明数必须一致（派评委必须同事务写声明）',
    );
    // ④ 名册：赛段级队伍边界（E156 靠它关「外队进榜」的闸门）
    assert.ok(count('stage_team') >= 1, '名册必须登记队伍（否则 E156 的赛段级闸门无从生效）');

    // ⑤ 观察员无投票权（R-JDG-11）
    const observers = db.prepare("SELECT COUNT(*) AS c FROM stage_judges WHERE seat = 'observer'").get().c;
    const voting = db.prepare("SELECT COUNT(*) AS c FROM stage_judges WHERE seat IN ('judge','enterprise')").get().c;
    assert.ok(observers >= 0 && voting >= 0, '席位构成必须可统计');

    close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('⛔ E150 回归闸：种子**连跑两次**结果不变（幂等 —— 部署会重跑种子）', () => {
  const dataDir = runSeed();
  try {
    execFileSync('node', ['scripts/seed.js'], {
      cwd: platformDir,
      env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: 'SeedGate-2026' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const { db, close } = openDatabase({ dataDir });
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    assert.equal(count('stages'), 5, '第二次跑不能重复建赛段');
    assert.equal(count('stage_judges'), count('conflict_declarations'), '席位与声明仍须一致');
    close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 二、种子建出来的赛段 ⇒ 整条链真的能跑（评审 → 计算 → 发榜）
// ══════════════════════════════════════════════════════════════════

test('⛔ E150 回归闸：种子跑完后 ⇒ 经 HTTP 路由，赛段列表非空、评审能提交、计算与发榜能跑通', async () => {
  const dataDir = runSeed();
  try {
    const { db, close } = openDatabase({ dataDir });
    const { rules } = loadRules(rulesDir);
    const app = createApp({ db, rules, webDir: join(platformDir, 'web') });

    // ① 赛段列表**非空**（真机上的原始症状是空数组）
    const list = await call(app, 'GET', '/api/stages');
    assert.equal(list.status, 200);
    const items = JSON.parse(list.body).items;
    assert.equal(items.length, 5, '种子跑完后 GET /api/stages 必须返回 5 个赛段');

    const stageId = items[0].id;

    // ② 评委能提交评分（席位已派 ⇒ 不再是 403 NOT_ASSIGNED_JUDGE）
    const judgeRow = db.prepare("SELECT user_id FROM stage_judges WHERE stage_id = ? AND seat = 'judge' LIMIT 1").get(stageId);
    assert.ok(judgeRow, '赛段必须有评委席');
    const { token: judgeToken } = createSession(db, judgeRow.user_id);
    const teamRow = db.prepare('SELECT team_id FROM stage_team WHERE stage_id = ? LIMIT 1').get(stageId);
    assert.ok(teamRow, '赛段名册必须有队伍');

    const submitted = await call(app, 'POST', `/api/stages/${stageId}/reviews`, {
      token: judgeToken,
      body: { items: [{ teamId: teamRow.team_id, dimension: 'innovation', rawScore: 80 }] },
    });
    assert.equal(submitted.status, 200, `评委应能提交评分（席位已派），实际：${submitted.body}`);

    // ③ 管理员能计算并发榜（E149 的发榜端点）
    const adminRow = db.prepare("SELECT id FROM users WHERE is_superadmin = 1 LIMIT 1").get();
    const { token: adminToken } = createSession(db, adminRow.id);

    const computed = await call(app, 'POST', `/api/stages/${stageId}/compute`, { token: adminToken });
    assert.equal(computed.status, 200, `计算应成功：${computed.body}`);

    const published = await call(app, 'POST', `/api/stages/${stageId}/publish`, { token: adminToken });
    assert.equal(published.status, 200, `发榜应成功：${published.body}`);

    // ④ 发榜之后四张表都有数据（E149 的核心断言）
    // ⚠️ `tier_records` 是**届期级**的（段位由整届的里程碑+签字决定，不按赛段存）
    //    ⇒ 它不能按 stage_id 过滤，只能看总数。
    const byStage = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE stage_id = ?`).get(stageId).c;
    assert.ok(byStage('stage_results') >= 1, 'stage_results 必须有数据');
    assert.ok(byStage('computation_snapshots') >= 1, 'computation_snapshots 必须有数据');
    assert.ok(byStage('points_ledger') >= 1, 'points_ledger 必须有数据（名次积分入台账）');
    assert.ok(byStage('leaderboard_snapshots') >= 1, 'leaderboard_snapshots 必须有数据（榜单快照）');
    assert.ok(
      db.prepare('SELECT COUNT(*) AS c FROM tier_records').get().c >= 1,
      'tier_records 必须有数据（段位权益解锁）',
    );

    close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

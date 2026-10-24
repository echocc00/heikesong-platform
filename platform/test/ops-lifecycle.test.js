// test/ops-lifecycle.test.js — 运维生命周期回归（2026-10-25 评审轮 P1-4 / P2-7）
//
// 覆盖三组：
//   ① P1-4a 写库脚本（seed / migrate）在服务还活着时**必须拒绝**执行（单写者闸）
//   ② P1-4b 两个实例**并发**启动同一个 DATA_DIR ⇒ 只有一个能活（独占创建消 TOCTOU）
//   ③ P2-7a/b prune.js 清理过期数据 + deploy/ 下的 systemd 定时单元
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/repo/users.js';
import { insertSession } from '../src/db/repo/sessions.js';
import { incrementBucket } from '../src/db/repo/rate-limit.js';
import { pruneExpiredData, RATE_LIMIT_RETENTION_SECONDS } from '../scripts/prune.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const deployDir = join(platformDir, 'deploy');
const migrationsDir = join(platformDir, 'db', 'migrations');
const rulesDir = join(platformDir, 'rules');

function readDeploy(name) {
  return readFileSync(join(deployDir, name), 'utf8');
}

// ══════════════════════════════════════════════════════════════════
// P1-4a：单写者闸 —— 写库脚本在服务还活着时必须拒绝执行
// ══════════════════════════════════════════════════════════════════
test('P1-4a 服务还活着时 seed / migrate 必须拒绝执行（单写者闸）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-gate-'));
  // 造一个「服务还活着」：pid 文件登记**本进程**的 pid（它确实活着）
  writeFileSync(join(dataDir, 'app.pid'), String(process.pid), 'utf8');

  const cases = [
    ['seed.js', { ADMIN_PASSWORD: '仅用于测试', ADMIN_PHONE: '13900000001' }],
    ['migrate.js', {}],
  ];
  for (const [script, extraEnv] of cases) {
    const res = spawnSync(process.execPath, [join(platformDir, 'scripts', script)], {
      env: { ...process.env, DATA_DIR: dataDir, ...extraEnv },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(res.status, 1, `${script} 必须以退出码 1 拒绝执行（实际 ${res.status}）`);
    assert.match(
      res.stderr,
      /单写者|仍在运行|已被占用/,
      `${script} 必须给人话报错（实际 stderr：${res.stderr.slice(0, 300)}）`,
    );
    // ⛔ 闸必须**在开库之前**拦住 ⇒ 库里不该出现任何表（连迁移都没跑）
    assert.ok(
      !existsSync(join(dataDir, 'app.db')),
      `${script} 在闸拦下之前就已经开库了（单写者闸必须早于开库）`,
    );
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test('P1-4a 服务没在跑时 seed / migrate 必须能正常执行（闸不能误伤）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-gate-ok-'));
  // 前提：目录里**没有** pid 文件 ⇒ 没有活着的服务
  const migrate = spawnSync(process.execPath, [join(platformDir, 'scripts', 'migrate.js')], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(migrate.status, 0, `migrate 必须能跑通（stderr：${migrate.stderr.slice(0, 300)}）`);

  const seed = spawnSync(process.execPath, [join(platformDir, 'scripts', 'seed.js')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: '仅用于测试',
      ADMIN_PHONE: '13900000002',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(seed.status, 0, `seed 必须能跑通（stderr：${seed.stderr.slice(0, 300)}）`);
  rmSync(dataDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// P1-4b：并发启动同一个 DATA_DIR ⇒ 只有一个能活
//   （修复前是「先查 pid 文件、几百毫秒后才写自己的 pid」⇒ 两个都能通过检查）
// ══════════════════════════════════════════════════════════════════
test('P1-4b 同一个 DATA_DIR 并发启动两个实例，只有一个能活', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-race-'));
  const start = () => spawn(process.execPath, [join(platformDir, 'src', 'server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const a = start();
  const b = start();
  let aErr = '';
  let bErr = '';
  a.stderr.on('data', (d) => { aErr += d; });
  b.stderr.on('data', (d) => { bErr += d; });
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const alive = [a, b].filter((p) => p.exitCode === null);
    assert.equal(
      alive.length, 1,
      `同一个 DATA_DIR 起了 ${alive.length} 个实例（必须恰好 1 个）—— 单写者闸没起作用`
      + `（A：${aErr.slice(0, 200)}｜B：${bErr.slice(0, 200)}）`,
    );
    const loser = a.exitCode === null ? b : a;
    const loserErr = a.exitCode === null ? bErr : aErr;
    assert.match(
      loserErr,
      /已被占用|仍在运行|无法解析/,
      `被挡下的那个实例必须给人话报错（实际：${loserErr.slice(0, 300)}）`,
    );
    assert.notEqual(loser.exitCode, null, '被挡下的那个实例必须退出');
  } finally {
    a.kill('SIGKILL');
    b.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// P2-7a：prune 清理过期会话与过期限频计数
// ══════════════════════════════════════════════════════════════════
test('P2-7a prune 删掉过期会话与过期限频计数，且不动还在有效期内的', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-prune-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const user = createUser(db, { name: '清理甲', phone: '13900000003', password: 'pw' });

  insertSession(db, {
    tokenHash: 'h_expired',
    userId: user.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
  });
  insertSession(db, {
    tokenHash: 'h_valid',
    userId: user.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-02T00:00:00.000Z',
  });

  incrementBucket(db, {
    subjectKey: 'login:old',
    rule: 'sliding:loginAttempt',
    bucket: 'old',
    now: '2026-01-01T00:00:00.000Z',
  });
  incrementBucket(db, {
    subjectKey: 'login:new',
    rule: 'sliding:loginAttempt',
    bucket: 'new',
    now: '2026-06-01T00:00:00.000Z',
  });

  const result = pruneExpiredData(db, { now: new Date('2026-06-02T00:00:00.000Z') });
  assert.equal(result.sessions, 1, '过期会话必须被删掉');
  assert.equal(result.rateLimit, 1, '过期限频计数必须被删掉');

  const sessions = db.prepare('SELECT token_hash FROM sessions ORDER BY token_hash').all();
  assert.deepEqual(sessions.map((r) => r.token_hash), ['h_valid'], '未过期的会话必须留下');

  const events = db.prepare('SELECT subject_key FROM rate_limit_events ORDER BY subject_key').all();
  assert.deepEqual(events.map((r) => r.subject_key), ['login:new'], '窗口内的限频计数必须留下');

  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('P2-7a 限频计数的保留时长必须严格大于任何规则的窗口（否则删了等于绕过限频）', () => {
  // 判据来自**真实规则配置**（rules/audit.json），不是写死的数字：
  // 保留时长一旦小于某个规则的窗口，那个窗口内的计数就会被删掉 ⇒ 限频被绕过。
  const rules = JSON.parse(readFileSync(join(rulesDir, 'audit.json'), 'utf8'));
  let widest = 0;
  for (const [name, profile] of Object.entries(rules.rateLimit || {})) {
    const widths = [
      profile.sliding?.seconds ?? 0,
      profile.lock?.seconds ?? 0,
      profile.perMinute ? 60 : 0,
      profile.perHour ? 3600 : 0,
    ];
    for (const w of widths) widest = Math.max(widest, w);
    assert.ok(widest >= 0, `规则 ${name} 的窗口口径读不出来`);
  }
  assert.ok(widest > 0, 'rules/audit.json 里必须真的有限频规则（否则这条断言是假绿）');
  assert.ok(
    RATE_LIMIT_RETENTION_SECONDS > widest,
    `限频计数保留时长 ${RATE_LIMIT_RETENTION_SECONDS}s 必须严格大于最宽的窗口 ${widest}s`
    + '（否则会删掉还在窗口内的计数 ⇒ 限频被绕过）',
  );
});

// ══════════════════════════════════════════════════════════════════
// P2-7b：systemd 定时单元（备份 / 清理）
// ══════════════════════════════════════════════════════════════════
test('P2-7b deploy/ 下必须有备份与清理的 systemd 单元与定时器', () => {
  const files = [
    'heikesong-backup.service',
    'heikesong-backup.timer',
    'heikesong-prune.service',
    'heikesong-prune.timer',
  ];
  for (const f of files) {
    assert.ok(existsSync(join(deployDir, f)), `缺少 deploy/${f}`);
  }

  // 备份单元：oneshot + 指向真实脚本 + 占位符齐全
  const backupService = readDeploy('heikesong-backup.service');
  assert.match(backupService, /^Type=oneshot$/m, '备份必须是 oneshot（不是第二个常驻写进程）');
  assert.match(backupService, /^ExecStart=.*scripts\/backup\.js$/m, '备份单元必须调用 scripts/backup.js');
  assert.match(backupService, /^User=\w+/m, '备份必须以非 root 运行');
  for (const ph of ['__APP_DIR__', '__DATA_DIR__', '__RUN_USER__']) {
    assert.ok(backupService.includes(ph), `备份单元缺少占位符 ${ph}`);
  }

  // 清理单元：同上
  const pruneService = readDeploy('heikesong-prune.service');
  assert.match(pruneService, /^Type=oneshot$/m, '清理必须是 oneshot');
  assert.match(pruneService, /^ExecStart=.*scripts\/prune\.js$/m, '清理单元必须调用 scripts/prune.js');

  // 定时器：OnCalendar 合法 + Persistent + Unit 指向真实存在的 service
  for (const [timer, service] of [
    ['heikesong-backup.timer', 'heikesong-backup.service'],
    ['heikesong-prune.timer', 'heikesong-prune.service'],
  ]) {
    const unit = readDeploy(timer);
    assert.match(unit, /^OnCalendar=\*-\*-\* \d{2}:\d{2}:\d{2}$/m, `${timer} 必须有合法的每日触发时刻`);
    assert.match(unit, /^Persistent=true$/m, `${timer} 必须 Persistent（关机期间错过的要补跑）`);
    assert.match(unit, new RegExp(`^Unit=${service}$`, 'm'), `${timer} 必须指向 ${service}`);
    assert.match(unit, /^WantedBy=timers\.target$/m, `${timer} 必须开机自启`);
  }
});

test('P2-7b install.sh 必须安装并启用这两个定时器', () => {
  const sh = readDeploy('install.sh');
  assert.match(sh, /heikesong-backup\.timer/, 'install.sh 必须安装备份定时器');
  assert.match(sh, /heikesong-prune\.timer/, 'install.sh 必须安装清理定时器');
  assert.match(
    sh, /systemctl enable --now [^\n]*heikesong-backup\.timer/,
    '备份定时器必须被 enable 且立即启动',
  );
  assert.match(
    sh, /systemctl enable --now [^\n]*heikesong-prune\.timer/,
    '清理定时器必须被 enable 且立即启动',
  );
});

test('P1-4a install.sh 必须在迁移/种子之前停服（否则新闸会让升级直接失败）', () => {
  // ⚠️ 这条是**顺序**断言，不是「有没有这个函数」的断言：
  //    迁移改的是 schema、种子改的是权限规则 ⇒ 服务还在跑时执行会写坏库
  //    ⇒ scripts/migrate.js 与 scripts/seed.js 现在自己会拒绝执行
  //    ⇒ install.sh 必须**先停服**，否则「升级一台在跑的服务」会直接失败。
  const sh = readDeploy('install.sh');
  const mainIdx = sh.indexOf('\nmain() {');
  assert.ok(mainIdx > 0, '找不到 main()，测试本身失效');
  const mainBody = sh.slice(mainIdx);

  const stopIdx = mainBody.indexOf('stop_service_for_maintenance');
  const initIdx = mainBody.indexOf('init_database');
  assert.ok(stopIdx > 0, 'main() 里必须调用停服步骤（升级时服务是运行中的）');
  assert.ok(initIdx > 0, 'main() 里必须调用 init_database，测试本身失效');
  assert.ok(
    stopIdx < initIdx,
    '⛔ 停服必须在 init_database（迁移 + 种子）**之前** —— 否则升级时闸会拒绝执行',
  );

  // 停服函数本身必须真的停（不能只是打条日志）
  const fn = sh.slice(sh.indexOf('stop_service_for_maintenance() {'));
  assert.match(fn, /systemctl stop "\$SERVICE_NAME"/, '停服函数必须真的 systemctl stop');
  assert.match(fn, /systemctl is-active/, '停服前必须先判断服务是否在跑（首次安装时它不在跑）');
});

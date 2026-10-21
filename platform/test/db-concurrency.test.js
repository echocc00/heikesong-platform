// platform/test/db-concurrency.test.js —— 连接层并发开库回归
//
// 缺陷背景（P5 的 worker 在「真并发建库」时撞到，父代理实证定位）：
//   原实现把 `PRAGMA journal_mode = WAL` 排在 `PRAGMA busy_timeout = 5000` **之前**，
//   而且 —— 关键 —— **切 journal_mode 需要独占锁，SQLite 的 busy handler 不覆盖这一步**。
//   ⇒ 两条连接同时开同一个**新库**时，后者立刻 "database is locked"（errcode=5）。
//
// 探针证据（/tmp/p4-proof/probe-wal-lock-2.mjs）：
//   实验 A：库里**已是** WAL + 另一连接持写锁 → 设 WAL **成功（0ms）**（no-op，不取锁）
//   实验 B：库里**仍是** delete + 另一连接持写锁 → 设 WAL **0ms 即失败**（errcode=5）
//            且 busy_timeout 设成 5000 也**不等** ⇒ busy_timeout 对这一步无效
//   实验 C/D：顺序开 / 已是 WAL 时再开 → 成功（0ms）
//
// 修法：切 WAL 改成「读当前模式 → 已是 wal 直接返回（no-op）→ 否则带**退避重试**地切」。
//       busy_timeout 提到最前，让其余取锁操作有界等待。
//
// 四条用例：
//   ① 常规路径不回归（顺序开两个连接，三个 pragma 都对）
//   ② **持锁时开新连接必须等到锁释放**（确定性回归；旧实现直接抛 "database is locked"）
//   ③ **重试预算耗尽必须抛错**（不无限等待 —— 启动不能被一把锁吊死；这条守的是新实现）
//   ④ **并发首开**（4 个连接同时开同一个新库）全部成功
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openDatabase } from '../src/db/sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, '..', 'test-helpers', 'db-worker.js');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hks-dbcon-'));
}

test('常规路径不回归：顺序开两个连接都成功，三个 pragma 都对', () => {
  const dataDir = tempDir();
  const a = openDatabase({ dataDir });
  assert.equal(a.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(a.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(a.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);

  // 第二次开同一个库：此时库已是 WAL ⇒ 切模式是 no-op（不取锁）⇒ 必须立刻成功
  const b = openDatabase({ dataDir });
  assert.equal(b.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

  a.close();
  b.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('持锁时开新连接：必须等到锁释放（不能 0ms 失败）', async () => {
  const dataDir = tempDir();
  const worker = new Worker(WORKER, {
    workerData: { role: 'lock-holder', dataDir, holdMs: 400 },
  });
  const [msg] = await once(worker, 'message');
  assert.equal(msg.locked, true, 'worker 必须先拿到写锁');

  const t0 = Date.now();
  const conn = openDatabase({ dataDir });       // 旧实现在这里直接抛 "database is locked"
  const waited = Date.now() - t0;

  // 「等到了」和「恰好也成功了」是两回事 —— 只断言成功会放过「没等就抢到锁」的假象
  assert.ok(
    waited >= 300,
    `必须真的等到了锁释放（实际只等了 ${waited}ms —— 说明没等就过去了）`,
  );
  assert.equal(conn.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

  conn.close();
  await worker.terminate();
  rmSync(dataDir, { recursive: true, force: true });
});

test('锁一直不放：重试预算耗尽后必须抛错（启动不能被一把锁吊死）', async () => {
  const dataDir = tempDir();
  const worker = new Worker(WORKER, {
    workerData: { role: 'lock-holder', dataDir, holdMs: 10000 },
  });
  await once(worker, 'message');

  const t0 = Date.now();
  assert.throws(
    () => openDatabase({ dataDir, walRetryBudgetMs: 300 }),
    /database is locked/,
    '预算耗尽必须抛错，不能一直等下去',
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `必须在预算附近就放弃（实际 ${elapsed}ms）`);

  await worker.terminate();
  rmSync(dataDir, { recursive: true, force: true });
});

test('并发首开：4 个连接同时开同一个新库，全部成功', async () => {
  const dataDir = tempDir();
  const N = 4;
  const workers = [];
  const results = [];

  for (let i = 0; i < N; i += 1) {
    const w = new Worker(WORKER, { workerData: { role: 'opener', dataDir } });
    workers.push(w);
    w.on('message', (m) => { if (m.ok !== undefined) results.push(m); });
  }

  // 等所有 worker 就绪后同时放行 —— 制造「同时首开同一个新库」的竞争
  await new Promise((r) => setTimeout(r, 300));
  workers.forEach((w) => w.postMessage({ go: true }));

  const deadline = Date.now() + 15000;
  while (results.length < N && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await Promise.all(workers.map((w) => w.terminate()));

  assert.equal(
    results.length,
    N,
    `全部 ${N} 个连接都该成功（实际只回来 ${results.length} 个：${JSON.stringify(results)}）`,
  );
  assert.deepEqual(
    results.filter((r) => !r.ok),
    [],
    '不允许有连接失败（旧实现会在这里报 "database is locked"）',
  );

  rmSync(dataDir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../src/http/body.js';

test('正常 JSON body 解析成对象', async () => {
  const req = Readable.from([Buffer.from('{"a":1}')]);
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('body 超限抛 413', async () => {
  const req = Readable.from([Buffer.alloc(1024, 0x61)]);
  await assert.rejects(
    () => readJsonBody(req, { limit: 10 }),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
  );
});

test('body 超限时先销毁请求流再抛 413（用探针钉住调用与顺序）', async () => {
  // ⚠️ 评审修正（Important）：原来那条 `assert.equal(req.destroyed, true)` 是**恒真**的 ——
  //    Node 的异步迭代器在提前 break 时自己就会销毁流，
  //    把 readJsonBody 里的 req.destroy() 换成 req.resume()，这条断言照样 PASS
  //    （评审实测：变异后全量 79/79 仍绿）→ 「先销毁再抛 413」这个修复没被钉住。
  //    这里改成**探针**：统计 destroy() 被调用几次，并在**抛错那一刻**取值，
  //    于是「销毁发生在抛错之前」被真正钉住。
  //    关键手法：req.iterator({ destroyOnReturn: false }) 让迭代器提前退出时**不**销毁流，
  //    于是计数只可能来自 readJsonBody 自己的 req.destroy() 调用。
  let destroyCalls = 0;
  let resumeCalls = 0;
  const req = Readable.from([Buffer.alloc(1024, 0x61)]);
  const origDestroy = req.destroy.bind(req);
  const origResume = req.resume.bind(req);
  req.destroy = (...args) => { destroyCalls += 1; return origDestroy(...args); };
  req.resume = (...args) => { resumeCalls += 1; return origResume(...args); };
  req[Symbol.asyncIterator] = () => req.iterator({ destroyOnReturn: false });

  let destroyCallsAtThrow = -1;
  await assert.rejects(
    () => readJsonBody(req, { limit: 10 }),
    (err) => {
      destroyCallsAtThrow = destroyCalls;
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
  );
  assert.equal(destroyCallsAtThrow, 1, '抛 413 之前必须已经销毁请求流');
  assert.equal(resumeCalls, 0, '有 destroy() 就不该再走 resume 兜底');
});

test('请求体上限的**默认值**是 512KB（不传 limit 时也必须限）', async () => {
  // ⛔ 终审修正（Important，I-B）：上限的**默认值**此前零断言 ——
  //    现有用例都传了显式 `{ limit: 10 }`，把默认值改成 100MB 全量测试照样全绿。
  //    而默认值才是**生产实际生效**的那个（HTTP 层调用 readJsonBody 时不传 limit）。
  //    没有上限 = 任何人都能往内存里灌任意大的 body → OOM。
  const KB = 1024;
  const MB = 1024 * KB;

  // 刚好**等于**上限 → 通过（body 必须是**合法 JSON**，否则先被 JSON 解析拦下，
  // 测的就不是「大小上限」这条护栏了）
  // ⚠️ 终审复核修正（Minor，F-2）：这里原来用 `512 * KB - 1`（差一字节），
  //    于是把实现的 `size > limit` 改成 `size >= limit` 仍然全绿（实测 SURVIVED）。
  //    边界语义是「**超过**上限才拒绝」= 恰好等于上限必须放行 →
  //    用例必须正好取 512KB 才能钉住这条。
  const mkJson = (totalBytes) => {
    const head = '{"a":"';
    const tail = '"}';
    const pad = 'x'.repeat(totalBytes - head.length - tail.length);
    return Buffer.from(head + pad + tail);
  };
  const under = Readable.from([mkJson(512 * KB)]);
  await assert.doesNotReject(() => readJsonBody(under), '正好 512KB（等于上限）必须放行');

  // 超过上限 → 413（用默认 limit，不传参）
  const over = Readable.from([mkJson(512 * KB + 1)]);
  await assert.rejects(
    () => readJsonBody(over),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
    '超过默认上限必须回 413',
  );

  // 反例对照：显式传更大的 limit 时，同一个 body 必须放行
  //（证明上一条确实是「默认上限」在起作用，而不是 body 本身有问题）
  const same = Readable.from([mkJson(512 * KB + 1)]);
  await assert.doesNotReject(
    () => readJsonBody(same, { limit: 2 * MB }),
    '显式放宽 limit 后同一 body 必须放行',
  );
});

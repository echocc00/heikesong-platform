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

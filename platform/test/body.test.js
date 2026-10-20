import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../src/http/body.js';

test('正常 JSON body 解析成对象', async () => {
  const req = Readable.from([Buffer.from('{"a":1}')]);
  assert.deepEqual(await readJsonBody(req), { a: 1 });
});

test('body 超限抛 413，并销毁请求流（不留下悬挂连接）', async () => {
  // ⛔ 预审修正（I4-1）：超限时先销毁请求流再抛错，
  //    否则客户端继续发剩余 body → 连接悬挂（慢速上传可占住连接）。
  const req = Readable.from([Buffer.alloc(1024, 0x61)]);
  await assert.rejects(
    () => readJsonBody(req, { limit: 10 }),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      return true;
    },
  );
  assert.equal(req.destroyed, true);
});

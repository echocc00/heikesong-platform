import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('相同密码两次哈希结果不同（盐随机）', () => {
  const a = hashPassword('pw123');
  const b = hashPassword('pw123');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
});

test('正确密码校验通过', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
});

test('错误密码校验失败', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('wrong horse', stored), false);
});

test('存储格式包含成本参数', () => {
  const parts = hashPassword('x').split('$');
  // ⛔ 预审修正（C5-1）：6 段 —— scrypt$N$r$p$salt$hash
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.ok(Number.isInteger(Number(parts[1])));
});

test('损坏的存储串不抛异常，返回 false', () => {
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', ''), false);
});

// ⛔ 终审修正（Important，I-6-1）：段数守卫必须钉住「**恰好 6 段**」。
//    终审变异 `parts.length !== 6` → `parts.length < 5` 全量测试照样全绿 ——
//    因为当时的用例只测了 'garbage' 与 '' 两种形态，都不满足「段数介于 5 和 6 之间」。
//    这里用**多一段**的合法哈希：它的 salt/hash 两段是**真的**，
//    所以只要段数守卫被放宽，verifyPassword 就会走进正常校验并返回 **true**。
test('多一段的存储串（7 段）必须判 false —— 段数守卫不能被放宽', () => {
  const valid = hashPassword('pw123');
  const seven = `${valid}$extra`;
  assert.equal(seven.split('$').length, 7, '本用例的前提是 7 段');
  assert.equal(verifyPassword('pw123', seven), false, '7 段串必须被段数守卫拒绝');
  // 对照：6 段原串必须仍然通过，否则本用例就变成了「一律 false」的恒绿断言
  assert.equal(verifyPassword('pw123', valid), true, '6 段合法串必须仍然通过');
});

test('少一段的存储串（5 段）返回 false 且**不抛异常**（登录热路径不能崩）', () => {
  // ⚠️ 5 段串会让 hashB64 变成 undefined → Buffer.from(undefined) 抛 TypeError。
  //    解构出来的 salt/hash 在 try 之外时，这个 TypeError 会一路冒泡 →
  //    登录接口 500、甚至拖死进程。所以 Buffer.from 必须在 try 之内。
  const five = 'scrypt$16384$8$1$c2FsdA==';
  assert.doesNotThrow(() => verifyPassword('x', five), '5 段串不得抛异常');
  assert.equal(verifyPassword('x', five), false);
});

test('盐是 16 字节、派生密钥是 64 字节（设计文档 §7.5）', () => {
  // ⚠️ 评审修正（Minor）：盐长度此前没有任何断言钉住 —— 把 16 改成 8 也能过 CI。
  const parts = hashPassword('x').split('$');
  assert.equal(parts.length, 6);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16, '每用户独立 16 字节随机盐');
  assert.equal(Buffer.from(parts[5], 'base64').length, 64, '派生密钥 64 字节');
});

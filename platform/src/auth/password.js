// src/auth/password.js — 密码哈希
// 依据：设计文档 §7.5。用 node:crypto 内置 scrypt，零 npm 依赖。
// 存储格式：scrypt$N$r$p$<saltB64>$<hashB64>
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  // ⛔ 预审修正（C5-1）：守卫原来写 5 段，但 hashPassword 产出的是 6 段
  //    （scrypt$N$r$p$salt$hash）→ 合法哈希一律被判为 false，没有人能登录。
  //    规范侧是 6 段（INTERFACES.md:62 / 设计文档 §7.5），守卫与解构必须一致。
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;

  // ⛔ 终审修正（Important，I-6-1）：Buffer.from 必须在 try **里面**。
  //    6 段守卫挡住的是「段数不对」，但段数对了不代表内容对：
  //    段数守卫一旦被改坏（终审变异 `!== 6` → `< 5`），5 段串会让
  //    hashB64 变成 undefined → Buffer.from(undefined) 抛 TypeError
  //    → 而它在 try 外面 → **未捕获异常** → 登录热路径上整个进程退出。
  //    现状（守卫正确）不抛，但这条不变量没有任何断言钉住 —— 放进 try 是
  //    第二道防线，与守卫互不依赖。
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = scryptSync(String(plain), salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
  } catch {
    return false;
  }
  // 常时比较，避免时序侧信道
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

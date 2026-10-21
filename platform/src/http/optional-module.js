// src/http/optional-module.js — 「模块在不在」的**可判定**加载器
//
// 依据：P4 终审（Important，I-2）—— 无差别 `catch {}` 会把
//   「模块在场但加载期崩溃」（语法错 / 传递依赖缺失）也报成「模块未落地」。
//   fail closed 本身是对的，但**诊断是假的**：运维会被指向「模块还没写」这个错误方向，
//   而真实原因是「模块在、但它自己炸了」。
//
// 判据：只有「**目标模块文件本身**不存在」才算未落地。
//   实测（探针 /tmp/p4-proof/probe-errshape.mjs，三种失败逐个打）：
//     ① 目标模块不存在          → code=ERR_MODULE_NOT_FOUND, url=**目标文件**
//     ② 目标在场、传递依赖缺失   → code=ERR_MODULE_NOT_FOUND, url=**缺失的那个依赖**
//     ③ 目标在场、加载期抛错      → code=undefined
//   ①②的 code **完全一样** ⇒ 光看 code 分不出来，只能看「出错指向的文件是不是目标本身」。
//   本实现用「目标文件在磁盘上是否真的存在」判定（比比对 url 稳，不受 symlink 归一化影响）：
//     目标不存在        → 确实未落地 → 返回 null（调用方据此 fail closed）；
//     目标存在却报 BUSY/模块找不到 → 是**它的依赖**缺了 → **不算未落地**，抛出去。
//
// ⛔ 抛出去的真异常会走 server.js 的 5xx 分支 ⇒ 对外只回通用 500 文案，不外泄内部细节。
import { existsSync } from 'node:fs';

/**
 * @param {string} specifier 动态 import 的**绝对 URL**（file://…）。
 *   ⚠️ 必须是绝对 URL：动态 import 的解析基准是**本文件**，
 *      传相对说明符会解析到错的地方（调用方的相对基准在调用方自己手里）。
 * @param {string} targetPath 该模块在**磁盘上**的绝对路径
 * @returns {Promise<object|null>} 模块在 → 它的命名空间；确实未落地 → null
 * @throws 其它一切异常（模块在场却加载失败 —— 别装成「没落地」）
 */
export async function loadOptionalModule(specifier, targetPath) {
  try {
    return await import(specifier);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && !existsSync(targetPath)) {
      return null;
    }
    console.error(`[optional-module] ${specifier} 加载失败（不是「未落地」）：`, err);
    throw err;
  }
}

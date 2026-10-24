// platform/test-helpers/internal-codes.js — 内部规则键清单（测试专用共享工具）
//
// ⛔ 它是**测试辅助工具**，不是被测代码：放在 test-helpers/ 下，
//    零依赖守卫（test/zero-deps.test.js 的 SCAN_DIRS 含 'test-helpers'）会一起扫，
//    本文件只用 Node 标准库（node:fs / node:path），符合「零 npm 依赖」承诺。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
//   「内部规则键不许出现在用户可见界面上」这条闸，如果只钉住手写的几个码
//   （normalization_fallback / R2_missing_dual_signature 这种），
//   那么**新加**的码只要没顺手补进清单就漏过去 ⇒ 闸是**假绿**的
//   （与「禁用清单必须真有词条，空清单不等于已保护」同一类病）。
//   ⇒ 清单必须**从源码实时抽**：领域层/服务层每写一个 `code: '…'` 就自动进清单
//   ⇒ 漏一个就红。
//
// ⚠️ **抽的是「告警的 code 字段」**（`code: '…'` 这种**具名属性**字面量）：
//   - 它**不包括** HTTP 错误码（`appError(404, 'STAGE_NOT_FOUND', …)` 是位置参数）——
//     那些是三态语义的一部分，出现在错误消息里是合理的。
//   - 它**包括**领域层与服务层产出的告警码（judge_pool_invalid / R2_… /
//     tiebreak_key_unusable / NO_COMPUTATION_SNAPSHOT …）。
//
// ⚠️ **fail-closed 取向**：清单只增不减（不设排除名单）。
//   唯一被排除的是 `src/services/auth.js` —— 它那三个 `code:` 是
//   **口令校验结果**（`{ ok: false, code: 'PASSWORD_TOO_SHORT' }`），不是告警；
//   但它们**同样不许出现在界面上** ⇒ 保留在清单里（宁可多扫）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = resolve(HERE, '..');

/** 递归列出目录下所有 .js 文件（按路径排序 ⇒ 抽取结果稳定）。 */
function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 内部规则键清单（告警 code 的全集）。
 * @param {string} [platformDir] 平台目录（默认 platform/）
 * @returns {string[]} 排序后的码数组
 */
export function internalWarningCodes(platformDir = PLATFORM_DIR) {
  const files = [
    ...listJsFiles(join(platformDir, 'src', 'domain')),
    ...listJsFiles(join(platformDir, 'src', 'services')),
  ];
  const codes = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bcode:\s*'([A-Za-z0-9_]+)'/g)) codes.add(m[1]);
  }
  return [...codes].sort();
}

/**
 * 规则的**英文维度键**清单（同样是内部标识）。
 * ⚠️ 维度键来自 `rules/scoring-*.json` 的 `dimensions[].key`
 *    —— 这些键会随规则集演进 ⇒ 必须实时抽（手写清单会漂）。
 * @param {string} [platformDir] 平台目录（默认 platform/）
 * @returns {string[]} 排序后的维度键数组
 */
export function internalDimensionKeys(platformDir = PLATFORM_DIR) {
  const rulesDir = join(platformDir, 'rules');
  const keys = new Set();
  for (const name of readdirSync(rulesDir).sort()) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(rulesDir, name), 'utf8'));
    } catch {
      continue;   // 不是规则文件 / 解析失败 ⇒ 跳过（不是本闸要管的事）
    }
    for (const dim of parsed?.dimensions ?? []) {
      if (typeof dim?.key === 'string') keys.add(dim.key);
    }
  }
  return [...keys].sort();
}

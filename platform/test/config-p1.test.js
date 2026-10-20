// platform/test/config-p1.test.js —— P1 阶段新增配置的配置校验守卫
//
// 为什么单独开一个文件（而不是往 P0 的 test/config.test.js 里加）：
//   P0 的 config.test.js 是 **P0 建立**的文件，条数已在 P0 计划里声明（23 条）。
//   往里加用例会让 P0 计划的条数声明当场过期 —— 跨阶段的同一条纪律是
//   「计划声明的条数 == 实跑条数」，改一处要改两处。
//   P1 自己新增的配置（P1 加了 teamFormation / schedule / compliance 三份）
//   相关断言放在 P1 自己的文件里 → P0 的文件与计划**一字不动**。
//
// 依据：设计文档 §4.2「运行时与依赖」+ §6.1「三条设计原则」+ §6.7「配置清单」
//   「version 会写进计算 trace」—— version 漂移 = 审计链在说谎。
//   全局约束「配置校验 fail-fast」：配置改坏就拒绝启动，不静默降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, validateRules } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

// P1 新增的三份配置
const P1_KEYS = ['teamFormation', 'schedule', 'compliance'];

test('P1 新增的 3 份配置都存在、都带 version、且与全体同版本', () => {
  const { rules } = loadRules(rulesDir);
  for (const key of P1_KEYS) {
    assert.ok(rules[key], `${key} 必须存在`);
    assert.equal(typeof rules[key].version, 'string', `${key} 必须带 version`);
  }
  const versions = new Set();
  const collect = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (typeof value.id === 'string') { versions.add(value.version); return; }
    for (const inner of Object.values(value)) collect(inner);
  };
  collect(rules);
  assert.equal(versions.size, 1, `全部配置的 version 必须同版本，实际 ${[...versions].join(' / ')}`);
});

test('新增配置的 version 漂移会被拒绝（不是只校验 P0 那 9 份）', () => {
  // ⚠️ 2026-10-21 验收修正（与 P2–P6 漂移审计的 I-2 同一条）：
  //    version 校验原先是**硬编码的 9 项列表** —— P1 新增的 3 份配置
  //    的 version 漂移**根本不会被发现**（实跑：零报错）。
  //    改成自动派生后，新增配置漂移立刻被抓。
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  broken.teamFormation.version = '2099-01-01';
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('version')), `必须报 version 不一致，实际 ${JSON.stringify(errors)}`);
});

test('新增的配置缺少 version 会被拒绝', () => {
  const { rules } = loadRules(rulesDir);
  const broken = structuredClone(rules);
  delete broken.schedule.version;
  const errors = validateRules(broken);
  assert.ok(errors.some((e) => e.includes('缺少 version')), `必须报缺少 version，实际 ${JSON.stringify(errors)}`);
});

test('配置份数对不上会被拒绝（整份配置没被识别到）', () => {
  // expectedCount 来自 FILES 的键数 —— 有配置**没被识别到**时必须报错，
  // 否则「少一份配置」会静默通过（计算 trace 上的 version 就是错的）。
  const { rules } = loadRules(rulesDir);
  const errors = validateRules(rules, 99);
  assert.ok(errors.some((e) => e.includes('份')), `必须报份数不符，实际 ${JSON.stringify(errors)}`);
});

test('solvability 的否决项配置坏了会被拒绝（vetoes 非空 / key 唯一 / auto 指向真实维度）', () => {
  // ⚠️ 2026-10-21 独立评审修正（Minor M-2：**vetoes 完全没有校验**）：
  //    原来 validateRules 只查 dimensions 与 grades，`solvability.vetoes` 一个字都没查 ——
  //    否决项写成空数组、或两条同名、或 auto 指向不存在的维度，都能通过校验、
  //    直到算分时才出问题（或者干脆**静默失效**：维度推导出的否决项整个消失）。
  const { rules } = loadRules(rulesDir);

  const empty = structuredClone(rules);
  empty.solvability.vetoes = [];
  assert.ok(
    validateRules(empty).some((e) => e.includes('vetoes')),
    'vetoes 为空必须被拒绝',
  );

  const duplicated = structuredClone(rules);
  duplicated.solvability.vetoes[1].key = duplicated.solvability.vetoes[0].key;
  assert.ok(
    validateRules(duplicated).some((e) => e.includes('重复 key')),
    'vetoes 的 key 重复必须被拒绝',
  );

  const dangling = structuredClone(rules);
  dangling.solvability.vetoes[0].auto.dimension = 'no_such_dimension';
  assert.ok(
    validateRules(dangling).some((e) => e.includes('auto.dimension')),
    'auto 指向不存在的维度必须被拒绝',
  );
});

// src/domain/solvability.js — 六维可解性评估（纯函数）
// 依据：顶层文档 §3.2（六维 + A 10-12 / B 7-9 / C 4-6 / D ≤3 + 三条一票否决）
// 依据：顶层文档 §3.1.1 / §3.2（R-ENT-08 分级签约与对应协议）
// 依据：顶层文档 §3.1（R-ENT-09 配比 70% B 端 + 30% 自由）
// 溯源需求：R-ENT-06 / R-ENT-07 / R-ENT-08 / R-ENT-09
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

// 分档：按 minScore 向下匹配。分值落在两档之间时取更低一档（不向上取整）
function gradeOf(score, config) {
  const grades = [...config.grades].sort((a, b) => b.minScore - a.minScore);
  for (const g of grades) {
    if (score >= g.minScore) return g.key;
  }
  return grades[grades.length - 1].key;
}

// 一票否决（R-ENT-07）：
//   ① 无法提供《数据授权说明》 ← 数据可得性 = 0
//   ② 无企业侧唯一责任人     ← 责任可归属 = 0
//   ③ 涉及生产系统且未谈责任归属 ← 只能由出题方自报
// ① ② 由六维推导（这两维本身就是同一件事的两种说法），③ 只能自报。
function detectVetoes({ answers, config }) {
  const hit = new Set();
  for (const key of Array.isArray(answers.vetoes) ? answers.vetoes : []) {
    if (config.vetoes.some((v) => v.key === key)) hit.add(key);
  }
  if (Number(answers.data_access ?? 0) <= 0) hit.add('no_data_authorization');
  if (Number(answers.accountability ?? 0) <= 0) hit.add('no_responsible_owner');
  return config.vetoes.filter((v) => hit.has(v.key)).map((v) => v.key);
}

/**
 * 六维加权 → 0–12 分 → A/B/C/D → 承诺与协议。
 * 命中任一否决项 → grade 强制为 D、commitment = '无'，
 * 但仍必须出《问题可解性诊断报告》（不静默丢弃）。
 */
export function scoreSolvability({ answers, config }) {
  const a = answers && typeof answers === 'object' ? answers : {};
  // 分制上限取自配置的档位上限（A 的 maxScore = 12），不写死
  const scoreMax = Math.max(...config.grades.map((g) => g.maxScore));

  const explain = [];
  let total = 0;
  for (const dim of config.dimensions) {
    const raw = Number(a[dim.key] ?? 0);
    const value = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), dim.max) : 0;
    const contribution = dim.max > 0 ? (value / dim.max) * dim.weight * scoreMax : 0;
    total += contribution;
    explain.push({
      dimension: dim.key,
      label: dim.label,
      value,
      max: dim.max,
      weight: dim.weight,
      contribution: round(contribution, 2),
      note: `${dim.label} ${value}/${dim.max}，权重 ${round(dim.weight * 100, 0)}%，折算 ${round(contribution, 2)}/${scoreMax}`,
    });
  }

  const score = round(total, 2);
  const computedGrade = gradeOf(score, config);
  const vetoes = detectVetoes({ answers: a, config });
  const grade = vetoes.length ? 'D' : computedGrade;
  const gradeCfg = config.grades.find((g) => g.key === grade) ?? config.grades[config.grades.length - 1];
  const dGrade = config.grades.find((g) => g.key === 'D');

  return {
    score,
    grade,
    computedGrade,
    vetoes,
    // R-ENT-08：分级签约与对应协议（A 试点承诺书+数据授权说明 / B 对标试点协议 / C 场景提供协议 / D 退回但出诊断报告）
    commitment: vetoes.length ? '无' : gradeCfg.commitment,
    agreement: vetoes.length
      ? (dGrade?.agreement ?? '退回，但必出问题可解性诊断报告')
      : gradeCfg.agreement,
    explain,
  };
}

/**
 * 任务卡配比校验（R-ENT-09）：任务池 = A 级 40% / B 级 20% / C 级 10% / 自由题 30%。
 *
 * ⚠️ 父代理预审修正（Critical，规格缺陷）：**分母是全体任务卡（total），不是 B 端子集**。
 *    需求原文（docs/requirements-traceability.md R-ENT-09）：
 *      「A 级 40% / B 级 20% / C 级 10% / 自由题 30%」—— 四档相加正好 100%，
 *      即**四类瓜分整个任务池**。
 *    原来的实现用 `expected = enterprise * ratio`（分母 = B 端卡数），
 *    与计划自带的测试用例直接冲突（父代理预审实跑复现）：
 *      「[TASK_MIX_GRADE_A] B 端内部 A 级 4/7，目标占比 40%」→ 17 条用例挂 1 条。
 *    三处独立佐证「分母 = total」：
 *      ① P0 已实现的 validateRules（src/config.js）校验
 *         `enterpriseGradeSplit` 合计 == `taskMix.enterprise`（0.40+0.20+0.10 = 0.70）；
 *         只有「占总池比例」的口径才成立（若是 B 端子集占比，三者之和不必等于 0.70）。
 *      ② 计划自己的注记「40+20+10=70」把三档比例锚在 70% 这个**总量占比**上。
 *      ③ 测试夹具 4A/2B/1C/3自由（10 张）= 40%/20%/10%/30%，正是总量口径。
 *
 * ⚠️ 父代理预审修正（Critical，形状错配）：入参是**服务层已呈现（present）的任务卡**，
 *    其自由题标记字段名是 `isFreeBrief`（驼峰）。原来的实现读 `p.is_free_brief`（下划线）
 *    —— 对 presented 对象恒为 undefined → 自由题恒算 0 → 配比体检恒报
 *    「自由命题占比 0%」（父代理预审实跑复现：3 张自由卡被算成 0 张）。
 *    现在统一读 presented 形状（`Number(p.isFreeBrief) === 1` 对 boolean 与 0/1 都成立）。
 *    领域层不认数据库行形状 —— 要传数据库行必须先经 presentTaskPackage 转换。
 */
export function checkTaskMix(packages, config) {
  const mix = config.taskMix ?? {};
  const tolerance = mix.tolerance ?? 0.1;
  const list = Array.isArray(packages) ? packages : [];
  const total = list.length;
  const free = list.filter((p) => Number(p.isFreeBrief) === 1).length;
  const enterprise = total - free;
  const actualFree = total ? round(free / total, 4) : 0;
  const actualEnterprise = total ? round(enterprise / total, 4) : 0;

  const byGrade = {};
  for (const p of list) {
    if (Number(p.isFreeBrief) === 1) continue;
    const g = p.grade ?? 'ungraded';
    byGrade[g] = (byGrade[g] ?? 0) + 1;
  }

  const errors = [];
  if (total > 0 && Math.abs(actualFree - (mix.free ?? 0)) > tolerance) {
    errors.push(
      `[TASK_MIX_FREE] 自由命题占比 ${round(actualFree * 100, 1)}%，目标 ${round((mix.free ?? 0) * 100, 1)}%（容差 ±${round(tolerance * 100, 1)} 个百分点）`,
    );
  }
  for (const [g, ratio] of Object.entries(mix.enterpriseGradeSplit ?? {})) {
    const actual = byGrade[g] ?? 0;
    const expected = total * ratio;
    if (enterprise > 0 && Math.abs(actual - expected) > total * tolerance) {
      errors.push(
        `[TASK_MIX_GRADE_${g}] 任务池内 ${g} 级 ${actual}/${total}，目标占比 ${round(ratio * 100, 1)}%`,
      );
    }
  }

  return { ok: errors.length === 0, total, free, enterprise, actualFree, actualEnterprise, byGrade, errors };
}

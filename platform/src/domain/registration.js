// src/domain/registration.js — 报名算分分级（纯函数）
// 依据：SABC v1 §二（3 维权重 25/35/40、每维 1–5 分、阈值 80/60/40）
// 依据：SABC v1 §一/§五（C 级不接收、筛选标准对外透明）
// 依据：设计文档 §13（报名分级边界：79/80、59/60、39/40）
// 溯源需求：R-REG-06 / R-REG-07 / R-REG-08 / R-REG-09 / R-REG-11
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。时间由调用方传入。
// ✅ 口径：每维 5 题取【均值】∈ [1,5] → 三维加权求和 ∈ [1,5] → 线性折算到 0–100 → 阈值判级。

// SABC v1 §六 待补 1：3 维各 5 题。配置里若给了题目清单，以配置为准
const DEFAULT_ITEMS_PER_DIM = 5;

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function dimensionItems(config, key) {
  return config.questions?.dimensionItems?.[key] ?? [];
}

/**
 * 总分 → 等级。阈值取自配置（80/60/40），边界为"分数 ≥ 阈值"即进档。
 * 依据：R-REG-07（SABC v1 §二 原文「80-100→S；60-79→A；40-59→B；0-39→C」）
 */
export function classifyLevel(score, config) {
  const levels = [...config.levels].sort((a, b) => b.minScore - a.minScore);
  for (const lv of levels) {
    if (score >= lv.minScore) return lv.key;
  }
  return levels[levels.length - 1].key;
}

/**
 * 校验问卷填写。返回错误信息数组，空数组 = 通过。
 * 依据：R-REG-11（3 维各 5 题 + 1 道开放式题，SABC v1 §六 待补 1）
 */
export function validateRegistrationAnswers(answers, config) {
  const errors = [];
  const a = answers && typeof answers === 'object' ? answers : {};

  for (const dim of config.dimensions) {
    const list = a[dim.key];
    const expected = dimensionItems(config, dim.key).length || DEFAULT_ITEMS_PER_DIM;
    if (!Array.isArray(list)) {
      errors.push(`${dim.label}：必须提交 ${expected} 道题`);
      continue;
    }
    if (list.length !== expected) {
      errors.push(`${dim.label}：必须提交 ${expected} 道题，实际 ${list.length} 道`);
    }
    list.forEach((v, i) => {
      if (!Number.isInteger(v)) {
        errors.push(`${dim.label} 第 ${i + 1} 题：必须为整数`);
      } else if (v < dim.min || v > dim.max) {
        errors.push(`${dim.label} 第 ${i + 1} 题：取值须在 ${dim.min}–${dim.max} 之间`);
      }
    });
  }

  const openCfg = config.openQuestion ?? {};
  const open = a.open;
  if (openCfg.required) {
    if (typeof open !== 'string' || open.trim() === '') {
      errors.push('开放式题：必填');
    } else if (open.length > (openCfg.maxLength ?? 500)) {
      errors.push(`开放式题：不超过 ${openCfg.maxLength ?? 500} 字`);
    }
  }
  return errors;
}

/**
 * 算分 + 判级 + 可解释明细。
 * 依据：R-REG-06（3 维 100 分）、R-REG-07（阈值）、R-REG-08（C 级不接收）
 * 返回的 explain 直接用于「可解释明细」界面（R-REG-09 / 设计文档 §9 报名问卷）
 */
export function scoreRegistration({ answers, config }) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const scaleMin = config.scale?.min ?? 1;
  const scaleMax = config.scale?.max ?? 5;
  const scoreMax = config.scale?.scoreMax ?? 100;

  const dimensionScores = {};
  const explain = [];
  let weighted = 0;

  for (const dim of config.dimensions) {
    const list = Array.isArray(a[dim.key]) ? a[dim.key] : [];
    const raw = list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0;
    const w = raw * dim.weight;
    weighted += w;
    dimensionScores[dim.key] = round(raw, 4);
    explain.push({
      dimension: dim.key,
      label: dim.label,
      raw: round(raw, 4),
      weight: dim.weight,
      weighted: round(w, 4),
      note: `${dim.label} ${list.length} 题均值 ${round(raw, 2)}/${dim.max}，权重 ${round(dim.weight * 100, 0)}%，加权 ${round(w, 4)}`,
    });
  }

  // 线性折算：加权均值 ∈ [scaleMin, scaleMax] → [0, scoreMax]
  const normalized = scaleMax === scaleMin ? 0 : (weighted - scaleMin) / (scaleMax - scaleMin);
  const score = round(normalized * scoreMax, 2);
  const level = classifyLevel(score, config);
  const levelCfg = config.levels.find((l) => l.key === level);

  return {
    score,
    dimensionScores,
    level,
    // R-REG-08：C 级不接收（"某些画像的同学可能就不适合，是要删掉的"）
    accepted: levelCfg ? levelCfg.accept === true : false,
    explain,
  };
}

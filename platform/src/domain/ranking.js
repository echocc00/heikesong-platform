// src/domain/ranking.js — 名次计算与破同分链（纯函数）
// 依据：设计文档 §6.4 + 冲突裁决 C-03 + R-RNK-06 + R-PTS-08
//   ⛔ 本模块【绝不】把行为分并进总分：行为分只以破同分链的 'behavior' 键出现，
//      且 scope 必须是 tied_only（链的最后一项实质依据）——见 assertChainInvariants()。
//      依据 S10 §3.3「行为分只做垫底排序：同分时的第一排序依据 ❌、最后排序依据 ✅」。
//   ✅ 借鉴 HackSC/hibiscus `libs/calculateRankings.ts`（MIT）的 1224 并列名次算法，
//      本实现独立编写；上游 `calculatePoints.ts` 的 switch 穿透 bug 不在此处（见 points.js）。
//   ✅ 破同分最后一级用【队伍编号（行 ID）】而不是时间戳：借 CTFd
//      `utils/scores/__init__.py` 的 `ORDER BY score DESC, date ASC, id ASC` 双保险，
//      官方注释理由是【不同数据库的时间精度不同】，只用时间字段排序不稳。
//
// 【告警文案分层 2026-10-23 —— 与 src/domain/scoring.js 同一套口径】
//   { code, message, detail?, ...原有字段 }
//   ⛔ 触发条件与口径没改，只改文案分层：
//   ① `message` 只给人读 ⇒ 破同分键用**中文 label**（rules/tiebreak.json 的 label），
//      label 缺失时**不许**退回英文 key（team_id / peer …），退成中性说法。
//   ② `detail` 是内部明细（键的英文 key + 缺可比值的队伍 id）⇒ 只给 audit:read 的人看。
import { cmpStr, toNumber } from './util.js';

// 破同分链的键 → 候选队伍上的字段名（INTERFACES.md §4 的 teams 字段名）
const KEY_FIELD = {
  total: 'total', tiebreak_extra: 'tiebreakExtra', peer: 'peerScore',
  enterprise_raw: 'enterpriseRaw', behavior: 'behaviorScore', team_id: 'teamId',
};
const fieldOf = (key) => KEY_FIELD[key] || key;

/**
 * 数值型破同分键 —— 这些键必须按**数值**比较。
 * ⚠️ 为什么不能「是字符串就按字符串比」：字符串形态的 `"100" < "90"`（字典序），
 *    100 分的队会被排到 90 分的队**后面** —— 榜单顺序错，且**没有任何报错**。
 *    `team_id` 不在此列：队伍编号是标识符，永远按字符串比（'0123' 与 '123' 是两支队）。
 */
const NUMERIC_KEYS = new Set(['total', 'tiebreak_extra', 'peer', 'enterprise_raw', 'behavior']);

/**
 * 数值型破同分键的**比较容差**（F35）。
 *
 * ⚠️ 为什么不能按 `String(value)` 分桶（原来的写法）：
 *    `70` 与 `70.00000000000001`（差 1 ULP ≈ 1.42e-14）**数学上完全相等**，
 *    但字符串不同 ⇒ 被判成**两个组** ⇒ 两队拿到**不同名次 + 不同赛段积分（10 vs 8）**，
 *    而且同分却**没记成同分**（tiedWith 为空）⇒ 破同分链在最该并列的地方拆开了并列。
 *    审计实测的可达性：当前 `scoreStage` 对两队用**同一个表达式**算 total ⇒ 位级相同，
 *    端到端尚未触发；**但只要两队的 total 来自不同代码路径**（一队的企业席分来自 R4 替换、
 *    另一队来自 seatScore，或某赛段由旧规则版本写过）⇒ DB 里的 REAL 就存下不同的位 ⇒ 触发。
 *    ⇒ 这是**潜伏缺陷**，必须按「数学相等即同分」修。
 *
 * ⛔ 容差取 **1e-9**：分数量级 0–100 ⇒ 1e-9 比任何**真实**分差（最小 0.01）小 7 个数量级，
 *    只用来吸收浮点表示误差（1 ULP ≈ 1.4e-14 @ 70），不会把真的不同分判成同分。
 */
const NUMERIC_EPSILON = 1e-9;

function readValue(candidate, key, data) {
  const bucket = (data?.byTeam || {})[candidate.teamId];
  if (bucket) {
    if (bucket[key] !== undefined && bucket[key] !== null) return bucket[key];
    const f = fieldOf(key);
    if (bucket[f] !== undefined && bucket[f] !== null) return bucket[f];
  }
  const f = fieldOf(key);
  if (candidate[f] !== undefined && candidate[f] !== null) return candidate[f];
  if (candidate[key] !== undefined && candidate[key] !== null) return candidate[key];
  return null;
}

function compareValues(a, b, direction, key) {
  if (a === b) return 0;
  const dir = direction === 'asc' ? 1 : -1;
  if (NUMERIC_KEYS.has(key)) {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na === null || nb === null) return 0;
    return (na - nb) * dir;
  }
  return cmpStr(a, b) * dir;
}

/**
 * 按破同分键把一个并列组分成若干「桶」（同桶 = 同分）。
 *
 * ⛔ **数值键不许用 `String(value)` 分桶**（F35）—— 见 NUMERIC_EPSILON 的注释。
 *    数值键改成：**按数值排序后，相邻差 ≤ 容差的归同一个桶**（连续游程）。
 *    为什么用「排序 + 相邻游程」而不是「量化取整」：量化（`round(n/eps)*eps`）
 *    在大数上会因 `n/eps` 超出 2^53 丢精度 ⇒ 反而把**相等**的值分到不同桶；
 *    游程比较只看**相邻差**，与量级无关。
 *
 * 非数值键（如 `team_id`）保持字符串分桶 —— 队伍编号是**标识符**，
 * '0123' 与 '123' 是两支队，不能按数值合并。
 *
 * @returns {Array<Array>} 每个元素是一个桶（队伍数组）
 */
function bucketByKey(group, item, data) {
  const key = item.key;
  const values = group.map((c) => readValue(c, key, data));

  const stringBuckets = () => {
    const buckets = new Map();
    group.forEach((c, i) => {
      const k = String(values[i]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    });
    return [...buckets.values()];
  };

  if (!NUMERIC_KEYS.has(key)) return stringBuckets();

  const nums = values.map((v) => toNumber(v));
  // ⛔ 有**非数值**（脏数据 / 口径不符）⇒ 不猜：退回字符串分桶（与历史行为一致）。
  if (nums.some((n) => n === null)) return stringBuckets();

  const rows = group.map((c, i) => ({ c, v: nums[i] }));
  rows.sort((a, b) => a.v - b.v);
  const parts = [];
  let cur = [rows[0]];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].v - cur[cur.length - 1].v > NUMERIC_EPSILON) {
      parts.push(cur.map((r) => r.c));
      cur = [];
    }
    cur.push(rows[i]);
  }
  parts.push(cur.map((r) => r.c));
  return parts;
}

/** 破同分链不变量校验（C-03 链 + R-PTS-08）。返回错误数组，空 = 通过。 */
export function assertChainInvariants(chain, { behaviorConfig } = {}) {
  const errors = [];
  if (!Array.isArray(chain) || !chain.length) return ['破同分链缺失或为空'];
  if (!chain[chain.length - 1]?.deterministic) {
    errors.push('破同分链必须以确定性兜底项结尾（deterministic: true），否则榜单不可复算（R-AUD-01）');
  }
  if (!chain.some((c) => c.key === 'total')) errors.push('破同分链缺少总分项');
  const bi = chain.findIndex((c) => c.key === 'behavior');
  if (bi >= 0) {
    if (chain[bi].scope !== 'tied_only') errors.push(`破同分项 'behavior' 的 scope 必须是 tied_only（当前 ${chain[bi].scope}）——R-PTS-08`);
    if (bi === 0) errors.push("破同分项 'behavior' 不得排在链首（R-PTS-08：同分时的第一排序依据不可用）");
    if (bi !== chain.length - 2) errors.push("破同分项 'behavior' 必须是最后一项实质依据（其后只能是确定性兜底项）");
    if (behaviorConfig?.sortUse && behaviorConfig.sortUse !== 'tiebreak_only') {
      errors.push(`行为分 sortUse 必须是 tiebreak_only（当前 ${behaviorConfig.sortUse}）`);
    }
  }
  return errors;
}

/**
 * 按链顺序逐项细分并列组。
 * - scope=always     ：对每个并列组都生效
 * - scope=tied_only  ：只对尚未分开的并列组生效
 * - scope=final_only ：只在决赛（data.isFinal=true）生效
 * - deterministic    ：只决定组内展示顺序，【不】拆组（并列名次不变）
 * 缺可比较值时该键在本组【不可用】并给 warning——绝不静默当 0 分。
 */
export function applyTiebreakChain({ candidates, chain, data }) {
  const errors = assertChainInvariants(chain);
  if (errors.length) throw new Error(`破同分链配置非法，拒绝计算：${errors.join('；')}`);

  const list = Array.isArray(candidates) ? [...candidates] : [];
  const isFinal = Boolean(data?.isFinal);
  const warnings = [];
  const applied = [];
  let groups = list.length ? [list] : [];

  for (const item of chain) {
    const scopeActive = (item.scope || 'always') !== 'final_only' || isFinal;
    const next = [];
    const usedBy = [];
    let separated = false;

    for (const group of groups) {
      if (group.length < 2 || !scopeActive) { next.push(group); continue; }
      const missing = group.filter((c) => readValue(c, item.key, data) === null);
      if (missing.length) {
        const label = item.label || '未命名依据';
        const missingIds = missing.map((c) => c.teamId);
        warnings.push({
          code: 'tiebreak_key_unusable',
          message: `破同分键「${label}」在本组缺少可比较的值，本组不使用该键`,
          detail: `破同分键 ${item.key}：以下队伍在本组没有可比较的值（${missingIds.join('、')}）`,
          teamIds: missingIds,
        });
        next.push(group);
        continue;
      }
      if (item.deterministic) {
        // 确定性兜底：只决定组内顺序，【不】拆组（并列名次不变）
        next.push([...group].sort((a, b) => compareValues(
          readValue(a, item.key, data), readValue(b, item.key, data), item.direction, item.key,
        )));
        usedBy.push(...group.map((c) => c.teamId));
        continue;
      }
      const parts = bucketByKey(group, item, data);
      if (parts.length > 1) {
        parts.sort((a, b) => compareValues(
          readValue(a[0], item.key, data), readValue(b[0], item.key, data), item.direction, item.key,
        ));
        separated = true;
        usedBy.push(...group.map((c) => c.teamId));
        next.push(...parts);
      } else {
        next.push(group);
      }
    }
    groups = next;
    if (usedBy.length) applied.push({ key: item.key, label: item.label || item.key, usedBy, separated });
  }
  return { ordered: groups.flat(), applied, groups, warnings };
}

/** A 榜名次（1224 式并列）。teams: [{ teamId, total, seatP, seatE, peerScore, enterpriseRaw, behaviorScore }] */
export function rankTeams({ teams, tiebreakChain, tiebreakData, pointsConfig }) {
  const { ordered, applied, groups, warnings } = applyTiebreakChain({
    candidates: (Array.isArray(teams) ? teams : []).map((t) => ({ ...t })),
    chain: tiebreakChain || [],
    data: tiebreakData || {},
  });
  const out = [];
  let before = 0;
  for (const group of groups) {
    const rank = before + 1;              // 1224 式：名次 = 本组之前的队伍数 + 1（并列占位，名次跳号）
    const ids = group.map((c) => c.teamId);
    for (const c of group) {
      out.push({
        teamId: c.teamId,
        rank,
        total: c.total ?? null,
        tiedWith: ids.filter((x) => x !== c.teamId),
      });
    }
    before += group.length;
  }
  return {
    ordered: out,
    tieGroups: groups.map((g) => g.map((c) => c.teamId)),
    rankStyle: pointsConfig?.tieRankStyle || '1224',
    applied,
    warnings,
  };
}

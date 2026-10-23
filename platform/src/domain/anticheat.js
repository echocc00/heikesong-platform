// src/domain/anticheat.js — 防作弊检测器（纯函数层）
// 依据：设计文档 §11.1（防刷分与防串通）+ §3.4 零件 7（多账号协同检测是全行业空白）
//   R-RNK-08 异常互评检测（S10 §0.4「同分互投率过高由组委会复核」）
// ⛔ 检测 ≠ 处罚：本文件只产出 flag（"有疑问"），不改分、不封号、不自动裁决。
// 纯函数：无 IO、无 Date.now()、无 Math.random()。时间一律由入参给出。

function pickVoter(r) {
  return r.judgeId ?? r.fromId ?? r.voterId ?? null;
}

function pickTarget(r) {
  return r.teamId ?? r.toId ?? r.targetId ?? null;
}

function sign(a, b) {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * 两位评委对重叠项目给出完全相同的相对顺序 → 疑似串通。
 * 借鉴 Gavel 追加式决策日志的思路（AGPL，⛔ 只读思路独立实现）。
 */
export function detectIdenticalPeerPattern({ peerReviews = [], minOverlap = 3 }) {
  const byVoter = new Map();
  for (const r of peerReviews) {
    const voter = pickVoter(r);
    const target = pickTarget(r);
    if (voter === null || target === null) continue;
    if (!byVoter.has(voter)) byVoter.set(voter, new Map());
    byVoter.get(voter).set(target, Number(r.score));
  }

  const voters = [...byVoter.keys()].sort();
  const flags = [];
  for (let i = 0; i < voters.length; i += 1) {
    for (let j = i + 1; j < voters.length; j += 1) {
      const a = byVoter.get(voters[i]);
      const b = byVoter.get(voters[j]);
      const overlap = [...a.keys()].filter((t) => b.has(t));
      if (overlap.length < minOverlap) continue;

      let same = true;
      let compared = 0;
      for (let x = 0; x < overlap.length && same; x += 1) {
        for (let y = x + 1; y < overlap.length; y += 1) {
          const ta = overlap[x];
          const tb = overlap[y];
          compared += 1;
          if (sign(a.get(ta), a.get(tb)) !== sign(b.get(ta), b.get(tb))) {
            same = false;
            break;
          }
        }
      }
      if (same && compared > 0) {
        flags.push({
          kind: 'identical_peer_pattern',
          voterA: voters[i],
          voterB: voters[j],
          overlap: overlap.length,
          targets: overlap.slice().sort(),
          matchRatio: 1,
          action: 'alert_only',   // ⛔ 只告警，不处罚
        });
      }
    }
  }
  return { flags };
}

/**
 * 短时间窗口内突发提交。
 * 借鉴 hack-the-back app/services/judging.py 的思路（MIT），只读思路独立实现。
 *
 * ⚠️ **单位是「提交动作」，不是「评分格子」**（F10）：
 *    `stage_reviews` 的粒度是**队伍 × 维度** ⇒ 一次正常的表单提交（1 评委 × 2 队 × 5 维度）
 *    会写 **10 行**。若把**行**当「提交事件」喂进来，阈值 5 必然被撞穿 ⇒
 *    **一次完全正常的评审就被判成「刷分」** ⇒ 防刷分链路因全是误报而失去意义。
 *    ⇒ 事件必须带**动作标识**（`actionId` / `requestId`，即一次提交的 request_id）：
 *      · 同一个动作标识的多行 ⇒ **只算一次**；
 *      · **没有动作标识**的事件 ⇒ **无法归并成动作** ⇒ **不计入**（宁可漏报也不误报）。
 *        ⚠️ 这不是「宽容」，而是「不猜」：把行当动作正是 F10 的病根。
 *        `unidentified` 会回报给调用方，由它显式告警（不静默）。
 *
 * ⛔ `findingKey` 是**稳定标识**（不含时间戳）：原先 detail 里嵌了 `windowStart`/`windowEnd`，
 *    而复核队列的去重按 `canonicalJson(detail)` 比较 ⇒ 同一问题在不同时间算出来**不是同一个问题**
 *    ⇒ **每次重算都新增一条 flagged_reviews 行** ⇒ 复核队列被同一个问题刷屏。
 *    ⇒ 稳定标识 = `kind|主体|窗口序号`（窗口序号 = 窗口起点按窗口长度取整）。
 */
export function detectBurstSubmission({ events = [], windowSeconds = 60, threshold = 5 }) {
  const bySubject = new Map();
  let unidentified = 0;
  for (const e of events) {
    const subject = e.subjectId ?? e.judgeId ?? 'default';
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    const actionId = e.actionId ?? e.requestId ?? null;
    if (!actionId) { unidentified += 1; continue; }
    if (!bySubject.has(subject)) bySubject.set(subject, new Map());
    const actions = bySubject.get(subject);
    // 同一动作只留**最早**的时刻（重试不产生新动作，但可能带来更晚的落库时间）
    const prev = actions.get(actionId);
    if (prev === undefined || at < prev) actions.set(actionId, at);
  }

  const flags = [];
  let maxCount = 0;
  const windowMs = windowSeconds * 1000;
  for (const [subject, actions] of bySubject) {
    const times = [...actions.values()].sort((x, y) => x - y);
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while (times[end] - times[start] > windowMs) start += 1;
      const count = end - start + 1;
      if (count > maxCount) maxCount = count;
      if (count > threshold) {
        const windowStart = times[start];
        const windowEnd = times[end];
        flags.push({
          kind: 'burst_submit',
          subjectId: subject,
          count,
          windowStart: new Date(windowStart).toISOString(),
          windowEnd: new Date(windowEnd).toISOString(),
          // 稳定标识：窗口序号按**窗口长度**取整 ⇒ 同一批数据重算得到同一个键
          findingKey: `burst_submit|${subject}|${Math.floor(windowStart / windowMs)}`,
          action: 'alert_only',
        });
        break; // 同一主体只报一次（报最早的那次爆发）
      }
    }
  }
  return { flags, maxCount, unidentified };
}

/**
 * 某评委 stddev 异常小/大 → 告警。
 * 依据：设计文档 §11.1「评委宽严异常 → 告警但不自动处罚」。
 * ⛔ 输出里带 action='alert_only'：这个边界写进数据本身，不只写在注释里。
 */
export function detectLowVariance({ scoreStats = [], threshold = { min: 0, max: Number.POSITIVE_INFINITY } }) {
  const min = typeof threshold === 'number' ? 0 : (threshold.min ?? 0);
  const max = typeof threshold === 'number' ? threshold : (threshold.max ?? Number.POSITIVE_INFINITY);
  const flags = [];

  for (const s of scoreStats) {
    const n = Number(s.n);
    const mean = Number(s.mean);
    const sumSq = Number(s.sum_sq);
    if (!Number.isFinite(n) || !Number.isFinite(mean) || !Number.isFinite(sumSq)) continue;
    const stdev = n > 1 ? Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1))) : 0;
    let direction = null;
    if (n > 1 && stdev < min) direction = 'too_low';
    else if (n > 1 && stdev > max) direction = 'too_high';
    if (!direction) continue;
    flags.push({
      kind: 'low_variance',
      judgeId: s.judgeId,
      dimension: s.dimension,
      stdev: Number(stdev.toFixed(6)),
      n,
      mean,
      direction,
      action: 'alert_only',
    });
  }
  return { flags };
}

/**
 * 同一手机号 / 同一企业注册多个账号。
 * 依据：设计文档 §11.1「⚠️ 全行业空白：没有任何一个开源项目做多账号协同投票检测」。
 */
export function detectMultiAccount({ users = [], keyFields = [] }) {
  const flags = [];
  for (const field of keyFields) {
    const groups = new Map();
    for (const u of users) {
      const raw = u?.[field];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const value = normalizeKeyValue(field, raw);
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(u.id);
    }
    for (const [value, ids] of groups) {
      const unique = [...new Set(ids)];
      if (unique.length < 2) continue;
      flags.push({
        kind: 'multi_account',
        keyField: field,
        keyValue: value,
        userIds: unique.slice().sort(),
        count: unique.length,
        action: 'alert_only',
      });
    }
  }
  return { flags };
}

// 手机号去掉分隔符与 +86 前缀；其余字段去掉首尾空白并小写
function normalizeKeyValue(field, raw) {
  const text = String(raw).trim();
  if (!text) return '';
  if (field.toLowerCase().includes('phone')) {
    let digits = text.replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2);
    return digits;
  }
  return text.toLowerCase();
}

/**
 * 同分队伍互投率过高 → 由组委会复核（R-RNK-08，S10 §0.4）。
 * ⛔ 互评来源不公示（S10 §0.3）——这份明细只进 admin 复核队列，不进任何公开接口。
 */
export function detectTiedMutualPeerRate({ peerReviews = [], results = [], threshold = 0.8 }) {
  const byRank = new Map();
  for (const r of results) {
    const rank = Number(r.rank);
    if (!Number.isFinite(rank)) continue;
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(r.teamId);
  }

  const pairs = new Set();
  for (const r of peerReviews) {
    const from = r.fromId ?? r.judgeId ?? null;
    const to = r.toId ?? r.teamId ?? null;
    if (!from || !to) continue;
    pairs.add(`${from}>${to}`);
  }

  const flags = [];
  for (const [rank, teams] of byRank) {
    if (teams.length < 2) continue;
    const tiedPairs = [];
    let mutual = 0;
    for (let i = 0; i < teams.length; i += 1) {
      for (let j = i + 1; j < teams.length; j += 1) {
        const a = teams[i];
        const b = teams[j];
        const forward = pairs.has(`${a}>${b}`);
        const backward = pairs.has(`${b}>${a}`);
        if (forward && backward) {
          mutual += 1;
          tiedPairs.push([a, b]);
        }
      }
    }
    if (mutual === 0) continue;
    // ⛔ 预审修正（P4-T4-D3）：分母必须是**同分组内的全部候选对**，不是「互投的对数」。
    //    原来写 mutual / tiedPairs.length —— tiedPairs 只装互投的对，于是分母 == 分子，
    //    rate 恒等于 1，threshold 形同虚设（阈值调到 0.99 照样报）。
    //    现在的口径：rate = 互投对数 / 同分组全部候选对数（C(n,2)）。
    const candidatePairs = (teams.length * (teams.length - 1)) / 2;
    const rate = mutual / candidatePairs;
    if (rate < threshold) continue;
    flags.push({
      kind: 'tied_mutual_peer_rate',
      rank,
      tiedPairs,
      rate: Number(rate.toFixed(4)),
      threshold,
      action: 'alert_only',
    });
  }
  return { flags };
}

/**
 * TOP10 反向抽查任务（R-JDG-16，S7 §4.1「组委会对 TOP10 作品电话回访」）。
 * 只生成任务，不代劳、不自动结案。
 *
 * ⛔ P11：从 src/services/anticheat.js **下沉到领域层**（纯函数，浏览器安全）。
 *    服务层那一份会拖进 node:sqlite ⇒ 演示站用不了 ⇒ 只能另写一份 ⇒ 形状必然漂。
 *    现在两边 import 同一个函数。
 */
export function buildReverseAuditTasks({ results = [], signoffs = [], topN = 10, instruction = '电话回访 TOP 名单，确认签字人理解与签字内容一致' }) {
  const sorted = [...results].sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, topN);
  return sorted.map((r) => ({
    teamId: r.teamId,
    rank: Number(r.rank),
    total: r.total,
    signoffs: signoffs.filter((s) => s.teamId === r.teamId),
    instruction,
    // ⛔ 检测 ≠ 处罚：反向抽查任务同样只告警、不代劳、不自动结案（把边界写进数据本身）
    action: 'alert_only',
  }));
}

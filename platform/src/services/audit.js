// src/services/audit.js — 计算快照、复算 diff、审计日志
// 依据：设计文档 §12（每次计算产出三件套）、§13（可复算）
//   R-AUD-01 每次发榜/计分可复算（周报 2026-10-12~18 §4.2 教训 6）
//   R-AUD-02 计算留输入快照（一页纸 §第 3 步 闸二 + 周报教训 5）
//   R-JDG-17 全程留档 6 个月（S7 §4.2）
// ⛔ 本阶段的核心纪律：空结果与降级必须显式暴露。
//    · 复算不一致 → diff 出现在返回值里（API 会把它带给前端），不是只写一条日志。
//    · 规则版本已变更 → warnings 里显式说明"无法严格复算"，不静默当作 identical=true。
import { scoreStage } from '../domain/scoring.js';
import { diffValues } from '../domain/diff.js';
import { insertSnapshot, getSnapshot, nextRevision } from '../db/repo/computations.js';
import { queryAuditLog } from '../db/repo/audit-log.js';
import { writeAuditLog } from '../audit/log.js';
import { can } from '../auth/permissions.js';
import { notFound } from '../errors.js';

/**
 * 记录一次计算。写 computation_snapshots（input + output + trace + rule_version）+ 写审计日志。
 * @returns {{ id: string, revision: number }}
 */
export function recordComputation({
  db, kind, editionId = null, stageId = null, teamId = null,
  ruleVersion, input, output, trace, actorId = null, now = new Date().toISOString(),
}) {
  if (!kind) throw new Error('记录计算必须给 kind');
  if (!ruleVersion) throw new Error('记录计算必须给 ruleVersion（缺规则版本 = 不可复算）');
  if (!input || typeof input !== 'object') throw new Error('记录计算必须给 input（缺输入快照 = 不可复算）');
  if (!output || typeof output !== 'object') throw new Error('记录计算必须给 output');

  // revision + 1：重算不覆盖历史，旧 revision 保留供复盘（设计文档 §11.1 事后篡改防护）
  const revision = nextRevision(db, { kind, stageId, teamId });
  const id = insertSnapshot(db, {
    kind, editionId, stageId, teamId, ruleVersion, input, output, trace, revision, now,
  });
  writeAuditLog(db, {
    actorId,
    action: 'computation.record',
    entity: 'computation',
    entityId: id,
    detail: { kind, editionId, stageId, teamId, ruleVersion, revision },
    now,
  });
  return { id, revision };
}

/**
 * 读取一份计算快照。单条不满足 → 404（不泄露记录是否存在）。
 */
export function getComputation({ db, id, viewer = null }) {
  const row = getSnapshot(db, id);
  if (!row) throw notFound(`计算快照不存在: ${id}`);
  if (viewer && !can(viewer, 'audit:read', null, db)) throw notFound(`计算快照不存在: ${id}`);
  return {
    id: row.id,
    kind: row.kind,
    ruleVersion: row.rule_version,
    input: JSON.parse(row.input_json),
    output: JSON.parse(row.output_json),
    trace: JSON.parse(row.trace_json),
    createdAt: row.created_at,
    revision: row.revision,
    editionId: row.edition_id,
    stageId: row.stage_id,
    teamId: row.team_id,
  };
}

function pickConfig(rules, input) {
  // 快照里记了 configKey（如 'scoring.final'），据此取当前规则；取不到就退回快照自带的 config
  const key = input?.configKey;
  if (key && typeof key === 'string' && key.includes('.')) {
    const [group, name] = key.split('.');
    const cfg = rules?.[group]?.[name];
    if (cfg) return cfg;
  }
  return input?.config ?? null;
}

function runEngine(engine, input, config) {
  return engine({
    config,
    judges: input?.judges ?? [],
    submissions: input?.submissions ?? [],
    enterpriseConfirmations: input?.enterpriseConfirmations ?? [],
    peerReviews: input?.peerReviews ?? [],
  });
}

/**
 * 复算 + 比对。
 * @param {object} args
 * @param {object} [args.rules]   当前规则（loadRules 的结果）。给了才会做规则版本比对。
 * @param {object} [args.liveInput] 用当前库里的数据重建的输入（"live 模式"）。不给则用快照自带的 input。
 * @param {Function} [args.engine] 纯函数引擎，默认 P2 的 scoreStage。
 * @returns {{ identical: boolean, diff: Array, warnings: Array }}
 */
export function recomputeAndDiff({
  db, id, actorId = null, now = new Date().toISOString(),
  rules = null, liveInput = null, engine = scoreStage,
}) {
  const row = getSnapshot(db, id);
  if (!row) throw notFound(`计算快照不存在: ${id}`);

  const snapshotInput = JSON.parse(row.input_json);
  const snapshotOutput = JSON.parse(row.output_json);
  const snapshotRuleVersion = row.rule_version;

  const currentConfig = rules ? pickConfig(rules, snapshotInput) : null;
  const currentRuleVersion = currentConfig?.version
    ? `${snapshotInput?.configKey ?? 'unknown'}@${currentConfig.version}`
    : null;
  const ruleVersionChanged = currentRuleVersion !== null && currentRuleVersion !== snapshotRuleVersion;

  // ① 严格重放：用快照自带的规则版本重放 —— 回答"当时的计算本身可不可复算"
  const strictResult = runEngine(engine, snapshotInput, snapshotInput.config);
  const strictDiff = diffValues(snapshotOutput, strictResult.output ?? strictResult);

  // ② 当前规则复算：用当前规则跑同一批输入 —— 回答"现在这套规则还能不能算出同样的结果"
  const baseInput = liveInput ?? snapshotInput;
  const currentResult = currentConfig
    ? runEngine(engine, baseInput, currentConfig)
    : runEngine(engine, baseInput, snapshotInput.config);
  const currentOutput = currentResult.output ?? currentResult;

  const diff = [];
  if (ruleVersionChanged) {
    diff.push({ path: 'ruleVersion', before: snapshotRuleVersion, after: currentRuleVersion });
  }
  diff.push(...diffValues(snapshotOutput, currentOutput));

  const warnings = [];
  if (ruleVersionChanged) {
    warnings.push({
      code: 'rule_version_changed',
      severity: 'warning',
      message: `规则版本已变更（快照 ${snapshotRuleVersion} → 当前 ${currentRuleVersion}），无法严格复算；差异可能来自规则变更而非数据异常`,
      snapshotRuleVersion,
      currentRuleVersion,
    });
  }
  if (strictDiff.length === 0) {
    warnings.push({
      code: 'strict_replay_identical',
      severity: 'info',
      message: '用快照自带的规则版本重放，结果与快照一致 —— 当时的计算本身可复算',
    });
  } else {
    warnings.push({
      code: 'strict_replay_failed',
      severity: 'error',
      message: '用快照自带的规则版本重放，结果与快照不一致 —— 当时的计算已不可复算（快照或数据被改动过）',
      diff: strictDiff,
    });
  }
  if (!ruleVersionChanged && diff.length > 0) {
    warnings.push({
      code: 'output_mismatch',
      severity: 'error',
      message: '同一规则版本下复算结果与快照不一致 —— 快照或原始数据被改动过',
    });
  }
  for (const w of currentResult.warnings ?? []) {
    warnings.push({ severity: 'warning', ...w });
  }

  const identical = diff.length === 0;

  writeAuditLog(db, {
    actorId,
    action: 'computation.recompute',
    entity: 'computation',
    entityId: id,
    detail: {
      identical,
      diffCount: diff.length,
      warningCodes: warnings.map((w) => w.code),
      snapshotRuleVersion,
      currentRuleVersion,
      mode: liveInput ? 'live' : 'replay',
    },
    now,
  });

  return { identical, diff, warnings };
}

/**
 * 查审计日志。列表不满足 → 200 + 空集（不暴露"有但不给看"）。
 * retention 段给出"赛后 6 个月可查"的窗口（R-JDG-17 / S7 §4.2）。
 */
export function listAuditLog({ db, filter = {}, viewer = null, rules = null, now = new Date().toISOString() }) {
  const allowed = viewer ? can(viewer, 'audit:read', null, db) : false;
  if (!allowed) return { rows: [], total: 0, retention: null };

  const { rows, total } = queryAuditLog(db, filter);
  const archiveMonths = rules?.audit?.retention?.archiveMonths ?? null;
  const retention = archiveMonths === null
    ? null
    : { archiveMonths, queryableSince: monthsAgoIso(now, archiveMonths) };

  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
      createdAt: r.created_at,
    })),
    total,
    retention,
  };
}

// 精确的"N 个月前"（不是 30 天 × N）。取不到该日时退到当月最后一天。
function monthsAgoIso(nowIso, months) {
  const d = new Date(Date.parse(nowIso));
  if (!Number.isFinite(d.getTime())) return nowIso;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

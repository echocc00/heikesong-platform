// src/domain/task-evidence.js — 任务完成证据校验（纯函数）
//   ⚠️ 刻意【不叫 evidence.js】：P4 已占用 `src/domain/evidence.js`（R-AUD-04 证据三列去重，
//      是审计概念）。这里是 R-STG-04 的任务完成证据，是另一个东西。同名不同义会让
//      后写的阶段覆盖先写的模块 —— 这正是「同一动作在两份材料里被标成一手与二手」的同构风险。
// 依据：S10 §3.1「提交内容为可运行状态或明确阻塞点，纯文字进度说明不给分」（R-STG-04）
//   + S10 §3.4 反作弊第 3 条「提交须带版本记录 + 代码仓」
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。
// ⚠️ 边界：这条规则原文是针对【赛段交付物打分】的。本阶段只用来约束
//    「任务清单的完成记录」，不产生任何分数（任务完成 ≠ 赛段交付物得分）。
export const EVIDENCE_KINDS = ['runnable', 'blocked'];

export function validateTaskEvidence(evidence, { maxSummaryLength = 500 } = {}) {
  const errors = [];
  const ev = evidence && typeof evidence === 'object' ? evidence : {};

  if (!EVIDENCE_KINDS.includes(ev.kind)) {
    errors.push({ field: 'kind', message: "kind 必须是 'runnable'（可运行）或 'blocked'（明确阻塞点）" });
  }

  const summary = typeof ev.summary === 'string' ? ev.summary.trim() : '';
  if (!summary) {
    errors.push({ field: 'summary', message: 'summary 不能为空（要说明这次提交了什么）' });
  } else if (summary.length > maxSummaryLength) {
    errors.push({ field: 'summary', message: `summary 不得超过 ${maxSummaryLength} 字` });
  }

  if (ev.kind === 'runnable') {
    const url = typeof ev.artifactUrl === 'string' ? ev.artifactUrl.trim() : '';
    if (!url) {
      errors.push({ field: 'artifactUrl', message: 'kind=runnable 必须给出可运行产物（链接或仓库地址）；纯文字进度说明不给分' });
    } else if (!isAcceptableArtifact(url)) {
      errors.push({ field: 'artifactUrl', message: 'artifactUrl 必须是 http(s) 链接或 git 仓库地址' });
    }
    const version = typeof ev.version === 'string' ? ev.version.trim() : '';
    if (!version) {
      errors.push({ field: 'version', message: 'kind=runnable 必须给出版本记录（S10 §3.4：提交须带版本记录 + 代码仓）' });
    }
  }

  if (ev.kind === 'blocked') {
    const blocker = ev.blocker && typeof ev.blocker === 'object' ? ev.blocker : {};
    const reason = typeof blocker.reason === 'string' ? blocker.reason.trim() : '';
    const needed = typeof blocker.needed === 'string' ? blocker.needed.trim() : '';
    if (!reason) errors.push({ field: 'blocker.reason', message: 'kind=blocked 必须写明阻塞点是什么' });
    if (!needed) errors.push({ field: 'blocker.needed', message: 'kind=blocked 必须写明解除阻塞需要什么' });
  }

  return { ok: errors.length === 0, errors };
}

function isAcceptableArtifact(url) {
  if (/^https?:\/\/\S+/i.test(url)) return true;
  if (/^(ssh:\/\/|git@)\S+/i.test(url)) return true;
  // 裸仓库路径：owner/repo
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url);
}

// web/views/publish.js — 赛段计算发榜页（P8 新建 · P11 补「发榜」这半个动作）
//
// 规则溯源：
//   - 「compute 是**显式动作**，发榜影响奖金，必须有明确的操作者与时间戳」→ src/services/compute.js 文件头
//   - 「不阻断发榜，但必须显式暴露」（评委池不合规 / 降级告警）→ compute.js 的终审修正 I-2
//   - 「三件套快照可复算」→ R-AUD-01（input / output / trace）
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
//   - 「TOP10 名单事后电话回访」→ S7 §4.1（R-JDG-16）
//
// ⛔ **P11 · E149：计算与发榜是两个动作，页面必须给两个按钮**
//   设计文档 §869：「`compute` 是显式动作，不自动触发。**发榜**是一个有后果的动作
//   （影响奖金），必须有明确的操作者与时间戳。」
//   ⇒ 页面此前只有**一个**「计算并发榜」按钮，点了只算不发 ⇒
//     名次积分从未发放、段位永远 D 段、榜单快照为空、发榜没有留痕（真机实测）。
//   ⇒ 现在两个动作各有各的按钮、各有的二次确认文案：
//     · 「重新计算」= 清场重算（覆盖名次/总分/积分，可逆：再算一次即可）
//     · 「发布榜单」= 写快照 / 段位记录 / 名次积分 / 发榜审计（影响奖金）
//
// ⛔ **发榜是不可逆的**（P8 DP-96）：
//   `POST /api/stages/:stageId/compute` 会**清场重算**并写 `stage_results`
//   （compute.js 的 `resetStageResults`）⇒ 名次、总分、积分全被覆盖。
//   ⇒ 必须**二次确认**，且确认文案要写明**赛段 + 影响面**（不是「确定吗？」）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyState, errorState, loadingState, noticeState, pageHead, panel,
  statRow, tableWrap,
} from '../ui.js';

/**
 * 会被当成「硬降级」的告警码。
 * ⚠️ 口径来自 compute.js 的告警语义：**影响得分口径**的才是硬降级，其余只是提示。
 *    - judge_pool_invalid：评委池不合规（规则里的席构成/下限没达标）
 *    - normalization_fallback：评委宽严归一化降级 ⇒ 分数口径变了
 *    - dimension_no_scores：某个维度**没有任何评分** ⇒ 该维度权重记 0
 *    - team_no_reviews：某支队伍**完全没人评过** ⇒ 不参与排名
 *    - R2_missing_dual_signature：企业确认缺双签 ⇒ 企业项按 0 分计
 *    - recusal_excluded：因回避剔除打分
 */
const HARD_WARNING_CODES = new Set([
  'judge_pool_invalid',
  'normalization_fallback',
  'dimension_no_scores',
  'team_no_reviews',
  'R2_missing_dual_signature',
  'recusal_excluded',
]);

/**
 * 告警分级（纯函数）。
 * ⚠️ **E184（2026-10-28）：分级标签改成人话（`【硬降级】` / `【提示】`）** ——
 *    原来把内部规则键当正文前缀打出来（`【normalization_fallback】……`）
 *    ⇒ 界面上出现了内部工作语言。分级判定本身**仍然按 code 判**
 *    （`HARD_WARNING_CODES` 是判据，不是展示物）⇒ 只是不把 code 显示出来。
 *    ⚠️ 这条纪律与 `web/views/audit.js` 的审计页口径一致（那里用的是
 *    `【硬降级】` / `【提示】`）⇒ 两处不再各说一套。
 * @param {Array<object>} warnings
 * @returns {{hard: string[], soft: string[]}}
 */
export function publishWarnings(warnings) {
  const hard = [];
  const soft = [];
  for (const w of Array.isArray(warnings) ? warnings : []) {
    const code = w?.code ?? '';
    const text = w?.message ?? String(w);
    if (HARD_WARNING_CODES.has(code)) hard.push(`【硬降级】${text}`);
    else soft.push(`【提示】${text}`);
  }
  return { hard, soft };
}

/** 指标行（纯函数）。 */
export function publishStats(board, result) {
  const progress = board?.progress ?? {};
  const total = Number(progress.total ?? 0);
  const submitted = Number(progress.submitted ?? 0);
  const teams = Array.isArray(board?.teams) ? board.teams.length : 0;
  const warns = publishWarnings(result?.warnings ?? []);
  const scored = Array.isArray(result?.teams) ? result.teams.length : null;
  return [
    {
      label: '评分完成度',
      value: total > 0 ? `${Math.round((submitted / total) * 100)}%` : '—',
      tone: total > 0 && submitted >= total ? 'success' : 'warn',
      hint: `已交 ${submitted} / 应交 ${total} 格`,
    },
    { label: '名册队伍', value: teams, tone: 'brand' },
    {
      label: '本次落榜',
      value: scored === null ? '未发榜' : scored,
      tone: scored === null ? 'neutral' : 'success',
      hint: scored === null ? '还没有执行过计算' : '参与本轮排名的队伍（没打分的队伍按「没有该维度得分」计入）',
    },
    {
      label: '告警',
      value: warns.hard.length + warns.soft.length,
      tone: warns.hard.length ? 'danger' : (warns.soft.length ? 'warn' : 'success'),
      hint: `硬降级 ${warns.hard.length} · 提示 ${warns.soft.length}`,
    },
  ];
}

/**
 * 发榜结果表（纯函数）。
 * ⚠️ `compute` 返回的 `teams` **只有 teamId**（没有队名）⇒ 用名册映射队名。
 */
export function publishResultHtml(result, boardTeams) {
  const rows = Array.isArray(result?.teams) ? result.teams : [];
  if (!rows.length) {
    return emptyState({
      title: '还没有发榜结果',
      hint: '点「重新计算」执行一次计算：引擎会按当前评分算出名次与总分，并把输入/输出/计算过程三件套存成快照。',
    });
  }
  const nameOf = (id) => {
    const hit = (boardTeams ?? []).find((t) => t.id === id);
    return hit ? hit.name : id;
  };
  const ordered = [...rows].sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return tableWrap(
    `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">P 席分</th><th class="td-num">E 席分</th><th class="td-num">总分</th></tr></thead>`
    + `<tbody>${ordered.map((r, i) => `<tr>`
      + `<td>${i + 1}</td>`
      + `<td>${escapeHtml(nameOf(r.teamId))}</td>`
      + `<td class="td-num num">${escapeHtml(round2(r.seatP))}</td>`
      + `<td class="td-num num">${escapeHtml(round2(r.seatE))}</td>`
      + `<td class="td-num num">${escapeHtml(round2(r.total))}</td>`
      + `</tr>`).join('')}</tbody>`,
    { caption: '本轮计算结果（按总分降序）' },
  );
}

/**
 * 「缺谁该打分」（纯函数）—— 数据来自 `GET /api/stages/:stageId/review-state`。
 *
 * ⛔ P11：这条读口原先**前端从不调用** ⇒ 组委会发榜时看不到「哪支队伍、哪个维度还没人打分」，
 *    只能靠猜。P9.1 的真机复验已经踩过同一个坑（`total=0` 却显示「都有打分」）。
 *
 * ⚠️ 组委会视角的 `missing` 带 `judgeId` ⇒ 按评委分组展示；普通评委视角只有自己的缺格。
 *
 * ⛔ **E184（2026-10-28）：显示中文维度名，不显示英文维度键** ——
 *    `feasibility` 是**内部标识**（与告警 `code` 同一类：内部工作语言）。
 *    ⚠️ 名字来自**同一份 review-board**（`judgeDimensions`）⇒ 与打分表里显示的名字同源，
 *    不会出现「打分表写中文、催评清单写英文」的两套口径。
 *    找不到名字时退到「未知维度」而不是键名（宁可少说，不许把内部键打给人看）。
 */
export function publishMissingHtml(reviewState, boardTeams, judgeDimensions = []) {
  const missing = Array.isArray(reviewState?.missing) ? reviewState.missing : [];
  if (!missing.length) {
    return noticeState({
      tone: 'success',
      title: '没有缺格：该打分的人都交了',
      items: ['名册里的队伍、该赛段的评委席维度都已覆盖。'],
    });
  }
  const nameOf = (id) => {
    const hit = (boardTeams ?? []).find((t) => t.id === id);
    return hit ? hit.name : id;
  };
  const dimNameOf = (key) => {
    const hit = (judgeDimensions ?? []).find((d) => d?.key === key);
    return hit?.name || '未知维度';
  };
  // 按评委分组（组委会视角才有 judgeId）
  const byJudge = new Map();
  for (const m of missing) {
    const key = m.judgeId ?? 'me';
    if (!byJudge.has(key)) byJudge.set(key, []);
    byJudge.get(key).push(m);
  }
  const items = [...byJudge.entries()].map(([judgeId, list]) => {
    const who = judgeId === 'me' ? '我' : `评委 ${judgeId}`;
    const cells = list.map((m) => `${nameOf(m.teamId)} · ${dimNameOf(m.dimension)}`);
    return `${who}：还差 ${list.length} 格 —— ${cells.join('；')}`;
  });
  return noticeState({
    tone: 'warn',
    title: `缺谁该打分（${missing.length} 格）`,
    items,
    list: true,
  });
}

/**
 * 发榜状态 + TOP 名单回访清单（纯函数）—— 数据来自 `GET /api/stages/:stageId/publish`。
 *
 * ⛔ P11：这两块此前**完全没有读口** ⇒ 页面刷新后不知道自己发过榜，
 *    也不知道 R-JDG-16 的「TOP10 事后电话回访」清单长什么样。
 */
export function publishStateHtml(publishState, boardTeams) {
  if (!publishState) return '';
  const nameOf = (id) => {
    const hit = (boardTeams ?? []).find((t) => t.id === id);
    return hit ? hit.name : id;
  };
  if (!publishState.published) {
    return noticeState({
      tone: 'warn',
      title: '这个赛段还没发榜',
      items: ['榜单快照、段位记录与名次积分都还没写 —— 奖金与段位权益因此没有依据。'],
    });
  }
  const snaps = Array.isArray(publishState.snapshots) ? publishState.snapshots : [];
  const tasks = Array.isArray(publishState.reverseAuditTasks) ? publishState.reverseAuditTasks : [];
  const head = `
    <div class="row">
      ${badge(`已发榜`, 'success')}
      ${badge(`快照 ${snaps.length} 份`, 'neutral')}
      ${badge(publishState.publishedAt ? `发榜于 ${publishState.publishedAt}` : '发榜时间未知', 'info')}
    </div>`;
  const taskBody = tasks.length
    ? tableWrap(
      `<thead><tr><th>名次</th><th>队伍</th><th class="td-num">总分</th><th>回访指令</th></tr></thead>`
      + `<tbody>${tasks.map((t) => `<tr>`
        + `<td>${escapeHtml(t.rank ?? '—')}</td>`
        + `<td>${escapeHtml(nameOf(t.teamId))}</td>`
        + `<td class="td-num num">${escapeHtml(t.total ?? '—')}</td>`
        + `<td>${escapeHtml(t.instruction ?? '')}</td>`
        + `</tr>`).join('')}</tbody>`,
      { caption: 'TOP 名单回访任务（R-JDG-16：只生成任务，不代劳、不自动结案）' },
    )
    : emptyState({ title: '暂无回访清单', hint: '发榜后这里会出现 TOP 名单（默认 10 支）供组委会电话回访。' });
  return head
    + (tasks.length
      ? `<h3 class="panel__title" style="margin-top:var(--sp-3)">TOP 名单回访</h3>${taskBody}`
      : taskBody);
}

/** 保留两位小数（分数会出现 15.200000000000003 这种浮点尾巴）。 */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

/**
 * 二次确认块（纯函数）。
 * @param {string} stageName 赛段名
 * @param {number|string} teamCount 影响几支队伍
 * @param {'compute'|'publish'} [kind] 确认的是哪个动作
 *   ⚠️ P11：两个动作的**影响面完全不同**，确认文案必须分开写 ——
 *     「重新计算」覆盖的是名次/总分/积分（再算一次即可）；
 *     「发布榜单」写的是榜单快照 / 段位记录 / 名次积分 / 发榜审计（**影响奖金**）。
 */
export function publishConfirmHtml(stageName, teamCount, kind = 'compute') {
  const isPublish = kind === 'publish';
  const title = isPublish ? '确认发布榜单？' : '确认执行发榜？';
  const text = isPublish
    ? `赛段「${escapeHtml(stageName)}」将正式发布：写榜单快照、重算段位记录、发放名次积分（影响奖金），并留下带操作者与时间戳的发榜审计。${escapeHtml(teamCount)} 支队伍进入公示。`
    : `赛段「${escapeHtml(stageName)}」会按<strong>当前评分</strong>清空旧名次并重算落榜（${escapeHtml(teamCount)} 支队伍参与排名）。这一步影响奖金与公示，且会覆盖上一次的名次、总分与积分。`;
  const confirmAction = isPublish ? 'publish-leaderboard-confirm' : 'publish-confirm';
  const requestAction = isPublish ? 'publish-leaderboard-request' : 'publish-request';
  return `
    <div class="notice notice--warn" data-publish-confirm="${escapeHtml(kind)}">
      <p class="notice__title">${title}</p>
      <p class="notice__text">${text}</p>
      <div class="btn-group">
        <button type="button" class="btn btn--primary" data-action="${confirmAction}">${isPublish ? '确认发榜' : '确认发榜'}</button>
        <button type="button" class="btn btn--ghost" data-action="publish-cancel">取消</button>
      </div>
      <p class="muted small" data-confirm-hint="${escapeHtml(kind)}">${isPublish ? '发榜后可再次发榜以更正（差额走积分更正记录）。' : '这一步只重算，不发布。'}</p>
      <span class="muted small" data-confirm-origin="${escapeHtml(requestAction)}"></span>
    </div>`;
}

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, board, result, stages, stageId, reviewState, publishState }
 */
export function publishHtml(model) {
  if (model?.loading) {
    return pageHead({ title: '赛段计算发榜' }) + loadingState({ rows: 4, label: '正在加载发榜工作台…' });
  }
  if (model?.error) {
    return pageHead({ title: '赛段计算发榜' })
      + errorState({ message: model.error, hint: '发榜需要组委会权限（stage:compute 能力点）。' });
  }
  if (!model?.board) {
    const stages = Array.isArray(model?.stages) ? model.stages : [];
    const list = stages.length
      ? `<ul class="list-divided">${stages.map((s) => `<li class="row row--between">
          <span>${escapeHtml(s.name)} <span class="muted small">${escapeHtml(s.key)}</span></span>
          <a class="btn btn--ghost btn--sm" href="#/publish/${escapeHtml(s.id)}">进入发榜</a>
        </li>`).join('')}</ul>`
      : emptyState({ title: '还没有赛段', hint: '组委会创建赛段后，这里会出现可发榜的赛段。' });
    return pageHead({ title: '赛段计算发榜', sub: '选择一个赛段执行计算与发榜。' })
      + panel({ title: '赛段', body: list });
  }

  const board = model.board;
  const result = model.result ?? null;
  const warns = publishWarnings(result?.warnings ?? []);
  const head = pageHead({
    title: `计算发榜 · ${board.stage?.name ?? ''}`,
    sub: '计算与发榜是两个独立动作：先算清、再发布。发榜影响奖金，必须有操作者与时间戳。',
    actions: [{ label: '看榜单', href: '#/leaderboard' }],
  });

  const progress = board.progress ?? {};
  const missingTeams = [...new Set((progress.missing ?? []).map((m) => m.teamId))];
  // ⛔ P9.1 修正（真机复验抓出）：「名册里的队伍都有打分」**不能**只看 `missingTeams` 是否为空。
  //    该赛段**一个评委都没派**时，`progress.total` 与 `submitted` 都是 0、missing 也是空
  //    ⇒ 旧判据会报「名册里的队伍都有打分 / 可以执行计算发榜」，
  //    而真发榜后引擎对每支队伍每个维度都产出 `dimension_no_scores` 告警（实测 30 条）。
  //    现在三个分支各自由数字决定：没有格子 ⇒ 直说「一格都没打」；有格子且有缺格 ⇒ 催评；
  //    有格子且不缺 ⇒ 才算「都有打分」。
  const submitted = Number(progress.submitted ?? 0);
  const total = Number(progress.total ?? 0);
  const checkBody = `
    <div class="row">
      ${badge(`已交 ${submitted} 格`, total > 0 && submitted >= total ? 'success' : 'warn')}
      ${badge(`应交 ${total} 格`, 'neutral')}
      ${badge(`名册 ${(board.teams ?? []).length} 支`, 'brand')}
    </div>
    ${total === 0
      ? noticeState({
        tone: 'warn',
        title: '这个赛段一格都还没打',
        items: ['还没有给赛段派评委，或一格都没交 —— 现在发榜，每支队伍的每个维度都会按「没有该维度得分」处理（引擎会逐条告警）。'],
      })
      : missingTeams.length
        ? noticeState({
          tone: 'warn',
          title: `有 ${missingTeams.length} 支队伍还缺打分`,
          items: [
            '没被评到的队伍不参与排名（引擎按「没有任何评分」处理），发榜前最好先催评。',
            ...missingTeams.map((id) => {
              const t = (board.teams ?? []).find((x) => x.id === id);
              return t ? t.name : id;
            }),
          ],
          list: true,
        })
        : noticeState({ tone: 'success', title: '名册里的队伍都有打分', items: ['可以执行计算发榜。'] })}`;

  // ⛔ P11：两个动作，各有各的按钮与各自的二次确认。
  const actionBody = `
    <div class="btn-group" data-publish-actions>
      <button type="button" class="btn btn--ghost" data-action="publish-request">重新计算</button>
      <button type="button" class="btn btn--primary" data-action="publish-leaderboard-request">发布榜单</button>
    </div>
    <p class="muted small" style="margin-top:var(--sp-3)">
      「重新计算」按当前评分清场重算并覆盖名次与总分；「发布榜单」才会写榜单快照、段位记录与名次积分（影响奖金）。
    </p>
    ${result?.computationId
      ? `<p class="muted small" style="margin-top:var(--sp-3)">
          快照 <code>${escapeHtml(result.computationId)}</code>（第 ${escapeHtml(result.revision ?? '—')} 版）
          · <a href="#/audit/${escapeHtml(result.computationId)}">查看计算留痕</a>
          · <a href="#/leaderboard/${escapeHtml(board.stage?.id ?? '')}">查看赛段榜</a>
        </p>`
      : ''}`;

  const warnBody = result
    ? (warns.hard.length || warns.soft.length
      ? noticeState({
        tone: warns.hard.length ? 'danger' : 'warn',
        title: `本轮告警（${warns.hard.length + warns.soft.length}）`,
        items: [...warns.hard, ...warns.soft],
        list: true,
      })
      : noticeState({ tone: 'success', title: '本轮没有告警', items: ['归一化生效、评委池合规、无回避剔除。'] }))
    : '';

  const missingBody = model.reviewState
    ? publishMissingHtml(model.reviewState, board.teams, board.judgeDimensions)
    : '';
  const stateBody = publishStateHtml(model.publishState, board.teams);

  return head
    + statRow(publishStats(board, result))
    + panel({ title: '发榜前检查', desc: '这些结论都来自 API，前端不自己判定。', body: checkBody })
    + (missingBody ? panel({ title: '缺谁该打分', desc: '按评委分组列出还没交的格子（来自评审进度读口）。', body: missingBody }) : '')
    + panel({ title: '发榜操作', desc: '影响奖金的操作需要二次确认。', body: actionBody })
    + (stateBody ? panel({ title: '发榜状态', desc: '发过榜没有、发了什么、TOP 名单回访清单。', body: stateBody }) : '')
    + (warnBody ? panel({ title: '告警', body: warnBody }) : '')
    + panel({ title: '本轮结果', desc: '按总分降序；名次在发榜后同时进入赛段榜与滚动总榜。', body: publishResultHtml(result, board.teams) });
}

// ══════════════════════════════════════════════════════════════════
// 挂载
// ══════════════════════════════════════════════════════════════════

/**
 * 赛段计算发榜页。
 *
 * ⚠️ **二次确认是内联的**（不是 `window.confirm`）：
 *   原生弹窗在生产环境不可控（样式不可控、无法承载「影响面」说明、自动化测试也测不了）。
 *   ⇒ 点按钮先把按钮换成一个**说明影响面的确认块**，再点确认才发请求。
 */
export async function renderPublish(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'publish-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';
  let result = null;
  let reviewState = null;
  let publishState = null;

  const load = async () => {
    if (!stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = publishHtml({ stages: Array.isArray(stages) ? stages : (stages?.items ?? []) });
      return;
    }
    wrap.innerHTML = publishHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
      // ⚠️ 这两个读口是**辅助信息**：拉不到不能连累整页（权限不足 / 端点不可用时仍要能看主面板）。
      reviewState = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-state`).catch(() => null);
      publishState = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/publish`).catch(() => null);
      wrap.innerHTML = publishHtml({ board, result, reviewState, publishState });
    } catch (e) {
      wrap.innerHTML = publishHtml({ error: e.message });
    }
  };

  await load();

  wrap.addEventListener('click', async (ev) => {
    const action = ev.target?.closest?.('[data-action]')?.dataset?.action;
    if (!action) return;
    const actionsBox = wrap.querySelector('[data-publish-actions]');

    if (action === 'publish-request' || action === 'publish-leaderboard-request') {
      // 先拉一次名册，把「影响面」写进确认文案
      let teamCount = 0;
      let stageName = '';
      try {
        const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
        teamCount = (board.teams ?? []).length;
        stageName = board.stage?.name ?? '';
      } catch {
        // 拉不到就照常给确认框（真正提交时还会再失败一次）
      }
      const kind = action === 'publish-leaderboard-request' ? 'publish' : 'compute';
      if (actionsBox) actionsBox.outerHTML = publishConfirmHtml(stageName, teamCount, kind);
      return;
    }
    if (action === 'publish-cancel') {
      await load();
      return;
    }
    if (action === 'publish-confirm' || action === 'publish-leaderboard-confirm') {
      const box = wrap.querySelector('[data-publish-confirm]');
      const isPublish = action === 'publish-leaderboard-confirm';
      if (box) box.innerHTML = loadingState({ rows: 1, label: isPublish ? '正在发布榜单…' : '正在计算…' });
      try {
        if (isPublish) {
          // ⛔ 发榜是**独立**的动作：写快照 / 段位记录 / 名次积分 / 发榜审计
          await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/publish`, {});
        } else {
          result = await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/compute`, {});
        }
        await load();
      } catch (e) {
        const box2 = wrap.querySelector('[data-publish-confirm]');
        if (box2) box2.innerHTML = errorState({ message: e.message });
      }
    }
  });

  return wrap;
}

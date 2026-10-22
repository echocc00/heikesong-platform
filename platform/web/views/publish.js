// web/views/publish.js — 赛段计算发榜页（P8 新建）
//
// 规则溯源：
//   - 「compute 是**显式动作**，发榜影响奖金，必须有明确的操作者与时间戳」→ src/services/compute.js 文件头
//   - 「不阻断发榜，但必须显式暴露」（评委池不合规 / 降级告警）→ compute.js 的终审修正 I-2
//   - 「三件套快照可复算」→ R-AUD-01（input / output / trace）
//   - 「前端不按角色拦路由，授权归 API」→ 全局约束（DP-77）
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
 * @param {Array<object>} warnings
 * @returns {{hard: string[], soft: string[]}}
 */
export function publishWarnings(warnings) {
  const hard = [];
  const soft = [];
  for (const w of Array.isArray(warnings) ? warnings : []) {
    const code = w?.code ?? '';
    const text = w?.message ?? String(w);
    if (HARD_WARNING_CODES.has(code)) hard.push(`【${code}】${text}`);
    else soft.push(`【${code || '提示'}】${text}`);
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
      hint: '点「计算并发榜」执行一次计算：引擎会按当前评分算出名次与总分，并把输入/输出/计算过程三件套存成快照。',
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

/** 保留两位小数（分数会出现 15.200000000000003 这种浮点尾巴）。 */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

/** 二次确认块（纯函数）。 */
export function publishConfirmHtml(stageName, teamCount) {
  return `
    <div class="notice notice--warn" data-publish-confirm>
      <p class="notice__title">确认执行发榜？</p>
      <p class="notice__text">
        赛段「${escapeHtml(stageName)}」会按**当前评分**清空旧名次并重算落榜（${escapeHtml(teamCount)} 支队伍参与排名）。
        这一步影响奖金与公示，且会覆盖上一次的名次、总分与积分。
      </p>
      <div class="btn-group">
        <button type="button" class="btn btn--primary" data-action="publish-confirm">确认发榜</button>
        <button type="button" class="btn btn--ghost" data-action="publish-cancel">取消</button>
      </div>
    </div>`;
}

/**
 * 整页渲染（纯函数，可单测）。
 * @param {object} model { loading, error, board, result, stages, stageId }
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
    sub: '发榜是显式动作：会按当前评分重算并落榜，计算过程留三件套快照可复算。',
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

  const actionBody = `
    <div class="btn-group" data-publish-actions>
      <button type="button" class="btn btn--primary" data-action="publish-request">计算并发榜</button>
    </div>
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

  return head
    + statRow(publishStats(board, result))
    + panel({ title: '发榜前检查', desc: '这些结论都来自 API，前端不自己判定。', body: checkBody })
    + panel({ title: '发榜操作', desc: '影响奖金的操作需要二次确认。', body: actionBody })
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
 *   ⇒ 点「计算并发榜」先把按钮换成一个**说明影响面的确认块**，再点「确认发榜」才发请求。
 */
export async function renderPublish(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'publish-view';
  const stageId = ctx.params?.stageId ?? ctx.query?.stageId ?? '';
  let result = null;

  const load = async () => {
    if (!stageId) {
      const stages = await ctx.api.get('/api/stages').catch(() => []);
      wrap.innerHTML = publishHtml({ stages: Array.isArray(stages) ? stages : (stages?.items ?? []) });
      return;
    }
    wrap.innerHTML = publishHtml({ loading: true });
    try {
      const board = await ctx.api.get(`/api/stages/${encodeURIComponent(stageId)}/review-board`);
      wrap.innerHTML = publishHtml({ board, result });
    } catch (e) {
      wrap.innerHTML = publishHtml({ error: e.message });
    }
  };

  await load();

  wrap.addEventListener('click', async (ev) => {
    const action = ev.target?.closest?.('[data-action]')?.dataset?.action;
    if (!action) return;
    const actionsBox = wrap.querySelector('[data-publish-actions]');

    if (action === 'publish-request') {
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
      if (actionsBox) actionsBox.outerHTML = publishConfirmHtml(stageName, teamCount);
      return;
    }
    if (action === 'publish-cancel') {
      await load();
      return;
    }
    if (action === 'publish-confirm') {
      const confirmBox = wrap.querySelector('[data-publish-confirm]');
      if (confirmBox) confirmBox.innerHTML = loadingState({ rows: 1, label: '正在计算并发榜…' });
      try {
        result = await ctx.api.post(`/api/stages/${encodeURIComponent(stageId)}/compute`, {});
        await load();
      } catch (e) {
        const box = wrap.querySelector('[data-publish-confirm]');
        if (box) box.innerHTML = errorState({ message: e.message });
      }
    }
  });

  return wrap;
}

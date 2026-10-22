// web/views/team.js — 我的战队（选手视角）
// 依据：设计文档 §9「我的战队 + 组队/汰换」
// 依据：R-REG-01（建队即认领任务包）、R-REG-03（持续招募汰换）、R-REG-04（仅剩 1 人须并队）
//
// 本轮（P7）「现有页面打磨到生产级」的改动要点：
//   ① 战队卡片用 .team-card + badge 标状态（组建中 / 已成立 / 须并队 / 已解散，四种色调）；
//   ② 成员列表从裸 <ul> 改成紧凑表格，组长用 badge('组长','brand') 标出；
//   ③ 成员数 / 里程碑数提到 statCard（信息密度）；
//   ④ needsMerge 用 noticeState(danger) 醒目提示并写清并队截止时间；
//   ⑤ 退出按钮按 canLeaveTeam 决定 disabled，并把「为什么不能退」写在按钮上；
//   ⑥ 组队表单走 .field / .input / .select 体系，**空队名本地拦下**（不发无谓请求）；
//   ⑦ 建队 / 退出后**就地刷新列表**，不再 location.reload()（整页刷新会冲掉用户输入）。
import { escapeHtml } from '../escape.js';
import {
  badge, emptyRow, emptyState, errorState, loadingState, noticeState,
  pageHead, panel, statRow, tableWrap,
} from '../ui.js';

const STATUS_LABELS = {
  forming: '组建中（未满 2 人）',
  active: '已成立',
  needs_merge: '仅剩 1 人，须并队',
  dissolved: '已解散',
};

/** 卡片上的状态徽章：短标签 + 色调（四种状态四种色调，扫一眼就知道战队处于什么阶段）。 */
const STATUS_BADGES = {
  forming: { label: '组建中', tone: 'info' },
  active: { label: '已成立', tone: 'success' },
  needs_merge: { label: '须并队', tone: 'danger' },
  dissolved: { label: '已解散', tone: 'neutral' },
};

// 组长是谁：优先看成员表里的 role=captain，退回 team.captainId
function resolveCaptainId(team) {
  const members = team?.members ?? [];
  const captain = members.find((m) => m.role === 'captain');
  return captain?.userId ?? team?.captainId ?? '';
}

export function summarizeTeam(team) {
  const members = team?.members ?? [];
  return {
    id: team?.id ?? null,
    title: team?.name ?? '',
    memberCount: members.length,
    status: team?.status ?? 'forming',
    statusLabel: STATUS_LABELS[team?.status] ?? team?.status ?? '',
    captainId: resolveCaptainId(team),
    needsMerge: team?.needsMerge === true,
    mergeDeadline: team?.mergeDeadline ?? null,
    formationOk: team?.formation?.ok === true,
    formationErrors: team?.formation?.errors ?? [],
    milestoneCount: team?.milestones?.items?.length ?? 0,
  };
}

/**
 * 「退出」按钮能不能点：**本人是组员、且不是组长**。
 *
 * ⚠️ P1 Task 6 修正（Important，退出功能完全不可用）：
 *    原来的判定是 `captainId === 当前用户 ? 可点 : 禁用` —— 条件**取反**了：
 *      · 组长可点 → 但服务端 `leaveTeam` 对组长抛 409 `CAPTAIN_MUST_REPLACE`
 *        （组长要移交职责，不能直接退）→ 点了必然报错；
 *      · 组员被禁用 → 明明可以退，却点不动。
 *    结果：**两个角色都退不了队**，整条「持续招募汰换（R-REG-03）」的退出路径在 UI 上是死的。
 *    现在按服务端规则对齐：**组员可退，组长不可退**（移交走汰换接口）。
 */
export function canLeaveTeam(team, viewerId) {
  if (!team || !viewerId) return false;
  if (resolveCaptainId(team) === viewerId) return false;
  return (team?.members ?? []).some((m) => m.userId === viewerId);
}

/** 并队截止时间：能解析就显示本地时间，解析不了就原样显示（不吞数据）。 */
export function formatDeadline(value) {
  if (!value) return '（服务端未给出截止时间）';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 战队卡片 HTML（纯函数，不碰 document）。
 *
 * ⚠️ 为什么抽出来：`renderTeam` 里内联模板时，「退出按钮能不能点」这条**渲染路径**
 *    完全没有测试覆盖 —— canLeaveTeam 本身测对了，但调用点写错也没人知道
 *    （父代理变异检验实测：把 `canLeaveTeam(t, viewerId)` 换成老写法
 *     `s.captainId === viewerId`，变异体**存活** —— 说明调用点是盲区）。
 *    抽成纯函数后，这条路径能被直接断言。
 *
 * ⛔ 两条硬约束（测试直接断言渲染结果）：
 *    ① 不许出现 data-user —— 服务端只认发起人自己，不接受 body.userId；
 *    ② 组员视角的 HTML 里不许出现 disabled —— 组员**必须**能点退出。
 */
export function buildTeamCards(teams, viewerId) {
  return (teams ?? []).map((t) => {
    const s = summarizeTeam(t);
    const leaveable = canLeaveTeam(t, viewerId);
    const isCaptain = Boolean(viewerId) && s.captainId === viewerId;
    const badgeInfo = STATUS_BADGES[s.status] ?? { label: s.status, tone: 'neutral' };
    const hint = leaveable
      ? '退出后若队内仅剩 1 人将触发并队（R-REG-04）；进出记录留档（R-REG-03），可重新组队。'
      : (isCaptain
        ? '组长不能直接退出：需先汰换成员并移交组长职责，否则服务端返回 409 CAPTAIN_MUST_REPLACE。'
        : '你不是该战队成员，无法退出别人的战队。');
    const members = t.members ?? [];
    const memberRows = members.length
      ? members.map((m) => `
            <tr>
              <td>${escapeHtml(m.userId)}</td>
              <td>${m.role === 'captain' ? badge('组长', 'brand') : badge('组员', 'neutral')}</td>
              <td class="muted small">${escapeHtml(m.joinedAt ?? '—')}</td>
            </tr>`).join('')
      : emptyRow(3, '暂无成员');
    return `
        <section class="team-card" data-team="${escapeHtml(s.id)}">
          <div class="row row--between">
            <h2 class="panel__title">${escapeHtml(s.title)}</h2>
            <div class="btn-group">${badge(badgeInfo.label, badgeInfo.tone)}</div>
          </div>
          <p class="muted small">状态：${escapeHtml(s.statusLabel)}</p>
          ${s.needsMerge ? noticeState({
            tone: 'danger',
            title: '须并队：队内仅剩 1 人',
            items: [`请在 ${formatDeadline(s.mergeDeadline)} 前并入其他战队，逾期将无法继续参赛（R-REG-04）。`],
          }) : ''}
          ${s.formationErrors.length ? noticeState({
            tone: 'warn',
            title: '组队校验未通过',
            items: s.formationErrors,
            list: true,
          }) : ''}
          ${statRow([
            { label: '成员', value: s.memberCount, hint: isCaptain ? '你是本队组长' : '' },
            { label: '固定里程碑', value: s.milestoneCount, hint: '报名时固定，赛程中不可自行新增（R-STG-03）' },
            { label: '你的角色', value: isCaptain ? '组长' : (leaveable ? '组员' : '非成员') },
          ])}
          ${tableWrap(`
            <thead><tr><th>成员</th><th>角色</th><th>加入时间</th></tr></thead>
            <tbody>${memberRows}</tbody>`)}
          <div class="btn-group">
            <button type="button" class="btn btn--ghost btn--sm" data-action="leave" data-team="${escapeHtml(s.id)}"${leaveable ? '' : ' disabled'} title="${escapeHtml(hint)}">${leaveable ? '退出战队' : (isCaptain ? '组长不可退' : '非成员不可退')}</button>
          </div>
          <p class="muted small">${escapeHtml(hint)}</p>
        </section>`;
  });
}

/** 战队列表区（纯函数）：空数据时给「下一步做什么」。 */
export function buildTeamList(teams, viewerId) {
  if (!(teams ?? []).length) {
    return emptyState({
      title: '你还没有战队',
      hint: '在下方认领一个任务包并建队 —— 报名是组队的前提（R-REG-01），建队后你自动成为组长。',
    });
  }
  return `<div class="stack">${buildTeamCards(teams, viewerId).join('')}</div>`;
}

export function renderTeam(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'team';
  const { api } = ctx;

  wrap.innerHTML = `
    ${pageHead({
      title: '我的战队',
      sub: '查看你参与的战队、认领任务包并组队；组长需先移交职责才能退出（R-REG-03）。',
    })}
    <div id="team-body">${loadingState({ rows: 3, label: '正在加载我的战队…' })}</div>`;

  const body = wrap.querySelector('#team-body');
  const viewerId = ctx.getState().user?.id ?? null;
  let criteria = null;

  /** 只刷新「战队列表」这一块：建队 / 退出后不必重载整页（也就不用 location.reload()）。 */
  async function refreshTeams() {
    const listBox = body.querySelector('#team-list');
    if (!listBox) return;
    const res = await api.get('/api/teams');
    const teams = res?.items ?? res?.rows ?? [];
    listBox.innerHTML = buildTeamList(teams, viewerId);
    bindLeaveButtons();
  }

  /** 加载页面：问卷 + 战队 + 任务包一起取。 */
  async function load() {
    body.innerHTML = loadingState({ rows: 3, label: '正在加载我的战队…' });
    try {
      const [crit, teamsRes, packagesRes] = await Promise.all([
        api.get('/api/registration-criteria'),
        api.get('/api/teams'),
        api.get('/api/task-packages'),
      ]);
      criteria = crit;
      const teams = teamsRes?.items ?? teamsRes?.rows ?? [];
      const packages = packagesRes?.items ?? packagesRes?.rows ?? [];
      render(teams, packages);
    } catch (e) {
      body.innerHTML = errorState({
        message: '我的战队加载失败',
        hint: '接口返回：' + e.message + '。点「重试」重新加载；若持续失败，请确认服务端已启动且你已登录。',
      });
      body.querySelector('[data-action="retry"]')?.addEventListener('click', load);
    }
  }

  function render(teams, packages) {
    const opts = packages
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)}</option>`)
      .join('');
    body.innerHTML = `
      <div class="stack">
        <div id="team-list-feedback"></div>
        <div id="team-list">${buildTeamList(teams, viewerId)}</div>
        ${panel({
          title: '组队（报名即认领任务包）',
          desc: '认领的任务包必须已完成六维可解性分级（R-REG-01）；建队后你是组长。',
          body: `
            <div class="field field--required">
              <label class="field__label" for="team-name">队名</label>
              <input class="input" id="team-name" name="team-name" maxlength="40" placeholder="例：甲队" />
              <p class="field__hint">队名会展示给组委会与对手，请勿填写敏感信息。</p>
              <p class="field__error" data-role="name-error" hidden></p>
            </div>
            <div class="field">
              <label class="field__label" for="team-package">认领任务包</label>
              <select class="select" id="team-package" name="package">${opts}</select>
              <p class="field__hint">${packages.length
                ? '认领后不可自行更换（R-REG-01）。'
                : '当前没有可认领的任务包 —— 请等组委会发布任务卡后再建队。'}</p>
            </div>
            <div class="btn-group">
              <button type="button" class="btn btn--primary" id="create-team"${packages.length ? '' : ' disabled'}>建队</button>
            </div>
            <div id="team-feedback"></div>`,
        })}
      </div>`;

    bindCreateButton(packages.length > 0);
    bindLeaveButtons();
  }

  /** 建队：空队名**本地拦下**（不发请求），成功后就地刷新列表。 */
  function bindCreateButton(enabled) {
    const btn = body.querySelector('#create-team');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const nameInput = body.querySelector('[name="team-name"]');
      const nameErr = body.querySelector('[data-role="name-error"]');
      const feedback = body.querySelector('#team-feedback');
      nameErr.hidden = true;
      nameErr.textContent = '';
      feedback.innerHTML = '';

      const name = nameInput.value.trim();
      if (!name) {
        // ⛔ 空队名本地拦下：发过去也是被服务端拒，没必要打一次网络。
        nameErr.textContent = '队名不能为空：请先给战队起一个名字。';
        nameErr.hidden = false;
        nameInput.focus();
        return;
      }
      const pkg = body.querySelector('[name="package"]');
      if (!pkg || !pkg.value) {
        feedback.innerHTML = errorState({
          message: '建队失败',
          hint: '没有可认领的任务包：请等组委会发布任务卡后再建队（R-REG-01）。',
          retry: false,
        });
        return;
      }

      btn.disabled = true;
      btn.textContent = '建队中…';
      try {
        await api.post('/api/teams', {
          editionId: criteria?.editionId,
          name,
          taskPackageId: pkg.value,
        });
        nameInput.value = '';
        feedback.innerHTML = noticeState({
          tone: 'success',
          title: '建队成功',
          items: ['你已成为本队组长：可以招募组员，也可以在成员卡里管理退出与汰换。'],
        });
        await refreshTeams();
      } catch (e) {
        feedback.innerHTML = errorState({
          message: '建队失败',
          hint: '服务端返回：' + e.message + '。若是「没有建队的权限」或「任务包未分级」，请先完成报名或等组委会完成任务卡分级。',
        });
        // 重试 = 用**当前输入**再发一次（队名还在输入框里）。
        feedback.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
          feedback.innerHTML = '';
          btn.click();
        });
      } finally {
        btn.disabled = !enabled;
        btn.textContent = '建队';
      }
    });
  }

  /** 退出：组员可退，组长 / 非成员由 canLeaveTeam 判定为 disabled（服务端会 409）。 */
  function bindLeaveButtons() {
    for (const btn of body.querySelectorAll('[data-action="leave"]')) {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const teamId = btn.dataset.team;
        const feedback = body.querySelector('#team-list-feedback');
        btn.disabled = true;
        btn.textContent = '退出中…';
        try {
          // ⚠️ 父代理预审修正：退出**只作用于发起人自己** ——
          //    服务端不再接受 body.userId（否则任何人都能把别人踢出战队）。
          await api.post(`/api/teams/${encodeURIComponent(teamId)}/members`, { action: 'leave' });
          if (feedback) {
            feedback.innerHTML = noticeState({
              tone: 'success',
              title: '已退出战队',
              items: ['退出记录已留档（R-REG-03）；若队内仅剩 1 人，本队将进入并队观察期（R-REG-04）。'],
            });
          }
          await refreshTeams();
        } catch (e) {
          if (feedback) {
            feedback.innerHTML = errorState({
              message: '退出失败',
              hint: '服务端返回：' + e.message + '。若提示 CAPTAIN_MUST_REPLACE，说明你是组长：需先汰换成员并移交组长职责。',
            });
            feedback.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
              feedback.innerHTML = '';
              btn.click();
            });
          }
          btn.disabled = false;
          btn.textContent = '退出战队';
        }
      });
    }
  }

  load();
  return wrap;
}

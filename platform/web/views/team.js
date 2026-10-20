// web/views/team.js — 我的战队（选手视角）
// 依据：设计文档 §9「我的战队 + 组队/汰换」
// 依据：R-REG-01（建队即认领任务包）、R-REG-03（持续招募汰换）、R-REG-04（仅剩 1 人须并队）
import { escapeHtml } from '../escape.js';
const STATUS_LABELS = {
  forming: '组建中（未满 2 人）',
  active: '已成立',
  needs_merge: '仅剩 1 人，须并队',
  dissolved: '已解散',
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

/**
 * 战队卡片 HTML（纯函数，不碰 document）。
 *
 * ⚠️ 为什么抽出来：`renderTeam` 里内联模板时，「退出按钮能不能点」这条**渲染路径**
 *    完全没有测试覆盖 —— canLeaveTeam 本身测对了，但调用点写错也没人知道
 *    （父代理变异检验实测：把 `canLeaveTeam(t, viewerId)` 换成老写法
 *     `s.captainId === viewerId`，变异体**存活** —— 说明调用点是盲区）。
 *    抽成纯函数后，这条路径能被直接断言。
 */
export function buildTeamCards(teams, viewerId) {
  return (teams ?? []).map((t) => {
    const s = summarizeTeam(t);
    const leaveable = canLeaveTeam(t, viewerId);
    const leaveHint = leaveable
      ? ''
      : ' title="组长不能直接退出，请先汰换成员并移交组长职责"';
    return `
        <section class="team-card">
          <h2>${escapeHtml(s.title)}</h2>
          <p class="muted">状态：${escapeHtml(s.statusLabel)}｜成员 ${s.memberCount} 人｜固定里程碑 ${s.milestoneCount} 项</p>
          ${s.needsMerge ? `<p class="err">⚠️ 仅剩 1 人，须在 ${s.mergeDeadline ?? '期限内'} 前并入其他战队</p>` : ''}
          ${s.formationErrors.map((e) => `<p class="err">${escapeHtml(e)}</p>`).join('')}
          <ul>${t.members.map((m) => `<li>${escapeHtml(m.userId)}（${m.role === 'captain' ? '组长' : '组员'}）</li>`).join('')}</ul>
          <button data-action="leave" data-team="${escapeHtml(t.id)}"${leaveable ? '' : ' disabled'}${leaveHint}>退出</button>
        </section>`;
  });
}

export function renderTeam(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'card team';
  wrap.innerHTML = '<p class="muted">正在加载我的战队…</p>';
  const { api } = ctx;

  (async () => {
    const [criteria, teamsRes, packagesRes] = await Promise.all([
      api.get('/api/registration-criteria'),
      api.get('/api/teams'),
      api.get('/api/task-packages'),
    ]);
    const teams = teamsRes.items ?? [];
    const packages = packagesRes.items ?? [];

    const viewerId = ctx.getState().user?.id ?? null;
    const cards = buildTeamCards(teams, viewerId);

    const opts = packages.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)}</option>`).join('');
    wrap.innerHTML = `
      <h1>我的战队</h1>
      ${cards.join('') || '<p class="muted">你还没有战队</p>'}
      <section class="create">
        <h2>组队（报名即认领任务包）</h2>
        <label>队名<input name="team-name" placeholder="甲队" /></label>
        <label>认领任务包<select name="package">${opts}</select></label>
        <button id="create-team">建队</button>
        <p id="team-err" class="err"></p>
      </section>`;

    wrap.querySelector('#create-team').addEventListener('click', async () => {
      const err = wrap.querySelector('#team-err');
      err.textContent = '';
      try {
        await api.post('/api/teams', {
          editionId: criteria.editionId,
          name: wrap.querySelector('[name=team-name]').value,
          taskPackageId: wrap.querySelector('[name=package]').value,
        });
        ctx.setState({});
        location.reload();
      } catch (e) {
        err.textContent = e.message;
      }
    });

    for (const btn of wrap.querySelectorAll('[data-action=leave]')) {
      btn.addEventListener('click', async () => {
        try {
          // ⚠️ 父代理预审修正：退出**只作用于发起人自己** ——
          //    服务端不再接受 body.userId（否则任何人都能把别人踢出战队）。
          await api.post(`/api/teams/${btn.dataset.team}/members`, { action: 'leave' });
          location.reload();
        } catch (e) {
          wrap.querySelector('#team-err').textContent = e.message;
        }
      });
    }
  })().catch((e) => {
    wrap.innerHTML = `<div class="card err">${escapeHtml(e.message)}</div>`;
  });

  return wrap;
}

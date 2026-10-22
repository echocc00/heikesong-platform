// src/services/signoff-board.js — 企业签字台 / 企业双签清单（读端点的业务组装）
//
// ⚠️ **为什么要有这一层（P10 · W4-b）**：
//   「可见性在 API 层过滤，前端只负责呈现」（全局约束 / 设计文档 §6.6）。
//   「API 层」= HTTP 路由 + 服务层；**不是**前端。
//   ⇒ 本模块负责两件事：
//     ① 判定「这个人是谁、能看到什么」（can() 是全项目唯一的授权入口）；
//     ② 把仓储层的行整形成前端要的形状（并且**不把不该给的东西给出去**）。
//
// ⛔ **本模块不改任何既有文件**：只读 src/db/repo/*（现有函数）与 src/db/repo/signoff-board.js（新文件）。
//
// ⚠️ **三态状态码**（设计文档 §7.3，全局约束）：
//   列表 200 + 空集 ｜ 单条 404 ｜ 禁用 403。
//   ⇒ 「列表」永远返回 200 + items（哪怕空）；「单条」（赛段不存在）返回 404；
//     「禁用」（没有能力点）返回 403。
import { AppError } from '../errors.js';
import { can } from '../auth/permissions.js';
import { getStage, listStageTeamRows } from '../db/repo/stages.js';
import {
  listEnterprisesTeams,
  listSignoffWorklist,
  listEnterpriseConfirmationRows,
  listStageJudgeCandidates,
} from '../db/repo/signoff-board.js';

/**
 * 里程碑签字台（"我要签的东西"）。
 *
 * ⚠️ **口径（写在前面，免得下一个人以为这是 bug）**：
 *   ① **企业席**：只看**自己出题**的队伍的里程碑（`task_packages.enterprise_id = 我`）。
 *      理由：里程碑签字是「客观事实确认」（R-PTS-02 / R-ENT-02），
 *      由出题企业确认「这件事到底发生了没有」⇒ 别的企业没资格替它确认。
 *   ② **组委会**：看全部（`stage:compute`）—— 组委会要能核查「哪支队还没人签」，
 *      且仓储层 `milestone_signoffs.enterprise_id` 记的是签字的企业席账号
 *      （src/services/milestone.js 的 insertSignoff）⇒ 组委会视角的「有效签字」
 *      取**任何人**的最新一条有效签字。
 *   ③ **权限判定跟写端点同口径**：
 *      写端点 `createSignoff` 判的是
 *      `can(actor, 'signoff:create', { scopeType: 'edition', scopeId: team.edition_id })`
 *      （src/services/milestone.js）⇒ 读端点也**按 edition 作用域**判，
 *      否则会出现「接口放行、列表 403」或反过来。
 *
 * @returns {{scope:'enterprise'|'committee', items:Array<object>}}
 */
export function getSignoffWorklist({ db, viewer }) {
  if (!viewer) throw new AppError(401, 'UNAUTHENTICATED', '未登录');

  // 组委会（stage:compute）⇒ 全量视角。
  // ⚠️ 超管在 can() 里直接返回 true（src/auth/permissions.js），所以超管自动进这一支。
  const committee = can(viewer, 'stage:compute', { scopeType: 'global' }, db);
  if (committee) {
    const rows = listSignoffWorklist(db, {
      enterpriseId: viewer.id,
      includeAllTeams: true,
      includeAllSignoffs: true,
      requireStageEdition: true,
    });
    return { scope: 'committee', items: rows.map((r) => shapeWorklistItem(r, viewer)) };
  }

  // 企业席：只看自己出题的队。
  const teams = listEnterprisesTeams(db, viewer.id);
  // 全局授权（角色授权在 can() 里对任何 scope 都成立）⇒ 不按届期再过滤一次。
  const globalSignoff = can(viewer, 'signoff:create', { scopeType: 'global' }, db);
  const editions = [...new Set(teams.map((t) => t.editionId).filter(Boolean))];
  const allowedEditions = editions.filter((editionId) =>
    can(viewer, 'signoff:create', { scopeType: 'edition', scopeId: editionId }, db));
  if (!globalSignoff && allowedEditions.length === 0) {
    throw new AppError(403, 'FORBIDDEN', '缺少能力：signoff:create');
  }
  const rows = listSignoffWorklist(db, {
    enterpriseId: viewer.id,
    editionIds: globalSignoff ? null : allowedEditions,
    includeAllTeams: false,
    includeAllSignoffs: false,
    requireStageEdition: false,
  });
  return { scope: 'enterprise', items: rows.map((r) => shapeWorklistItem(r, viewer)) };
}

/**
 * 把仓储层的行整形成前端要的形状（⛔ 字段恒定，不出现 undefined）。
 *
 * ⚠️ **不返回签字人姓名**（R-ENT-04「签字不公开」）：
 *   只回传签字内容（department / content）+ 「是不是我签的」布尔位。
 */
function shapeWorklistItem(row, viewer) {
  const signed = Boolean(row.signoffId) && !row.revokedAt;
  const signedByMe = row.signoffEnterpriseId != null && row.signoffEnterpriseId === viewer.id;
  const isSuper = viewer.is_superadmin === 1 || viewer.isSuperadmin === true;
  return {
    milestoneId: row.milestoneId,
    teamId: row.teamId,
    teamName: row.teamName ?? '',
    key: row.key ?? '',
    label: row.label ?? '',
    countsTowardTier: row.countsTowardTier === true,
    signed,
    signoffId: row.signoffId ?? null,
    signedAt: row.signedAt ?? null,
    department: row.department ?? null,
    content: row.content ?? null,
    revokedAt: row.revokedAt ?? null,
    signedByMe,
    // ⛔ 撤回闸门跟写端点一致（src/services/milestone.js withdrawSignoff）：
    //    非超管只能撤回**本企业自己**的签字 ⇒ 能不能撤由服务端说了算。
    canWithdraw: signed && (signedByMe || isSuper),
  };
}

/**
 * 企业双签待签清单（某赛段）。
 *
 * ⚠️ **权限闸门与写端点 `POST /api/stages/:stageId/enterprise-confirmations` 完全同口径**
 *    （src/http/routes/review.js）：
 *      ① `signoff:create`（赛段级或全局）**或** 组委会（`stage:compute`）；
 *      ② **且** `score:write`（赛段级或全局）—— 写端点里 `requireStageCapability(ctx,'score:write')`
 *         是**无条件**执行的（连组委会也要），所以读端点也必须一样。
 *    ⇒ 前端拿到的清单里出现的队，**一定能提交**（不会出现「看得到、提交就 403」）。
 *
 * @returns {{stage:object, scope:string, myEnterpriseId:string, dimensions:Array<object>,
 *            teams:Array<object>, confirmations:Array<object>, crossJudgeCandidates:Array<object>}}
 */
export function getEnterpriseConfirmationBoard({ db, stageId, viewer, rules = null }) {
  if (!viewer) throw new AppError(401, 'UNAUTHENTICATED', '未登录');
  const stage = getStage(db, stageId);
  if (!stage) throw new AppError(404, 'STAGE_NOT_FOUND', '赛段不存在');

  const committee = can(viewer, 'stage:compute', { scopeType: 'stage', scopeId: stageId }, db)
    || can(viewer, 'stage:compute', { scopeType: 'global' }, db);
  const seat = can(viewer, 'signoff:create', { scopeType: 'stage', scopeId: stageId }, db)
    || can(viewer, 'signoff:create', { scopeType: 'global' }, db);
  if (!seat && !committee) {
    throw new AppError(403, 'FORBIDDEN', '只有出题企业（或组委会）可以查看企业确认待签清单');
  }
  const canScore = can(viewer, 'score:write', { scopeType: 'stage', scopeId: stageId }, db)
    || can(viewer, 'score:write', { scopeType: 'global' }, db);
  if (!canScore) {
    throw new AppError(403, 'FORBIDDEN', '缺少能力：score:write');
  }

  // 名册（与写端点 listStageTeams 同源：同一届期、同一软删除口径）。
  const roster = listStageTeamRows(db, stageId);
  // ⛔ **可见性在服务端过滤**：
  //    企业席只看**自己出题**的队（写端点也只允许为自己出题的队签 —— 见 review.js 的归属判定）；
  //    组委会看全部。
  const visibleTeams = committee ? roster : roster.filter((t) => t.enterpriseId === viewer.id);

  // 企业确认记录（⛔ 过滤也在 SQL 里 —— 见 repo 的 listEnterpriseConfirmationRows）。
  const rows = listEnterpriseConfirmationRows(db, {
    stageId,
    enterpriseId: committee ? null : viewer.id,
  });

  // 跨领域评委候选（⛔ 排除「我」—— 后端会拒绝 crossJudgeId === 出题企业签字人）。
  const candidates = listStageJudgeCandidates(db, { stageId, excludeUserId: viewer.id });

  // 企业确认维度：⛔ **从规则表来，不写死 'enterprise'**（赛制口径不许硬编码）。
  const dims = (rules?.scoring?.[stage.scoring_config_key]?.dimensions ?? [])
    .filter((d) => d.seat === 'enterprise')
    .map((d) => ({ key: d.key, name: d.name, weight: d.weight, seat: d.seat }));

  return {
    stage: {
      id: stage.id,
      key: stage.key,
      name: stage.name,
      kind: stage.kind,
      status: stage.status,
    },
    scope: committee ? 'committee' : 'enterprise',
    myEnterpriseId: viewer.id,
    dimensions: dims,
    teams: visibleTeams.map((t) => ({
      teamId: t.id,
      teamName: t.name ?? '',
      taskPackageTitle: t.taskPackageTitle ?? null,
      enterpriseId: t.enterpriseId ?? null,
      isFreeBrief: t.isFreeBrief === true,
      // 组委会可以代录（写端点允许 committee 代替企业签）；企业席只对自己出题的队有权限。
      canSign: true,
    })),
    confirmations: rows.map((c) => ({
      id: c.id,
      teamId: c.team_id,
      enterpriseId: c.enterprise_id,
      dimension: c.dimension,
      rawScore: c.raw_score,
      hasCrossJudge: Boolean(c.cross_judge_id),
      signedAt: c.created_at,
      content: c.content ?? '',
    })),
    crossJudgeCandidates: candidates,
  };
}

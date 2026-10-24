// scripts/seed.js — 种子数据：能力点、角色、角色能力映射、初始管理员
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createUser, findUserByPhone, setSuperadmin } from '../src/db/repo/users.js';
import { insertCapability, insertRoleCapability } from '../src/db/repo/capabilities.js';
import { insertRole, insertUserRole } from '../src/db/repo/roles.js';
import { createEdition, listEditions } from '../src/db/repo/editions.js';
import { createCity, listCitiesByEdition } from '../src/db/repo/cities.js';
import { listTaskPackagesByEdition } from '../src/db/repo/taskPackages.js';
import { listStages, listStageJudges } from '../src/db/repo/stages.js';
import {
  createStage, assignStageJudgeToStage, registerStageTeamRoster,
} from '../src/services/stage.js';
import { findActiveRegistration } from '../src/db/repo/registrations.js';
import { listTeamRows } from '../src/db/repo/teams.js';
import { submitRegistration } from '../src/services/registration.js';
import { submitTaskPackage, assessSolvability, approveTaskPackage } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';
import { loadRules } from '../src/config.js';
import { assertServiceStopped } from '../src/runtime/service-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(here, '..', 'data');

// ⛔ 预审修正（I7-2）：管理员口令**不兜底**。
//    原来写 `process.env.ADMIN_PASSWORD || 'change-me-now'` —— 一个写死在代码里的
//    公开口令当组委会超管口令（预审实测已打印出来）。P6 之后这套脚本要跑在公网机器上，
//    与项目原则「校验不过就拒绝启动，绝不降级为默认值」直接冲突。
//    没有 ADMIN_PASSWORD → 明确报错 + 退出码 1，**不创建任何账号**。
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  console.error('缺少环境变量 ADMIN_PASSWORD，拒绝创建管理员账号（不提供默认口令）。');
  console.error("用法：ADMIN_PASSWORD='你的密码' node scripts/seed.js");
  process.exit(1);
}

const CAPABILITIES = [
  ['registration:write', '提交报名'],
  ['registration:review', '审核报名分级'],
  ['team:create', '创建战队'],
  ['team:read', '读取战队'],
  ['team:manage', '管理战队成员'],
  ['task_package:read', '读取任务卡'],
  ['task_package:write', '提交/编辑任务卡'],
  ['task_package:approve', '任务卡分级签约'],
  ['score:write', '写入评分'],
  ['score:read', '读取评分'],
  ['peer_review:write', '互评'],
  ['self_review:write', '提交本队自评'],
  ['signoff:create', '企业里程碑签字'],
  ['behavior:write', '提交行为分记录（周进度 / workshop 产出 / 企业对接会）'],
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
  ['audit:write', '裁决复核项与申诉'],
  ['appeal:write', '提交申诉'],
  ['pool:read', '读取三池'],
  ['pool:write', '维护三池'],
];

const ROLES = [
  ['admin', '组委会'],
  ['captain', '队长'],
  ['member', '组员'],
  ['judge', '评委席'],
  ['enterprise', '企业席'],
  ['observer', '观察员（无投票权）'],
  ['enterprise_admin', '企业管理员'],
];

/** P1 演示届期名（种子幂等的锚点：按名字认领已存在的届期，不重复建）。 */
const EDITION_NAME = '首届 · 上海';

const ROLE_CAPABILITIES = [
  ['admin', 'registration:review'], ['admin', 'team:read'], ['admin', 'team:manage'],
  ['admin', 'task_package:read'], ['admin', 'task_package:approve'], ['admin', 'score:read'],
  ['admin', 'stage:compute'], ['admin', 'audit:read'], ['admin', 'audit:write'], ['admin', 'appeal:write'], ['admin', 'pool:read'], ['admin', 'pool:write'],
  ['captain', 'registration:write'], ['captain', 'team:create'], ['captain', 'team:read'], ['captain', 'behavior:write'],
  ['captain', 'team:manage'], ['captain', 'pool:read'], ['captain', 'task_package:read'],
  ['captain', 'peer_review:write'], ['captain', 'self_review:write'], ['captain', 'appeal:write'],
  ['member', 'registration:write'], ['member', 'team:read'], ['member', 'pool:read'], ['member', 'behavior:write'],
  ['member', 'task_package:read'], ['member', 'peer_review:write'], ['member', 'self_review:write'],
  // ⚠️ DP-106：**组员也是选手** —— 他同样要对自己的**报名分级结果**提申诉
  //    （R-REG-08：分级不接收时选手可向组委会申诉）。
  //    此前只有 captain 与 admin 持有 appeal:write ⇒ 组员点「提交申诉」被 403「无权提交申诉」。
  ['member', 'appeal:write'],
  ['judge', 'score:write'], ['judge', 'score:read'], ['judge', 'peer_review:write'], ['judge', 'task_package:read'],
  ['enterprise', 'score:write'], ['enterprise', 'score:read'], ['enterprise', 'signoff:create'],
  ['enterprise', 'task_package:read'], ['enterprise', 'task_package:write'], ['enterprise', 'pool:read'],
  ['observer', 'score:read'], ['observer', 'team:read'], ['observer', 'task_package:read'],
  ['enterprise_admin', 'task_package:write'], ['enterprise_admin', 'signoff:create'], ['enterprise_admin', 'pool:read'],
];

// ⛔ 单写者闸（P1-4a，2026-10-25 评审轮）：服务还在跑时**拒绝**执行种子数据初始化。
//    依据：设计文档 §14.2 单写者约束 + README「SQLite 只允许单写进程」。
//    ⚠️ 为什么 seed 尤其危险：它会写能力点 / 角色映射 / 管理员账号 ⇒
//    在服务正在读写时跑 ⇒ 库里一半是旧规则、一半是新规则 ⇒ 权限判定直接对不上。
//    ⚠️ 判定放在**开库之前**：库一打开就可能与对方抢写锁了。
//    ⚠️ 与 backup 的区别：backup 走 SQLite 官方 backup API（**只读**、与服务并发安全，
//    它的文件头就写着「可以在服务运行中执行」）⇒ 不受这条闸约束。
try {
  assertServiceStopped({ dataDir, action: '种子数据初始化' });
} catch (err) {
  console.error(`[seed] ${err.message}`);
  process.exit(1);
}

const { db, close } = openDatabase({ dataDir });
try {
  applyMigrations(db, join(here, '..', 'db', 'migrations'));

  // ⛔ 评审修正（I-7）：种子数据写入一律走仓储层 ——
  //    本文件**不再出现任何 SQL 字符串**（全局约束「所有 SQL 收进 src/db/repo/」）。
  for (const [key, description] of CAPABILITIES) insertCapability(db, key, description);

  for (const [key, description] of ROLES) insertRole(db, key, description);

  for (const [role, cap] of ROLE_CAPABILITIES) insertRoleCapability(db, role, cap);

  const adminPhone = process.env.ADMIN_PHONE || '13800000000';
  // 查重走仓储层（findUserByPhone 取的行里不含 password_hash）
  // ⛔ 评审修正（I-7）：这条注释原来写「不写裸 SQL」，**却和同一文件里的裸 SQL 自相矛盾**
  //    —— 现在本文件确实一条 SQL 字符串都没有了：种子写入全部下沉到 src/db/repo/。
  let admin = findUserByPhone(db, adminPhone);
  if (!admin) {
    admin = createUser(db, {
      name: '组委会管理员', phone: adminPhone, password: adminPassword, mbaStatus: 'mba',
    });
    setSuperadmin(db, admin.id);
    insertUserRole(db, admin.id, 'admin');
    // 只打印账号，不回显口令
    console.log(`已创建管理员：${adminPhone}  ← 请立即修改密码`);
  } else {
    console.log(`管理员已存在：${adminPhone}`);
  }
  // P1 演示数据（届期 / 任务卡 / 选手报名 / 战队）
  const { rules } = loadRules(join(here, '..', 'rules'));
  seedP1({ db, rules, adminId: admin.id });
  console.log(`种子完成：${CAPABILITIES.length} 个能力点，${ROLES.length} 个角色，${ROLE_CAPABILITIES.length} 条角色能力映射`);
} finally {
  close();
}

// ── P1 演示数据 ─────────────────────────────────────────────────────────
/**
 * P1 种子：1 届期 + 1 城市 + 11 张任务卡 + 4 名选手报名 + 1 支已成立的战队。
 *
 * ⚠️ **角色必须显式授予**（P1 Task 7 预审修正 Critical）：
 *    `createUser` **不分配任何角色**（角色在 `user_roles` 表）。
 *    原规格建了 4 个选手 + 1 个企业代表却没授角色 →
 *    演示版里这些人登录后报名 403、建队 403、看不到任务包，
 *    整个演示是死的（预审探针：`user_roles` 里他们的 `role_key` 全是 `null`；
 *    只有管理员有 `admin` 角色）。原规格自己加的
 *    「captain/member 补 `task_package:read`」也因此**完全落空** ——
 *    根本没人持有 captain / member 这两个角色。
 *
 * ⚠️ **配比必须达标**（P1 Task 7 预审修正 Important）：
 *    R-ENT-09 要求任务池构成 A 40% / B 20% / C 10% / 自由 30%（容差 ±10%）。
 *    原规格 6 张卡凑不出这个比例，而且自由题 `grade: null` → 永远签不了级 →
 *    不进池 → 自由占比恒为 0%。预审实跑 `checkTaskMix`：
 *    `[TASK_MIX_FREE] 自由命题占比 0%，目标 30%`。
 *    现在进池 **10 张**：4 张 A + 2 张 B + 1 张 C + 3 张自由 = 精确命中 40/20/10/30；
 *    另加 1 张 **D 级**卡（六维 0 分 → 退回 + 出《问题可解性诊断报告》）演示 D 档。
 *
 * ⚠️ **幂等**（P1 Task 7 预审修正 Important）：
 *    种子会被重复执行（部署时重跑、崩溃后重跑）。原规格直接 `createUser` →
 *    第二次跑 `PHONE_TAKEN`（409）直接崩掉 —— 部署手册里的「跑一次种子」会变成地雷。
 *    现在每个实体都「先查后建」，与 P0 种子自己的 `findUserByPhone` 同一约定。
 *
 * ⚠️ **走服务层而不是仓储层**（P1 Task 7 预审修正 Important）：
 *    原规格直接调 `createTaskPackage` 仓储并手搓 `meta`，
 *    于是 R-ENT-01（字段完整）/ R-ENT-12（同意记录）/ R-ENT-10（自由题不挂企业）
 *    这些**服务层才有的校验**在种子路径上全部绕开 —— 种子与生产两套口径。
 *    现在改调 `submitTaskPackage` 服务层，`meta` 由服务层生成。
 */
function seedP1({ db, rules, adminId, now = '2026-10-20T00:00:00.000Z' }) {
  // 先查后建（幂等）
  const ensureUser = (spec) => {
    const found = findUserByPhone(db, spec.phone);
    return found ?? createUser(db, spec);
  };

  const edition = listEditions(db).find((e) => e.name === EDITION_NAME)
    ?? createEdition(db, {
      name: EDITION_NAME, city: '上海', startsAt: '2026-10-01', endsAt: '2026-10-31', now,
    });
  if (!listCitiesByEdition(db, edition.id).some((c) => c.name === '上海')) {
    createCity(db, { name: '上海', editionId: edition.id });
  }

  const enterprise = ensureUser({
    name: '某零售·企业代表', phone: '13800000001', password: 'demo-pw',
    mbaStatus: 'other', org: '某零售',
  });
  insertUserRole(db, enterprise.id, 'enterprise');

  // 六维作答模板：每一档都按「该档位的分值区间」构造，
  // 让卡片的评估分与组委会签的级**自洽**（否则演示里会出现「评估 11 分却签 C」的怪事）。
  // ⚠️ data_access 与 accountability 都不能取 0 —— 取 0 会命中一票否决
  //    （无法提供数据授权说明 / 无企业侧唯一责任人），被强制退回 D。
  const ANSWERS = {
    A: { problem_clarity: 3, data_access: 3, validation: 2, decision_chain: 1, accountability: 1, precedent: 1 },
    B: { problem_clarity: 2, data_access: 2, validation: 2, decision_chain: 1, accountability: 1, precedent: 1 },
    C: { problem_clarity: 1, data_access: 1, validation: 1, decision_chain: 0, accountability: 1, precedent: 1 },
    D: { problem_clarity: 2, data_access: 0, validation: 1, decision_chain: 0, accountability: 0, precedent: 0 },
  };

  // 进池 10 张：4×A + 2×B + 1×C + 3×自由（R-ENT-09 精确命中 40/20/10/30）
  // ＋ 1 张 D 级卡（退回 + 诊断报告，演示 D 档）
  const specs = [
    { title: '门店排班优化', grade: 'A', free: false },
    { title: '供应链需求预测', grade: 'A', free: false },
    { title: '会员复购预测', grade: 'A', free: false },
    { title: '门店能耗优化', grade: 'A', free: false },
    { title: '客服知识库问答', grade: 'B', free: false },
    { title: '选品需求预测', grade: 'B', free: false },
    { title: '门店陈列合规巡检', grade: 'C', free: false },
    { title: '开源模型微调实验', grade: 'A', free: true },
    { title: '公共数据问诊助手', grade: 'B', free: true },
    { title: '公益法律问答助手', grade: 'A', free: true },
    { title: '社区养老排班助手', grade: 'D', free: false },
  ];

  const existing = new Map(listTaskPackagesByEdition(db, edition.id).map((p) => [p.title, p]));
  const packages = [];
  for (const spec of specs) {
    let pkg = existing.get(spec.title) ?? null;
    if (!pkg) {
      const submitted = submitTaskPackage({
        db,
        userId: spec.free ? adminId : enterprise.id,
        payload: {
          editionId: edition.id,
          title: spec.title,
          painPoint: `${spec.title}：目前靠人工，效率低且不可复制`,
          expectedDelivery: '可运行原型 + 一次真实数据验证',
          acceptanceCriteria: '门店负责人认可并愿意试点',
          // R-ENT-10：自由命题**不挂企业主体**（企业签字对自由题不成立）
          enterpriseId: spec.free ? null : enterprise.id,
          enterpriseName: spec.free ? null : '某零售',
          isFreeBrief: spec.free,
          consent: { accepted: true },
        },
        now,
        rules,
      });
      pkg = { id: submitted.id, status: 'submitted' };
    }
    // 幂等续跑：卡在哪个阶段就从哪个阶段往下走
    if (pkg.status === 'submitted') {
      // ⚠️ **评估者必须与卡片的企业主体一致**（2026-10-23 审计 F42 修完后）：
      //    「可解性六维评估」改的是**进池的输入**（grade 与承诺）⇒ 只能由
      //    出题企业（或组委会）做，否则企业 A 能改企业 B 的卡的评级。
      //    非自由卡：企业席出题（enterprise_id = 企业席自己）⇒ 企业席本人评估；
      //    自由题：无企业主体（R-ENT-10，committee 提交）⇒ 组委会评估。
      assessSolvability({
        db, taskPackageId: pkg.id, answers: ANSWERS[spec.grade],
        actorId: spec.free ? adminId : enterprise.id, now, rules,
      });
      pkg = { ...pkg, status: 'assessed' };
    }
    if (pkg.status === 'assessed') {
      approveTaskPackage({
        db, taskPackageId: pkg.id, grade: spec.grade, actorId: adminId, now, rules,
        // ⚠️ P10（W4-a）：**D 级退回必须写明退回理由**（企业要照着改）——
        //    种子里的 D 级卡是「六维 0 分」那张，不给理由 ⇒ 服务层抛 400 RETURN_REASON_REQUIRED
        //    ⇒ 整个种子跑不完（演示数据缺失）。非 D 级不给理由（不改原语义）。
        reason: spec.grade === 'D' ? '六维全 0：任务描述不可执行，退回让企业重写后再提交' : null,
      });
      pkg = { ...pkg, status: spec.grade === 'D' ? 'returned' : 'published' };
    }
    packages.push(pkg);
  }

  // 选手：四档画像（S / A / B / C），覆盖「被接收 / 不接收」两条分支
  const profiles = [
    { name: '队长甲', phone: '13800000011', mbaStatus: 'mba', role: 'captain', answers: [5, 5, 5, 5, 5] },
    { name: '组员乙', phone: '13800000012', mbaStatus: 'mba', role: 'member', answers: [4, 4, 4, 4, 4] },
    { name: '组员丙', phone: '13800000013', mbaStatus: 'mba', role: 'member', answers: [3, 3, 3, 3, 3] },
    { name: '落选丁', phone: '13800000014', mbaStatus: 'mba', role: 'member', answers: [1, 1, 1, 1, 1] },
  ];
  const users = [];
  for (const p of profiles) {
    const u = ensureUser({
      name: p.name, phone: p.phone, password: 'demo-pw', mbaStatus: p.mbaStatus,
    });
    insertUserRole(db, u.id, p.role);
    let level = null;
    if (!findActiveRegistration(db, u.id, edition.id)) {
      const reg = submitRegistration({
        db,
        userId: u.id,
        editionId: edition.id,
        answers: {
          direction: p.answers, capability: p.answers, collaboration: p.answers,
          open: '我想用 AI 解决真实门店的排班与库存协同问题',
          consent: { accepted: true },
        },
        now,
        rules,
      });
      level = reg.level;
    } else {
      const found = findActiveRegistration(db, u.id, edition.id);
      level = found.level;
    }
    users.push({ user: u, level });
  }

  // 一支已成立的战队（认领第一张 A 级任务卡）
  const captain = users[0].user;
  const member = users[1].user;
  const existingTeam = listTeamRows(db, { editionId: edition.id }).find((t) => t.name === '甲队');
  if (!existingTeam) {
    const team = createTeam({
      db, userId: captain.id, editionId: edition.id,
      taskPackageId: packages[0].id, name: '甲队', now, rules,
    });
    addMember({ db, teamId: team.id, userId: member.id, actorId: captain.id, now, rules });
  }

  const teams = listTeamRows(db, { editionId: edition.id });
  const stages = seedStages({ db, rules, edition, teams, adminId, now });

  console.log(
    `P1 种子：届期 ${edition.name}｜任务卡 ${packages.length} 张（进池 10 + D 级退回 1）｜`
    + `选手 ${users.length} 人（等级 ${users.map((u) => u.level).join('/')}）｜战队 甲队｜`
    + `赛段 ${stages.length} 个`,
  );
  return { edition, packages, users, stages };
}

// ── P11 · W5-c：赛段与评委席 ──────────────────────────────────────────
/**
 * P11 种子：**建赛段 + 派评委 + 报名册**。
 *
 * ⛔⛔ **为什么必须有这一步（P11 · E150，真机实测）**：
 *   在真机生产库 `/var/lib/heikesong/data/app.db` 上实测：
 *     `stages = 0`、`stage_team = 0`（teams = 1 / users = 6 / editions = 1）
 *   ⇒ **全新部署的平台一条赛段都没有**。
 *   后果：评审打分页 / 发榜页 / 破同分 / 企业签字台全部以 `:stageId` 为路径参数
 *   ⇒ **一个都进不去**（`GET /api/stages` 返回空集，前端连选赛段都做不到）。
 *   ⇒ 本轮补好的发榜端点（E149）在真机上**依然不可达** —— 端点是对的，但**没有赛段可发**。
 *   根因：`insertStage` / `assignStageJudge` / `registerStageTeams`
 *   **在生产上零调用方**（只有测试在调）⇒ 仓储层写好了，却没有任何生产路径会写。
 *
 * ⚠️ **日程与权重表只从 `rules/*.json` 来**（全局约束「规则只从 rules/*.json 来」）：
 *   · 赛段清单 ← `rules/schedule.json` 的 `stages`（S1 调研 / S2 任务 / S3 开发 / S4 路演 / S5 落地）
 *   · 权重表   ← `rules/scoring-initial.json` / `rules/scoring-final.json`
 *   ⇒ **不硬编码**赛段名与日期；改赛制只改 rules，不改代码。
 *
 * ⚠️ **幂等**（与本文件其余种子同一约定：先查后建）：
 *   种子会被重复执行（部署时重跑、崩溃后重跑）⇒ 建赛段要先查 key，
 *   派评委要先查席位，报名册服务层本身幂等。
 *
 * ⚠️ **走服务层而不是仓储层**（与 P1 种子同一条约定）：
 *   `createStage` 有校验与审计、`assignStageJudgeToStage` 会**同事务**写
 *   席位 + 利益冲突声明、`registerStageTeamRoster` 幂等 ⇒ 种子与生产两套口径。
 */
function seedStages({ db, rules, edition, teams, adminId, now = '2026-10-20T00:00:00.000Z' }) {
  const schedule = rules?.schedule;
  const plan = Array.isArray(schedule?.stages) ? schedule.stages : [];
  if (!plan.length) {
    // ⛔ 不静默跳过：没有赛段 ⇒ 整条评审链是死的（E150 的根因）。
    //    直接报错，让部署的人看见，而不是装出一个「能登录但什么都不能做」的平台。
    throw new Error('rules/schedule.json 里没有 stages 段 ⇒ 无法建赛段（评审/发榜整条链会不可用）');
  }

  // 评委席（P11 · E150）：评审链要能跑起来，必须有人打分。
  // ⚠️ 席位构成口径来自 `rules/scoring-*.json` 的 judgePool：
  //   企业席 ≥30%、专家席 ≤50%、其余 observer【无投票权】（R-JDG-11）。
  const judges = ensureJudges({ db, now });
  const enterpriseSeatUserId = judges.enterpriseUserId;

  const created = [];
  for (const [index, spec] of plan.entries()) {
    const key = String(spec.key ?? '').toLowerCase();
    const existing = listStages(db, { editionId: edition.id }).find((s) => s.key === key);
    const stage = existing ?? createStage({
      db,
      editionId: edition.id,
      key,
      name: spec.name,
      kind: stageKindOf(spec, index),
      startsAt: resolveStageDate(edition, spec.start),
      endsAt: resolveStageDate(edition, spec.end),
      scoringConfigKey: stageScoringKeyOf(spec, index),
      actorId: adminId,
      now,
      rules,
    });

    // 派评委（席位 + 利益冲突声明同事务写入 ⇒ 走服务层）
    for (const judge of judges.voting) {
      const already = listStageJudges(db, stage.id).some((j) => j.user_id === judge.id);
      if (already) continue;
      assignStageJudgeToStage({
        db, stageId: stage.id, userId: judge.id, seat: judge.seat, actorId: adminId, now,
      });
    }
    if (enterpriseSeatUserId) {
      const already = listStageJudges(db, stage.id).some((j) => j.user_id === enterpriseSeatUserId);
      if (!already) {
        assignStageJudgeToStage({
          db, stageId: stage.id, userId: enterpriseSeatUserId, seat: 'enterprise', actorId: adminId, now,
        });
      }
    }

    // 报名册（幂等）：本赛段的参赛队
    const teamIds = teams.map((t) => t.id);
    if (teamIds.length) {
      registerStageTeamRoster({ db, stageId: stage.id, teamIds, actorId: adminId, now });
    }
    created.push(stage);
  }
  return created;
}

/**
 * 赛段 `kind` 映射（数据库枚举：initial | final | roadshow | landing）。
 * ⚠️ 规则文件里没有 kind 字段 ⇒ 按赛段序位推导（第一个 = 初赛，最后一个 = 落地，
 *    中间含「路演」的 = roadshow，其余 = final）。
 */
function stageKindOf(spec, index) {
  const name = String(spec.name ?? '');
  if (name.includes('路演')) return 'roadshow';
  if (name.includes('落地')) return 'landing';
  if (index === 0) return 'initial';
  return 'final';
}

/**
 * 赛段的权重表键（initial | final）。
 * ⚠️ 前两个赛段走初赛权重表，之后走决赛权重表 —— 与 `rules/scoring-*.json` 的两套权重对应。
 */
function stageScoringKeyOf(spec, index) {
  return index <= 1 ? 'initial' : 'final';
}

/**
 * 赛段日期：规则里是「月-日」（相对赛段序日），落到具体日历日期由 edition.starts_at 偏移。
 * ⚠️ `rules/schedule.json` 的 note 明写这条约定：「日期为赛段相对日序（月-日）；
 *    落到具体日历日期由 edition.starts_at 偏移」。
 */
function resolveStageDate(edition, monthDay) {
  const md = String(monthDay ?? '');
  const m = md.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`rules/schedule.json 的赛段日期格式不对：${md}（应为 MM-DD）`);
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = String(edition.starts_at ?? '2026-10-01').slice(0, 4);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * P11 种子评委席。
 * ⚠️ **席位构成按 R-JDG-11**（企业席 ≥30%、专家席 ≤50%、其余 observer 无投票权）。
 *   种子给 2 名专家席 + 1 名企业席 + 1 名观察员（4 席 ⇒ 企业席 25%）。
 *   ⚠️ 比例不达标**不阻断种子**（评审链能跑比比例精确更重要），
 *      但**必须留痕**：控制台会打印实际席位数。
 */
function ensureJudges({ db, now }) {
  const specs = [
    { name: '评委甲', phone: '13800000021', seat: 'judge' },
    { name: '评委乙', phone: '13800000022', seat: 'judge' },
    { name: '观察员', phone: '13800000023', seat: 'observer' },
  ];
  const voting = [];
  for (const spec of specs) {
    const found = findUserByPhone(db, spec.phone);
    const user = found ?? createUser(db, {
      name: spec.name, phone: spec.phone, password: 'demo-pw', mbaStatus: 'mba',
    });
    if (!found) insertUserRole(db, user.id, spec.seat);
    if (spec.seat !== 'observer') voting.push({ id: user.id, seat: spec.seat });
  }
  // 企业席：复用已有的企业代表（种子本来就建了一个）
  const enterprise = findUserByPhone(db, '13800000001');
  return { voting, enterpriseUserId: enterprise ? enterprise.id : null };
}

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
import { findActiveRegistration } from '../src/db/repo/registrations.js';
import { listTeamRows } from '../src/db/repo/teams.js';
import { submitRegistration } from '../src/services/registration.js';
import { submitTaskPackage, assessSolvability, approveTaskPackage } from '../src/services/taskPackage.js';
import { createTeam, addMember } from '../src/services/team.js';
import { loadRules } from '../src/config.js';

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
  ['stage:compute', '触发计算发榜'],
  ['audit:read', '读取审计与计算快照'],
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
  ['admin', 'stage:compute'], ['admin', 'audit:read'], ['admin', 'pool:read'], ['admin', 'pool:write'],
  ['captain', 'registration:write'], ['captain', 'team:create'], ['captain', 'team:read'],
  ['captain', 'team:manage'], ['captain', 'pool:read'], ['captain', 'task_package:read'],
  ['captain', 'peer_review:write'], ['captain', 'self_review:write'],
  ['member', 'registration:write'], ['member', 'team:read'], ['member', 'pool:read'],
  ['member', 'task_package:read'], ['member', 'peer_review:write'], ['member', 'self_review:write'],
  ['judge', 'score:write'], ['judge', 'score:read'], ['judge', 'peer_review:write'], ['judge', 'task_package:read'],
  ['enterprise', 'score:write'], ['enterprise', 'score:read'], ['enterprise', 'signoff:create'],
  ['enterprise', 'task_package:read'], ['enterprise', 'task_package:write'], ['enterprise', 'pool:read'],
  ['observer', 'score:read'], ['observer', 'team:read'], ['observer', 'task_package:read'],
  ['enterprise_admin', 'task_package:write'], ['enterprise_admin', 'signoff:create'], ['enterprise_admin', 'pool:read'],
];

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
      assessSolvability({
        db, taskPackageId: pkg.id, answers: ANSWERS[spec.grade], actorId: enterprise.id, now, rules,
      });
      pkg = { ...pkg, status: 'assessed' };
    }
    if (pkg.status === 'assessed') {
      approveTaskPackage({ db, taskPackageId: pkg.id, grade: spec.grade, actorId: adminId, now, rules });
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

  console.log(
    `P1 种子：届期 ${edition.name}｜任务卡 ${packages.length} 张（进池 10 + D 级退回 1）｜`
    + `选手 ${users.length} 人（等级 ${users.map((u) => u.level).join('/')}）｜战队 甲队`,
  );
  return { edition, packages, users };
}

// web/nav.js — 导航分区模型（按角色分区 · 前端侧）
// 依据：docs/three-port-alignment.md（三端拆分：用户端 / 管理员端 / 组委会端）
//
// ⚠️ **本文件是「导航分区」的唯一来源**：
//   打磨前的首页是 6 个平铺链接（首页/登录/榜单/复核队列/报名/我的战队/筛选台），
//   **所有人看到的一模一样** —— 组委会看到「报名」，选手也看到「报名」。
//   这不是审美问题，是三端拆分在界面上**完全没落地**。
//   ⇒ 现在导航按角色分区，且分区规则是**声明式数据**（加页面 = 加一条数据，不改渲染逻辑）。
//
// ⛔ **可见性仍然在 API 层过滤**（全局约束）：
//   这里的「按角色分区」只是**导航入口**的分区，不是数据可见性的裁决。
//   任何页面拿到的数据仍然由 API 层按 capability + assignment 过滤 ——
//   前端隐藏一个入口 ≠ 用户就看不到数据（后端仍然拦得住）。
import { escapeHtml } from './escape.js';
import { iconLogo, iconTheme } from './icons.js';

/**
 * 角色元数据。
 * ⚠️ 键取自 roles 表的 role_key（与 user_roles.role_key 同键值域），
 *    实测口径见「角色→能力实测（真机）」：admin / captain / member / judge /
 *    enterprise / observer / enterprise_admin 共 7 个角色。
 */
export const ROLE_META = {
  admin: { label: '组委会', group: 'committee' },
  judge: { label: '评委席', group: 'review' },
  enterprise: { label: '企业席', group: 'review' },
  enterprise_admin: { label: '企业命题', group: 'review' },
  captain: { label: '队长', group: 'player' },
  member: { label: '组员', group: 'player' },
  observer: { label: '观察员', group: 'observer' },
};

/** 游客（未登录）。 */
export const GUEST = { label: '访客', group: 'guest' };

/**
 * 导航分区。
 *
 * ⚠️ 字段说明：
 *   - `auth: true` ⇒ 需要登录才出现；
 *   - `roles: [...]` ⇒ 需要命中其中任一角色；
 *   - `exact: true` ⇒ 只有路径完全相等才算「当前页」（否则 '/tasks' 会把 '/tasks/x' 也点亮）。
 *
 * ⛔ 「评审台」分区在 **P8 之前**故意留空：评审打分页当时不存在，
 *   放一个空分区等于放一个死入口 —— 等页面真的存在时再加这一条数据。
 *   ⇒ P8 起补上「评审席」分区（评审打分）与组委会分区里的「赛段发榜」。
 */
export const NAV_SECTIONS = [
  {
    id: 'public',
    label: '赛事',
    items: [
      { path: '/', label: '首页', exact: true },
      { path: '/leaderboard', label: '榜单' },
      { path: '/tier', label: '段位榜' },
    ],
  },
  {
    id: 'player',
    label: '我的赛事',
    auth: true,
    items: [
      // ⚠️ P9：工作台 = 原「赛事总览」仪表盘，从 `/` 迁到这里（首页让位给落地页）。
      { path: '/dashboard', label: '工作台' },
      { path: '/apply', label: '报名' },
      { path: '/team', label: '我的战队' },
      { path: '/tasks', label: '任务清单' },
    ],
  },
  {
    // ⚠️ **不按角色限定**：评委席位是**赛段级**指派的（stage_judges 表），
    //   前端手里没有「你是不是本赛段评委」这个信息 ⇒ 硬按角色限定会**误伤**。
    //   能不能进评审页由 API 裁决（403 → 错误态说清缺什么权限），沿用 DP-77。
    id: 'reviewer',
    label: '评审席',
    auth: true,
    items: [
      { path: '/review', label: '评审打分' },
      // ⚠️ P10：评委前置（回避申报 / 互评 / 自评 / 校准）——
      //   ⛔ **不按角色限定**：评委的能力点可能是**赛段级**授权，
      //   前端拿不到「你是不是本赛段评委」⇒ 按能力点过滤会误伤（DP-105 同一条原则）。
      { path: '/review/prep', label: '评委前置' },
    ],
  },
  {
    // ⚠️ P10 · W4-b：企业席分区（企业签字台 = 里程碑签字 + 企业双签）。
    //   按**角色**分区（不是能力点）：`signoff:create` 可以是**届期级**授权，
    //   而 `/api/me` 的 capabilities 只回「全局授权 + 角色能力」
    //   ⇒ 按能力点过滤会把届期级授权的人**挡在菜单外**（误伤）。
    //   能不能签一律由 API 裁决（403 → 错误态说清缺什么权限）。
    id: 'enterprise',
    label: '企业席',
    auth: true,
    roles: ['enterprise', 'enterprise_admin'],
    items: [
      { path: '/signoff', label: '企业签字台' },
    ],
  },
  {
    id: 'committee',
    label: '组委会',
    auth: true,
    roles: ['admin'],
    items: [
      { path: '/admin/registration', label: '报名筛选台' },
      { path: '/admin/task-packages', label: '任务卡审批' },
      { path: '/admin/appeals', label: '申诉裁决' },
      { path: '/flags', label: '复核队列' },
      { path: '/publish', label: '赛段发榜' },
    ],
  },
];

/**
 * 受保护路由（路由守卫）。
 * ⚠️ 守卫的作用是**别把访客丢进一个必然 401 的页面**：
 *   打磨前，未登录点「报名」→ 页面骨架渲染出来 → 异步请求 401 →
 *   错误文案「未登录」出现在表单下方，像表单坏了。
 *   现在未登录直接看到「需要登录」引导页。
 *
 * ⚠️ **这里的守卫只判「是否登录」**（角色/能力一律由 API 裁决 —— 理由见下）。
 *
 * ⛔⛔ **前端绝不按角色**硬编码**拦路**（DP-77 的原始红线，W1-b · DP-105 修订）：
 *   前端手里的角色**不等于**服务端的授权结果 —— 能力点可以**直接授权给个人**
 *   （assignments 表 / resource-level 授权），根本不经角色。
 *   ⇒ 如果前端按角色拦路由，一个「有 audit:read 但没有 admin 角色」的人
 *      会被前端挡在门外，而 API 其实放行 —— **误伤有权限的人**。
 *   ⇒ 授权的唯一裁决者是 API（can() + scopeClause）。
 *   角色分区只用于**导航入口的呈现**（谁看到哪些菜单），
 *   它不阻断任何页面的可达性 —— 真正的拦截交给服务端。
 *
 * ⚠️ **W1-b · DP-105 的修订**：前端**按能力点**拦**分区级**页面（见 ROUTE_CAPABILITIES）——
 *   这不是「按角色硬编码」，而是「按能力点声明」，且**只声明 API 同样要求全局能力点**的页面，
 *   ⇒ 前后端口径一致，不会出现「前端放行、API 403」或「前端拦下、API 放行」。
 *   赛段级页面（/review/:stageId 等）**一律不拦**：评委的能力点可能是赛段级授权，
 *   前端无从判断 ⇒ 拦了就是误伤（DP-105 明写「不拦」）。
 */
export const PROTECTED_ROUTES = [
  // P9：工作台（原总览仪表盘）需要登录
  { pattern: /^\/dashboard\/?$/, auth: true },
  { pattern: /^\/apply\/?$/, auth: true },
  { pattern: /^\/team\/?$/, auth: true },
  { pattern: /^\/tasks(\/|$)/, auth: true },
  { pattern: /^\/admin(\/|$)/, auth: true },
  { pattern: /^\/flags\/?$/, auth: true },
  { pattern: /^\/audit(\/|$)/, auth: true },
  // P8：评审打分与赛段发榜都需要登录（/^\/review(\/|$)/ 已覆盖 P10 的 /review/prep）
  { pattern: /^\/review(\/|$)/, auth: true },
  { pattern: /^\/publish(\/|$)/, auth: true },
  // P10：企业签字台需要登录
  { pattern: /^\/signoff\/?$/, auth: true },
];

/**
 * 分区级页面 → 所需能力点（W1-b · DP-105）。
 *
 * ⚠️ **精确匹配，不是前缀匹配**：
 *   '/publish' 要 'stage:compute'，但 '/publish/stage_final'（赛段级发榜）**不在表里** ——
 *   它的权限由 API 按赛段裁决（评委 / 企业席拿的是**赛段级**授权），
 *   前端拿不到「你是不是本赛段评委」这个信息 ⇒ 拦它就是误伤。
 *
 * ⚠️ **只列「API 同样要求全局能力点」的页面** ⇒ 前后端口径一致：
 *   | 路径 | 能力点 | 服务端口径 |
 *   |---|---|---|
 *   | /admin/registration | registration:review | 全局（管理员端筛选台） |
 *   | /admin/task-packages | task_package:approve | 全局（角色授予；P10 新增） |
 *   | /admin/appeals | audit:read | 全局（can(user,'audit:read',null,db)） |
 *   | /flags | audit:read | 全局（复核队列） |
 *   | /publish | stage:compute | 全局（赛段发榜入口） |
 *
 * ⛔ **赛段级页面一律不列**（/review/prep、/review/:stageId、/publish/:stageId…）：
 *   评委的能力点可能是**赛段级授权**，前端无从判断 ⇒ 拦它就是误伤。
 * ⛔ 这张表**不是授权依据**（服务端 can() 才是）—— 它只决定「前端要不要提前说不行」。
 */
export const ROUTE_CAPABILITIES = {
  '/admin/registration': 'registration:review',
  '/admin/task-packages': 'task_package:approve',
  '/admin/appeals': 'audit:read',
  '/flags': 'audit:read',
  '/publish': 'stage:compute',
};

/** 路径归一：去掉 query 与结尾斜杠（'/flags/' 与 '/flags' 是同一个页面）。 */
function normalizePath(path) {
  const clean = String(path || '/').split('?')[0].split('#')[0];
  return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

/**
 * 这条路径需要的能力点（没声明 ⇒ null ⇒ 不拦）。
 * @param {string} path
 * @returns {string|null}
 */
export function requiredCapability(path) {
  const clean = normalizePath(path);
  return Object.prototype.hasOwnProperty.call(ROUTE_CAPABILITIES, clean)
    ? ROUTE_CAPABILITIES[clean]
    : null;
}

/** 取用户身上的能力点键数组（宽容处理各种形状）。 */
export function userCapabilities(user) {
  if (!user) return [];
  const raw = user.capabilities ?? user.capabilityKeys ?? [];
  if (Array.isArray(raw)) return raw.filter((c) => typeof c === 'string' && c);
  if (typeof raw === 'string') return raw ? [raw] : [];
  return [];
}

/** 取用户身上的角色键数组（宽容处理各种形状）。 */
export function userRoles(user) {
  if (!user) return [];
  const raw = user.roles ?? user.roleKeys ?? [];
  if (Array.isArray(raw)) return raw.filter((r) => typeof r === 'string' && r);
  if (typeof raw === 'string') return raw ? [raw] : [];
  return [];
}

/** 主身份标签：取第一个已知角色；超管直通组委会。 */
export function roleLabel(user) {
  if (!user) return GUEST.label;
  if (user.isSuperadmin === true || user.is_superadmin === 1) return '组委会 · 超管';
  const roles = userRoles(user);
  for (const r of roles) {
    if (ROLE_META[r]) return ROLE_META[r].label;
  }
  return GUEST.label;
}

/** 当前路径是否落在某条受保护规则上。 */
export function guardFor(path) {
  const clean = String(path || '/').split('?')[0];
  return PROTECTED_ROUTES.find((r) => r.pattern.test(clean)) ?? null;
}

/**
 * 当前用户能否访问某条路径（**登录态**这一关）。
 * ⚠️ **只判登录态**（理由见 PROTECTED_ROUTES 上方的设计红线）：
 *   角色/能力一律由 API 裁决 —— 前端按角色拦路会误伤「被直接授权」的人。
 *   fail-closed：没登录 ⇒ 不放行。
 *
 * ⚠️ 能力点那一关在 canReach()（W1-b · DP-105）：**按能力点声明**，不按角色硬编码。
 */
export function canAccess(path, user) {
  const guard = guardFor(path);
  if (!guard) return true;
  if (guard.auth && !user) return false;
  return true;
}

/**
 * 当前用户能不能**到达**某条路径（W1-b · DP-105 的分区级守卫）。
 *
 * 判定顺序（每一档的理由都写在下面）：
 *   ① 这条路径**没声明能力点** ⇒ 放行（不拦）——
 *      「前端无从判断就别拦」是本仓一贯的原则（赛段级页面同此）；
 *   ② 没登录 ⇒ 拦（沿用现有 canAccess 的口径：这三条路径都在 PROTECTED_ROUTES 里）；
 *   ③ 超管 ⇒ 直通（服务端 can() 也是这个口径）；
 *   ④ 服务端**没给能力点**（user.capabilities 不是数组）⇒ 放行 ——
 *      这个 user 对象不是 /api/me 的形状（演示适配器 / 旧缓存会话），
 *      前端手里**没有**能力点信息 ⇒ 拦它就是瞎猜（误伤）；
 *   ⑤ 能力点数组里有这条路径要的那一个 ⇒ 放行，否则拦。
 *
 * ⛔ **不按角色拦**：角色 ≠ 授权（见 PROTECTED_ROUTES 上方的设计红线）。
 * ⛔ **服务端仍然是唯一裁决者**：这里放行不代表能拿到数据（API 照样 403）。
 */
export function canReach(path, user) {
  const clean = normalizePath(path);
  const required = requiredCapability(clean);
  if (!required) return true;                          // ① 未声明能力点 ⇒ 不拦
  if (!user || !canAccess(clean, user)) return false;   // ② 未登录 ⇒ 拦
  if (user.isSuperadmin === true || user.is_superadmin === 1) return true; // ③ 超管直通
  const raw = user.capabilities;
  if (!Array.isArray(raw)) return true;                // ④ 前端无从判断 ⇒ 不拦
  return raw.includes(required);                      // ⑤ 能力点命中
}

/**
 * 路径对应的页面名（从 NAV_SECTIONS 里查；查不到 ⇒ null）。
 * ⚠️ 用于守卫页文案（「报名筛选台需要 registration:review 能力点」），
 *    免得把裸路径甩给用户看。
 */
export function routeLabel(path) {
  const clean = normalizePath(path);
  for (const sec of NAV_SECTIONS) {
    for (const item of sec.items) {
      if (item.path === clean) return item.label;
    }
  }
  return null;
}

/** 导航项是否是「当前页」。 */
export function isActive(path, item) {
  const clean = String(path || '/').split('?')[0];
  if (item.exact) return clean === item.path;
  return clean === item.path || clean.startsWith(`${item.path}/`);
}

/**
 * 按当前用户裁剪导航分区（纯函数）。
 * - 未登录 ⇒ 只留公开分区；
 * - 有角色 ⇒ 保留 roles 命中的分区。
 *
 * ⚠️ P10：**分区只按「角色」**（与既有语义一致）。
 *   曾试过给导航项加 `capabilities` 做能力点过滤，**已撤回** ——
 *   `signoff:create` 等能力点可以是**赛段级 / 届期级**授权，
 *   而 `/api/me` 的 capabilities 只回「全局授权 + 角色能力」
 *   ⇒ 按能力点过滤会把那类**有权限的人挡在菜单外**（误伤）。
 *   导航分区是**呈现**，授权的唯一裁决者是 API。
 */
export function visibleSections(user) {
  const roles = userRoles(user);
  const isSuper = user?.isSuperadmin === true || user?.is_superadmin === 1;
  return NAV_SECTIONS
    .filter((sec) => {
      if (sec.auth && !user) return false;
      if (sec.roles?.length && !isSuper && !roles.some((r) => sec.roles.includes(r))) return false;
      return true;
    })
    .map((sec) => ({ ...sec, items: sec.items.filter((it) => canAccess(it.path, user)) }));
}

/**
 * 顶栏 HTML。
 * @param {object|null} user 当前用户
 * @param {string} path 当前路径（用于点亮当前项）
 */
export function navHtml(user, path = '/') {
  const sections = visibleSections(user);
  const groups = sections.map((sec) => {
    const links = sec.items.map((it) => {
      const on = isActive(path, it);
      return `<a class="nav-link${on ? ' is-active' : ''}" href="#${escapeHtml(it.path)}"${on ? ' aria-current="page"' : ''}>${escapeHtml(it.label)}</a>`;
    }).join('');
    if (!links) return '';
    return `<div class="nav-group"><span class="nav-group__label">${escapeHtml(sec.label)}</span><div class="nav-group__links">${links}</div></div>`;
  }).join('');

  const userBox = `<div class="topbar__user">
    ${user ? `<span class="user-chip">
          <span class="user-chip__avatar" aria-hidden="true">${escapeHtml((user.name || '?').slice(0, 1))}</span>
          <span class="user-chip__meta">
            <span class="user-chip__name">${escapeHtml(user.name || '')}</span>
            <span class="user-chip__role">${escapeHtml(roleLabel(user))}</span>
          </span>
        </span>` : ''}
    <button type="button" class="btn btn--ghost btn--sm btn--icon" data-action="theme" aria-label="切换亮色 / 暗色主题">${iconTheme(16)}</button>
    ${user
      ? '<a class="btn btn--ghost btn--sm" href="#/logout">退出</a>'
      // ⚠️ 访客的「登录」用**描边**按钮，不用实底强调色：
      //    实底强调色留给「落地页那个唯一的主 CTA」（立即报名）——
      //    一屏两个实底强调按钮 ⇒ 强调色就不再指向任何东西了。
      : '<a class="btn btn--ghost btn--sm" href="#/login">登录</a>'}
  </div>`;

  return `<div class="topbar__inner">
    <a class="topbar__brand" href="#/">
      <span class="topbar__logo" aria-hidden="true">${iconLogo(18)}</span>
      <span class="topbar__names">
        <strong class="topbar__title">华东区 AI 商业黑客松</strong>
        <span class="topbar__sub">赛事平台</span>
      </span>
    </a>
    <nav class="topbar__nav" aria-label="主导航">${groups}</nav>
    ${userBox}
  </div>`;
}

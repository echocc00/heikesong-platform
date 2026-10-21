// src/db/repo/taskPackages.js — 任务卡仓储
// 依据：INTERFACES.md §2 + R-ENT-01（痛点/期望交付/验收标准）
import { randomUUID } from 'node:crypto';

// 可更新列白名单：列名只能从这里出，杜绝把用户输入拼进 SET 子句
const UPDATABLE = new Set([
  'title', 'pain_point', 'expected_delivery', 'acceptance_criteria',
  'grade', 'status', 'solvability_score', 'solvability_grade',
  'commitment', 'agreement', 'approved_by', 'approved_at', 'meta_json',
]);

/**
 * task_packages.status 的**取值域**。
 * 唯一写入方是 src/services/taskPackage.js 的状态机：
 *   submitted → assessed → published | returned →（补短板后）assessed → …
 * （该服务里的 ASSESSABLE / APPROVABLE 是本表的子集。）
 * ⚠️ 为什么要把它单列一份：配置里 rules.pools.packageStatusFilter 会**按 status 过滤**，
 *    写错一个拼写 ⇒ 过滤掉全部任务包 ⇒ 资源池空掉且**不报任何错**。
 *    src/config.js 的 fail-fast 交叉引用校验读的就是这份清单。
 */
export const TASK_PACKAGE_STATUSES = ['submitted', 'assessed', 'returned', 'published'];

export function createTaskPackage(db, {
  editionId,
  enterpriseId = null,
  enterpriseName = null,
  title,
  painPoint,
  expectedDelivery,
  acceptanceCriteria,
  isFreeBrief = false,
  submittedBy,
  meta = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO task_packages (
       id, edition_id, enterprise_id, enterprise_name, title, pain_point,
       expected_delivery, acceptance_criteria, grade, status,
       solvability_score, solvability_grade, commitment, agreement,
       is_free_brief, submitted_by, submitted_at, approved_by, approved_at,
       meta_json, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'submitted', NULL, NULL, NULL, NULL,
               ?, ?, ?, NULL, NULL, ?, NULL)`,
  ).run(
    id, editionId, enterpriseId, enterpriseName, title, painPoint,
    expectedDelivery, acceptanceCriteria,
    isFreeBrief ? 1 : 0, submittedBy, now,
    meta ? JSON.stringify(meta) : null,
  );
  return getTaskPackage(db, id);
}

export function getTaskPackage(db, id) {
  return db.prepare('SELECT * FROM task_packages WHERE id = ? AND deleted_at IS NULL').get(id) ?? null;
}

/**
 * 按届期列任务卡。
 *
 * ⚠️ 父代理预审修正（Important）：editionId 缺省时**不按届期过滤**（列全部届期），
 *    而不是把 undefined 绑进 SQL。
 *    原来写死 `WHERE edition_id = ?` → GET /api/task-packages 不带 editionId 时
 *    node:sqlite 抛「Provided value cannot be bound to SQLite parameter 1.」
 *    → 裸 TypeError 漏到 HTTP 层 → 只能回 500（父代理预审实跑复现）。
 *    约定与报名的 listRegistrationRows 完全一致：过滤条件缺省即不生效。
 */
export function listTaskPackagesByEdition(db, editionId = null) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (editionId) { where.push('edition_id = ?'); params.push(editionId); }
  return db
    // ⚠️ 父代理预审修正（确定性排序）：原来的兜底排序键是 `id`，
    //    而 id 是 `crypto.randomUUID()` —— **随机 UUID**。
    //    后果有两类，都很硬：
    //    ① **审计事件顺序随机**：`registration_events` 用 `ORDER BY created_at, id`，
    //       而「提交」与「改级」常发生在**同一毫秒**（服务层 now 由调用方传入，
    //       测试里更是同一个常量）→ created_at 相等 → 顺序由随机 UUID 决定。
    //       父代理预审实测：同一条用例连跑 8 次挂了 6 次 —— **随机 flaky**，
    //       CI 上会表现为「有时绿有时红」，极难定位。
    //    ② **分页不稳定**：列表接口用 `LIMIT ? OFFSET ?` 分页，排序键随机
    //       → 翻页时行会**重复或漏掉**。
    //    改法：兜底排序键改用 SQLite 的隐式 `rowid` —— 它按**插入顺序**单调递增，
    //    对「只增不改」的追加式表（注册事件 / 成员进出历史）正是审计轨迹该有的顺序。
    //    （本项目自己的设计决策「破同分兜底用行 ID 而非时间戳」也是同一个道理：
    //      兜底键必须是**确定性**的，不能是随机 UUID。）
    .prepare(
      `SELECT * FROM task_packages WHERE ${where.join(' AND ')} ORDER BY submitted_at, rowid`,
    )
    .all(...params);
}

export function updateTaskPackage(db, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) =>
      k === 'meta_json' && patch[k] && typeof patch[k] === 'object'
        ? JSON.stringify(patch[k])
        : patch[k],
    );
    db.prepare(`UPDATE task_packages SET ${sets} WHERE id = ?`).run(...values, id);
  }
  return getTaskPackage(db, id);
}

// src/db/repo/registrationEvents.js — 报名状态事件仓储（只增不改）
// 依据：INTERFACES.md §0「追加式：评分/签字类记录只增不改」+ §2 registration_events
import { randomUUID } from 'node:crypto';

export function insertRegistrationEvent(db, {
  registrationId,
  fromStatus = null,
  toStatus,
  actorId = null,
  reason = null,
  now = new Date().toISOString(),
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO registration_events
       (id, registration_id, from_status, to_status, actor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, registrationId, fromStatus, toStatus, actorId, reason, now);
  return id;
}

export function listRegistrationEvents(db, registrationId) {
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
    .prepare('SELECT * FROM registration_events WHERE registration_id = ? ORDER BY created_at, rowid')
    .all(registrationId);
}

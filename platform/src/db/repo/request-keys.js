// src/db/repo/request-keys.js — 幂等键
//
// 依据：设计文档 §11（幂等 + 行锁 + 只接受当前分配）。
//   ⛔ 一次批量提交会写入多行、它们共用同一个 request_id —— 所以幂等键不能直接建在
//      业务表的 request_id 列上（那样第二批就插不进去了）。
//   ✅ 正确做法：先在键表里「抢键」，抢到 = 首次生效；抢不到 = 重复请求 → 幂等短路。
//      唯一约束在数据库层，因此并发下不会双写。
//
// ⚠️ 父代理预审修正（2026-10-21，Important）：
//    「先抢键」与「写数据」必须放进**同一个事务** —— 否则写数据失败时键已经被占用，
//    客户端用同一个 requestId 重试会被判成「重复请求」而**静默丢数据**
//    （返回 submitted: 0，评委以为提交成功了，实际一条都没落库）。
//    事务边界由服务层负责（src/services/review.js）。
export function claimRequestKey(db, { scope, stageId, subjectId, requestId, now }) {
  try {
    db.prepare(
      `INSERT INTO review_request_keys (scope, stage_id, subject_id, request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, stageId, subjectId, requestId, now);
    return true;
  } catch (err) {
    // ⚠️ 只认「唯一约束」这一种失败 —— 其他错误必须继续往上抛，
    //    否则「磁盘满了」会被误判成「重复请求」。
    if (/UNIQUE constraint failed: review_request_keys/i.test(String(err.message))) return false;
    throw err;
  }
}

export function findRequestKey(db, { scope, stageId, subjectId, requestId }) {
  return db
    .prepare(
      `SELECT * FROM review_request_keys WHERE scope = ? AND stage_id = ? AND subject_id = ? AND request_id = ?`,
    )
    .get(scope, stageId, subjectId, requestId) ?? null;
}

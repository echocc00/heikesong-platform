-- 007_p13_defect_fixes.sql —— P13 缺陷修复的**约束补强**（2026-10-24）
--
-- 依据：2026-10-23 全量审计
--   · F25（Medium）幂等键**不绑定操作** ⇒ 同一个 requestId 换内容再提交，
--     返回**第一次**的响应，第二次申诉**从未提交**，而客户端被告知「成功」。
--   · F23（Medium）提交签字**可写两条** ⇒ 双击「提交签字」或失败后重试，
--     同一 (milestone, enterprise) 产生两条记录：工作台只看得见一条，
--     另一条**不可见但有效**，而 `revokeSignoff` 按单条 id 撤销 ⇒ 撤了可见的那条，另一条还在。
--
-- ⚠️ 这两条都属于「**数据库层是唯一保证**」的范畴：
--    服务层的「先查再插」在并发下挡不住两个同时通过的请求（两边都读到「不存在」）。
--    ⇒ 唯一约束必须落在数据库上。

-- ── ① F25：幂等键表加「请求体摘要」列 ──────────────────────────────
-- ⚠️ 为什么需要摘要：幂等键的 scope 是**调用方**（`appeal:${user.id}`）而不是**操作**，
--    且原来**没有任何请求体指纹** ⇒ 同一个 requestId 换了内容，命中的是同一条记录
--    ⇒ 直接返回首次响应（= 静默丢弃第二次的真实意图）。
--    ⇒ 加一列摘要 ⇒ 重放时比对，不一致就 409（口径与 P2 的 `assertSameRequestContent` 一致）。
--    ⚠️ 旧数据没有摘要（NULL）⇒ **不做比对**（不把历史记录误判成冲突）。
ALTER TABLE idempotency_keys ADD COLUMN request_digest TEXT;

-- ── ② F23：同一 (milestone_id, enterprise_id) 只允许一条**未撤回**的签字 ──
-- ⚠️ 为什么是**部分唯一索引**（`WHERE revoked_at IS NULL`）：签字是**只增不改**的
--    （撤回走 revoked_at 软删除）⇒ 被撤回之后**允许重新签**（这是产品语义，不是漏洞）
--    ⇒ 全表唯一索引会把合法的「撤回后重签」也挡掉。
--
-- ⚠️ 迁移前先处理**既有的重复行**：同一 (milestone, enterprise) 有多条未撤回签字时，
--    保留**最早**的那条（按 signed_at，再按 id 确定性打破），其余**标记为已撤回**
--    （= 作废，但**保留痕迹**，不物理删除 —— 签字表是审计留痕）。
--    ⇒ 不这么做，下面的唯一索引建不出来（迁移会直接失败 ⇒ 部署起不来）。
UPDATE milestone_signoffs
   SET revoked_at = signed_at
 WHERE revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM milestone_signoffs x
      WHERE x.milestone_id = milestone_signoffs.milestone_id
        AND x.enterprise_id = milestone_signoffs.enterprise_id
        AND x.revoked_at IS NULL
        AND (x.signed_at < milestone_signoffs.signed_at
             OR (x.signed_at = milestone_signoffs.signed_at AND x.id < milestone_signoffs.id))
   );

CREATE UNIQUE INDEX ux_milestone_signoffs_active
  ON milestone_signoffs(milestone_id, enterprise_id)
 WHERE revoked_at IS NULL;

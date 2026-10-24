-- 009_behavior_event_subject.sql —— 行为分事件加「主体」列（按里程碑计次）（2026-10-26）
--
-- 依据：M0-1「完赛线可达性」（2026-10-24 评审轮发现的业务规则缺陷）
--   · 修复前：behavior_events 的次数约束只按 (type) 记 ⇒ `milestone_on_time`
--     一支队伍**终身只能计一次**（5 分）⇒ 而一支队伍最多有 7 个里程碑
--     ⇒ 行为分上限 = 2×5（每周进度，赛程 31 天）+ 3 + 5 + 5 + 10 = **33 分**
--     ⇒ 完赛线 60 分**在真实赛程内不可达** ⇒ 没有任何队伍能被认定为完赛。
--   · 修复后：按**里程碑**计次（每个里程碑各计一次）⇒ 上限 = 10 + 3 + 5×7 + 5 + 10
--     = **63 分** ≥ 完赛线 60 ⇒ 满打满算的队伍恰能完赛。
--
-- ⚠ 为什么用**加列**而不是改表/加表：behavior_events 是**只增不改**的审计型表
--    （INTERFACES.md §0「追加式」）⇒ 只能加列，不能改既有行、不能删列。
--
-- ⚠ 主体列**可空**：迁移前的事件没有主体 ⇒ 落进「无主体桶」⇒ 仍受「终身一次」约束
--    （fail-closed）⇒ 不会被新口径放大成无限计分。
ALTER TABLE behavior_events ADD COLUMN subject_id TEXT;

-- ⚠ 排序/索引兜底一律用隐式 rowid（不用 id 列）——id 是 randomUUID()，顺序随机。
CREATE INDEX idx_behavior_events_subject ON behavior_events(team_id, type, subject_id);

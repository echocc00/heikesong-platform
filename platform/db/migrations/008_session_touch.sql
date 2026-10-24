-- 008_session_touch.sql —— 会话滑动续期改「脏才写」（2026-10-25）
--
-- 依据：2026-10-24 独立评审轮 P1-3a「拆掉读路径的隐性写库」
--   · 修复前：每次命中有效会话都执行 `UPDATE sessions SET expires_at = ?`
--     ⇒ **每个 GET 请求都产生一次写事务** ⇒ 纯读压测下写事务数随请求数线性增长。
--     ⇒ 读路径的写放大在评委打分窗口（几百并发只读页面）会把 SQLite 的写锁排起队。
--   · 修法：显式记一列「上次续期时刻」，只有距上次续期超过阈值才真的 UPDATE。
--
-- ⚠️ 为什么必须**显式存一列**，不能用 expires_at 反推「上次续期时刻」：
--    expires_at 会被「绝对过期上限」夹住（earlierIso）⇒ 反推出的续期时刻越来越旧
--    ⇒ 越接近绝对上限写得越频繁 ⇒ 等于白改。所以直接记 last_touch_at。
--
-- ⚠️ 老会话（迁移前签发的）没有这一列 ⇒ 用 created_at 回填
--    （created_at ≈ 当初那次续期时刻）⇒ 它们的第一次访问会续期一次，
--    之后转入「脏才写」。回填放在同一迁移里 ⇒ 不会留下 NULL 洞。
ALTER TABLE sessions ADD COLUMN last_touch_at TEXT;

UPDATE sessions SET last_touch_at = created_at WHERE last_touch_at IS NULL;

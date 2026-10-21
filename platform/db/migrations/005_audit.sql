-- 005_audit.sql — 审计与防作弊
-- 依据：INTERFACES.md §5（P4 产出）+ 设计文档 §11 / §12
-- ⚠️ 表名与列名逐字对齐 INTERFACES.md，不得擅自增删列。
-- ⛔ 评分/签字类记录只增不改；删除一律软删除（设计文档 §5.2 追加式决策）。

-- 检测器产出的人工复核项。⛔ 检测 ≠ 处罚：这里只记录"有疑问"，不记任何处罚结果。
CREATE TABLE flagged_reviews (
  id            TEXT PRIMARY KEY,
  stage_id      TEXT,
  submission_id TEXT,
  team_id       TEXT,
  judge_id      TEXT,
  kind          TEXT NOT NULL,   -- self_vs_judge | burst_submit | identical_peer_pattern | low_variance | multi_account | tied_mutual_peer_rate | reverse_audit
  detail_json   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | confirmed | rejected
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_flags_stage ON flagged_reviews(stage_id);
CREATE INDEX idx_flags_status ON flagged_reviews(status);
CREATE INDEX idx_flags_kind ON flagged_reviews(kind);

-- 幂等键：同一 request_id 重复提交只生效一次，重复请求返回首次的响应。
CREATE TABLE idempotency_keys (
  key           TEXT NOT NULL,
  scope         TEXT NOT NULL,
  request_id    TEXT,
  response_json TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (key, scope)
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);

-- 限频计数落库。⛔ 只在内存计数 = 进程重启即失效 = 等于没有限频。
-- bucket 的含义随 rule 变：s:<epoch秒> 滑动窗口 / m:<epoch分> 每分钟配额 /
-- h:<epoch时> 评委级每小时配额 / lock 提交锁。
CREATE TABLE rate_limit_events (
  id           TEXT PRIMARY KEY,
  subject_key  TEXT NOT NULL,
  rule         TEXT NOT NULL,
  bucket       TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (subject_key, rule, bucket)
);
CREATE INDEX idx_rl_lookup ON rate_limit_events(subject_key, rule, window_start);

-- 申诉：企业/选手对已定稿条目提出，走复核状态机。
CREATE TABLE appeals (
  id            TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL,   -- team_result
  subject_id    TEXT NOT NULL,   -- <stageId>:<teamId>
  filed_by      TEXT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted',  -- submitted | reviewing | accepted | rejected | withdrawn
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_appeals_subject ON appeals(subject_type, subject_id);
CREATE INDEX idx_appeals_status ON appeals(status);

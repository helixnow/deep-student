-- ============================================================================
-- V20260705: 为 document_tasks 补充 source_session_id 字段
-- ============================================================================
--
-- 该列此前由 legacy 数据库代码（database/mod.rs）在运行时通过
-- ALTER TABLE 动态添加，从未在治理迁移中声明，导致 schema 指纹漂移
-- （Verification failed: Schema fingerprint drift detected at v20260524）。
-- 本迁移将该列正式纳入治理体系：
-- - 旧库已存在该列时，coordinator 的 make_alter_columns_safe 会检测到
--   列已存在并直接标记本迁移完成（不会触发 duplicate column）。
-- - 新库则正常执行 ALTER。

ALTER TABLE document_tasks ADD COLUMN source_session_id TEXT;

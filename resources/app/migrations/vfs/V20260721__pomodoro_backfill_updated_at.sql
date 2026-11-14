-- ============================================================================
-- V20260721: 回填 pomodoro_records.updated_at
-- ============================================================================
--
-- V20260523 为 pomodoro_records 增加了 updated_at 同步列，但 create_record
-- 一直没有写入该列，历史行 updated_at 均为 NULL：
-- - LWW 冲突比较缺失基准时间；
-- - 依赖 idx_pomodoro_records_updated_not_deleted 的增量拉取会漏掉这些行。
--
-- 本迁移把 NULL 的 updated_at 回填为 created_at（记录创建后不可变，
-- created_at 即最后一次写入时间）。代码侧自 V20260721 起 INSERT 时
-- 同步写入 updated_at，软删除时推进 updated_at/local_version。
-- ============================================================================

UPDATE pomodoro_records
SET updated_at = created_at
WHERE updated_at IS NULL
  AND created_at IS NOT NULL;

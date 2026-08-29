-- Durable mastery outbox state on the already-transactional FSRS review log.
-- Existing reviews predate mastery emission and are treated as reconciled.
-- @danger-ack: add_not_null_column reason="mastery_revert_pending 提供 DEFAULT 0，SQLite 为历史行填充确定性非空值"
-- @danger-ack: add_column_backfill reason="迁移整体在单事务内执行不会留下半迁移状态；回填带 WHERE mastery_synced_at IS NULL，恢复重放幂等"
ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT;
ALTER TABLE fsrs_review_logs ADD COLUMN mastery_revert_pending INTEGER NOT NULL DEFAULT 0;
-- WHERE 使回填幂等：恢复重放（history 丢失后重放尾部迁移）时已回填的行
-- 不再触发 UPDATE，避免 __change_log 触发器重复登记 pending 变更。
UPDATE fsrs_review_logs
SET mastery_synced_at = COALESCE(updated_at, created_at, datetime('now'))
WHERE mastery_synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_mastery_pending
    ON fsrs_review_logs(mastery_revert_pending, mastery_synced_at, created_at)
    WHERE (mastery_synced_at IS NULL AND deleted_at IS NULL) OR mastery_revert_pending = 1;

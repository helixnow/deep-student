-- Durable mastery outbox state on the already-transactional FSRS review log.
-- Existing reviews predate mastery emission and are treated as reconciled.
ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT;
ALTER TABLE fsrs_review_logs ADD COLUMN mastery_revert_pending INTEGER NOT NULL DEFAULT 0;
UPDATE fsrs_review_logs
SET mastery_synced_at = COALESCE(updated_at, created_at, datetime('now'));
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_mastery_pending
    ON fsrs_review_logs(mastery_revert_pending, mastery_synced_at, created_at)
    WHERE (mastery_synced_at IS NULL AND deleted_at IS NULL) OR mastery_revert_pending = 1;

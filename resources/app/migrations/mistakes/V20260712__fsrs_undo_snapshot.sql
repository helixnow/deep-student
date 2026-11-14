-- ============================================================================
-- V20260712: Complete FSRS pre-review snapshots for safe undo
-- ============================================================================

-- Existing review rows intentionally remain NULL. They predate the complete
-- snapshot contract and therefore cannot be undone without guessing fields.
ALTER TABLE fsrs_review_logs ADD COLUMN state_before_json TEXT;

-- Undo validates that the caller-provided log is still the latest active log
-- for its scheduling state before restoring anything.
CREATE INDEX IF NOT EXISTS idx_fsrs_logs_state_active
    ON fsrs_review_logs(card_state_id, review_ms DESC, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

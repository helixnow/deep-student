-- ============================================================================
-- V20261125: mastery_states RFC-001 M2 lifecycle columns
-- ============================================================================
--
-- Brings the 5 lifecycle columns (`subject`, `error_tag`, `status`,
-- `mastered_at`, `relapse_count`) on `mastery_states` under migration
-- governance instead of runtime ALTER TABLE DDL, preventing schema
-- fingerprint drift on restart.
--
-- @danger-ack: add_not_null_column reason="status defaults to 'active' and relapse_count defaults to 0; SQLite supplies deterministic non-null values for every existing mastery_states row"
-- ============================================================================

ALTER TABLE mastery_states ADD COLUMN subject TEXT;
ALTER TABLE mastery_states ADD COLUMN error_tag TEXT;
ALTER TABLE mastery_states ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE mastery_states ADD COLUMN mastered_at TEXT;
ALTER TABLE mastery_states ADD COLUMN relapse_count INTEGER NOT NULL DEFAULT 0;

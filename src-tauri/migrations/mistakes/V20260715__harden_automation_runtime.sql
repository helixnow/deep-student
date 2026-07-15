-- ============================================================================
-- V20260715: Harden automation claims, recovery, and explicit retries
-- ============================================================================

ALTER TABLE automation_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE automation_runs ADD COLUMN retry_requested INTEGER NOT NULL DEFAULT 0
    CHECK (retry_requested IN (0, 1));

-- Older builds ran with SQLite foreign keys disabled, so remove historical
-- children that cannot be associated with a definition before enforcing FKs.
DELETE FROM automation_runs
WHERE NOT EXISTS (
    SELECT 1
    FROM automation_definitions
    WHERE automation_definitions.id = automation_runs.automation_id
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_owner_lease
    ON automation_runs(status, claimed_by, lease_expires_at);

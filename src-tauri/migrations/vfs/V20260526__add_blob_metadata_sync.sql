-- ============================================================================
-- V20260526: Add row-level sync coverage for VFS blob metadata
-- ============================================================================
--
-- The raw blob bytes are synchronized by the content-addressed file sync layer,
-- but rows in files.blob_hash still depend on blobs.hash through a foreign key.
-- Without change-log coverage for blobs, a fresh device can receive files rows
-- before the referenced blob metadata exists and fail the whole download batch.
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg__change_log_blobs_insert
AFTER INSERT ON blobs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('blobs', NEW.hash, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_blobs_update
AFTER UPDATE ON blobs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('blobs', NEW.hash, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_blobs_delete
AFTER DELETE ON blobs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('blobs', OLD.hash, 'DELETE');
END;

-- Backfill existing blob metadata for users who already have files before this
-- migration. Re-uploading these small metadata rows is safe and necessary for
-- new-device hydration.
INSERT INTO __change_log (table_name, record_id, operation)
SELECT 'blobs', blobs.hash, 'INSERT'
FROM blobs
WHERE NOT EXISTS (
    SELECT 1
    FROM __change_log
    WHERE table_name = 'blobs'
      AND record_id = blobs.hash
      AND sync_version = 0
);

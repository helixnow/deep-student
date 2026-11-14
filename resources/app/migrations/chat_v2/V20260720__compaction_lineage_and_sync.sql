-- Make compaction lineage durable, inspectable, and syncable.

ALTER TABLE chat_v2_compactions ADD COLUMN previous_compaction_id TEXT;
ALTER TABLE chat_v2_compactions ADD COLUMN range_start_message_id TEXT;
ALTER TABLE chat_v2_compactions ADD COLUMN range_end_message_id TEXT;
ALTER TABLE chat_v2_compactions ADD COLUMN compacted_message_count INTEGER;
ALTER TABLE chat_v2_compactions ADD COLUMN model_config_id TEXT;

ALTER TABLE chat_v2_compactions ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_compactions ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_compactions ADD COLUMN updated_at TEXT;
ALTER TABLE chat_v2_compactions ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_v2_compactions_previous
    ON chat_v2_compactions(previous_compaction_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_compactions_local_version
    ON chat_v2_compactions(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_compactions_device_version
    ON chat_v2_compactions(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_compactions_sync_updated_at
    ON chat_v2_compactions(updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_compactions_updated_not_deleted
    ON chat_v2_compactions(updated_at) WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg__change_log_compactions_insert
AFTER INSERT ON chat_v2_compactions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_compactions', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_compactions_update
AFTER UPDATE ON chat_v2_compactions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_compactions', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_compactions_delete
AFTER DELETE ON chat_v2_compactions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_compactions', OLD.id, 'DELETE');
END;

-- Existing compactions predate row sync. Touch them after installing the UPDATE trigger so
-- they enter the change log and become available on the user's other devices.
UPDATE chat_v2_compactions
SET updated_at = COALESCE(
        updated_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch')
    ),
    local_version = COALESCE(local_version, 0) + 1
WHERE updated_at IS NULL;

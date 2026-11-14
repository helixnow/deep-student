-- Mastery evidence is user data. Sync the append-only source table; the
-- mastery_states aggregate is rebuilt locally from these events.

ALTER TABLE mastery_events ADD COLUMN device_id TEXT;
ALTER TABLE mastery_events ADD COLUMN local_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mastery_events ADD COLUMN updated_at TEXT;
ALTER TABLE mastery_events ADD COLUMN deleted_at TEXT;

UPDATE mastery_events SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mastery_events_local_version
    ON mastery_events(local_version);
CREATE INDEX IF NOT EXISTS idx_mastery_events_updated_at
    ON mastery_events(updated_at);
CREATE INDEX IF NOT EXISTS idx_mastery_events_device_version
    ON mastery_events(device_id, local_version);

CREATE TRIGGER IF NOT EXISTS trg__change_log_mastery_events_insert
AFTER INSERT ON mastery_events
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('mastery_events', NEW.id, 'INSERT', datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_mastery_events_update
AFTER UPDATE ON mastery_events
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('mastery_events', NEW.id, 'UPDATE', datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_mastery_events_delete
AFTER DELETE ON mastery_events
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('mastery_events', OLD.id, 'DELETE', datetime('now'));
END;

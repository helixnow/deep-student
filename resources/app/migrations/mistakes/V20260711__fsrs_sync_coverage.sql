-- ============================================================================
-- V20260711: FSRS sync coverage and orphan cleanup
-- ============================================================================

-- fsrs_card_states already has created_at / updated_at from V20260709.
ALTER TABLE fsrs_card_states ADD COLUMN device_id TEXT;
ALTER TABLE fsrs_card_states ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE fsrs_card_states ADD COLUMN deleted_at TEXT;

-- Review logs need stable timestamps in addition to the standard sync columns.
ALTER TABLE fsrs_review_logs ADD COLUMN created_at TEXT;
ALTER TABLE fsrs_review_logs ADD COLUMN updated_at TEXT;
ALTER TABLE fsrs_review_logs ADD COLUMN device_id TEXT;
ALTER TABLE fsrs_review_logs ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE fsrs_review_logs ADD COLUMN deleted_at TEXT;

UPDATE fsrs_review_logs
SET created_at = COALESCE(
        created_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', review_ms / 1000.0, 'unixepoch')
    ),
    updated_at = COALESCE(
        updated_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', review_ms / 1000.0, 'unixepoch')
    )
WHERE created_at IS NULL OR updated_at IS NULL;

-- Remove pre-existing rows whose parent card/state no longer exists. Logs must
-- be deleted first because they reference both the card and its scheduling row.
DELETE FROM fsrs_review_logs
WHERE NOT EXISTS (
    SELECT 1
    FROM anki_cards a
    WHERE a.id = fsrs_review_logs.anki_card_id
)
   OR NOT EXISTS (
        SELECT 1
        FROM fsrs_card_states s
        WHERE s.id = fsrs_review_logs.card_state_id
    );

DELETE FROM fsrs_card_states
WHERE NOT EXISTS (
    SELECT 1
    FROM anki_cards a
    WHERE a.id = fsrs_card_states.anki_card_id
);

-- Standard incremental-sync indexes.
CREATE INDEX IF NOT EXISTS idx_anki_decks_local_version
    ON anki_decks(local_version);
CREATE INDEX IF NOT EXISTS idx_anki_decks_deleted_at
    ON anki_decks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_anki_decks_device_id
    ON anki_decks(device_id);
CREATE INDEX IF NOT EXISTS idx_anki_decks_sync_updated_at
    ON anki_decks(updated_at);
CREATE INDEX IF NOT EXISTS idx_anki_decks_device_version
    ON anki_decks(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_anki_decks_updated_not_deleted
    ON anki_decks(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fsrs_card_states_local_version
    ON fsrs_card_states(local_version);
CREATE INDEX IF NOT EXISTS idx_fsrs_card_states_deleted_at
    ON fsrs_card_states(deleted_at);
CREATE INDEX IF NOT EXISTS idx_fsrs_card_states_device_id
    ON fsrs_card_states(device_id);
CREATE INDEX IF NOT EXISTS idx_fsrs_card_states_sync_updated_at
    ON fsrs_card_states(updated_at);
CREATE INDEX IF NOT EXISTS idx_fsrs_card_states_device_version
    ON fsrs_card_states(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_fsrs_card_states_updated_not_deleted
    ON fsrs_card_states(updated_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_local_version
    ON fsrs_review_logs(local_version);
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_deleted_at
    ON fsrs_review_logs(deleted_at);
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_device_id
    ON fsrs_review_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_sync_updated_at
    ON fsrs_review_logs(updated_at);
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_device_version
    ON fsrs_review_logs(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_fsrs_review_logs_updated_not_deleted
    ON fsrs_review_logs(updated_at) WHERE deleted_at IS NULL;

-- Incremental change-log triggers for all three FSRS tables.
CREATE TRIGGER IF NOT EXISTS trg__change_log_anki_decks_insert
AFTER INSERT ON anki_decks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('anki_decks', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_anki_decks_update
AFTER UPDATE ON anki_decks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('anki_decks', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_anki_decks_delete
AFTER DELETE ON anki_decks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('anki_decks', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_fsrs_card_states_insert
AFTER INSERT ON fsrs_card_states
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('fsrs_card_states', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_fsrs_card_states_update
AFTER UPDATE ON fsrs_card_states
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('fsrs_card_states', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_fsrs_card_states_delete
AFTER DELETE ON fsrs_card_states
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('fsrs_card_states', OLD.id, 'DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_fsrs_review_logs_insert
AFTER INSERT ON fsrs_review_logs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('fsrs_review_logs', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_fsrs_review_logs_update
AFTER UPDATE ON fsrs_review_logs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('fsrs_review_logs', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_fsrs_review_logs_delete
AFTER DELETE ON fsrs_review_logs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('fsrs_review_logs', OLD.id, 'DELETE');
END;

-- These tables predate their RowSync registration. Publish every existing row
-- once so a device that goes offline before the next full snapshot cannot miss
-- the initial state. A pending entry from a live trigger or crash replay wins.
INSERT INTO __change_log (table_name, record_id, operation)
SELECT 'anki_decks', d.id, 'INSERT'
FROM anki_decks d
WHERE NOT EXISTS (
    SELECT 1
    FROM __change_log c
    WHERE c.table_name = 'anki_decks'
      AND c.record_id = d.id
      AND c.sync_version = 0
);

INSERT INTO __change_log (table_name, record_id, operation)
SELECT 'fsrs_card_states', s.id, 'INSERT'
FROM fsrs_card_states s
WHERE NOT EXISTS (
    SELECT 1
    FROM __change_log c
    WHERE c.table_name = 'fsrs_card_states'
      AND c.record_id = s.id
      AND c.sync_version = 0
);

INSERT INTO __change_log (table_name, record_id, operation)
SELECT 'fsrs_review_logs', l.id, 'INSERT'
FROM fsrs_review_logs l
WHERE NOT EXISTS (
    SELECT 1
    FROM __change_log c
    WHERE c.table_name = 'fsrs_review_logs'
      AND c.record_id = l.id
      AND c.sync_version = 0
);

-- Direct SQL deletes and ON DELETE CASCADE paths must not leave schedulable
-- state behind. The child DELETE triggers above also publish these removals.
CREATE TRIGGER IF NOT EXISTS trg_fsrs_cleanup_before_anki_card_delete
BEFORE DELETE ON anki_cards
BEGIN
    DELETE FROM fsrs_review_logs WHERE anki_card_id = OLD.id;
    DELETE FROM fsrs_card_states WHERE anki_card_id = OLD.id;
END;

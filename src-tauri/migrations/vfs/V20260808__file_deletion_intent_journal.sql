-- Durable prepare -> ready -> published journal for local blob/asset deletion.
--
-- The historical __blob_deletion_queue / __asset_deletion_queue tables remain
-- the ready-only sync outbox.  Existing drain code can therefore never observe
-- a prepared operation.  Successful outbox deletion marks every corresponding
-- ready journal operation as published in the same SQLite transaction.

CREATE TABLE IF NOT EXISTS __file_deletion_journal (
    operation_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('blob', 'asset')),
    entity_key TEXT NOT NULL,
    local_path TEXT NOT NULL,
    expected_hash TEXT,
    size INTEGER,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'ready', 'published', 'cancelled')),
    prepared_at TEXT NOT NULL,
    ready_at TEXT,
    published_at TEXT,
    cancelled_at TEXT,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx__file_deletion_journal_recovery
    ON __file_deletion_journal(target_kind, state, prepared_at);

CREATE INDEX IF NOT EXISTS idx__file_deletion_journal_target
    ON __file_deletion_journal(target_kind, entity_key, state);

CREATE TRIGGER IF NOT EXISTS trg__blob_deletion_queue_published
AFTER DELETE ON __blob_deletion_queue
BEGIN
    UPDATE __file_deletion_journal
       SET state = 'published',
           published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           last_error = NULL
     WHERE target_kind = 'blob'
       AND entity_key = OLD.hash
       AND state = 'ready';
END;

CREATE TRIGGER IF NOT EXISTS trg__asset_deletion_queue_published
AFTER DELETE ON __asset_deletion_queue
BEGIN
    UPDATE __file_deletion_journal
       SET state = 'published',
           published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           last_error = NULL
     WHERE target_kind = 'asset'
       AND entity_key = OLD.key
       AND state = 'ready';
END;

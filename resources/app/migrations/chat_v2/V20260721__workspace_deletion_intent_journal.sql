-- Durable prepare -> ready -> published journal for workspace database deletion.
--
-- __workspace_deletion_queue remains the ready-only sync outbox for backward
-- compatibility.  Removing an outbox row after a successful cloud publish
-- advances the durable journal atomically.

CREATE TABLE IF NOT EXISTS __file_deletion_journal (
    operation_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind = 'workspace'),
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

CREATE TRIGGER IF NOT EXISTS trg__workspace_deletion_queue_published
AFTER DELETE ON __workspace_deletion_queue
BEGIN
    UPDATE __file_deletion_journal
       SET state = 'published',
           published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           last_error = NULL
     WHERE target_kind = 'workspace'
       AND entity_key = OLD.workspace_id
       AND state = 'ready';
END;

-- Retention is local policy; changing it never deletes history in this migration.
CREATE TABLE IF NOT EXISTS note_history_retention (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    edit_bucket_seconds INTEGER NOT NULL CHECK (edit_bucket_seconds BETWEEN 0 AND 86400),
    max_edit_versions INTEGER CHECK (max_edit_versions BETWEEN 1 AND 100000),
    updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO note_history_retention VALUES (1, 300, 100, '');

-- Local save-as identity and per-CAS-step receipts survive response loss/restart.
-- No cascading FK: deletion of a copy must not make a retry create a second copy.
CREATE TABLE IF NOT EXISTS note_review_save_operations (
    operation_id TEXT PRIMARY KEY,
    source_note_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_review_save_receipts (
    operation_id TEXT NOT NULL REFERENCES note_review_save_operations(operation_id),
    expected_updated_at TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (operation_id, expected_updated_at)
);

-- History identity is version_id, never local seq. Pruning/pins remain local:
-- deliberately no history DELETE/UPDATE trigger (no remote prune or pin echo).
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_revisions_insert
AFTER INSERT ON note_document_revisions BEGIN
    INSERT INTO __change_log(table_name,record_id,operation)
    VALUES ('note_document_revisions',NEW.version_id,'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_formats_insert
AFTER INSERT ON note_document_formats BEGIN
    INSERT INTO __change_log(table_name,record_id,operation)
    VALUES ('note_document_formats',NEW.note_id,'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_formats_update
AFTER UPDATE ON note_document_formats BEGIN
    INSERT INTO __change_log(table_name,record_id,operation)
    VALUES ('note_document_formats',NEW.note_id,'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_formats_delete
AFTER DELETE ON note_document_formats BEGIN
    INSERT INTO __change_log(table_name,record_id,operation)
    VALUES ('note_document_formats',OLD.note_id,'DELETE');
END;

-- Existing retained history must become uploadable even if its note is never
-- edited again. Re-running the migration does not duplicate pending receipts.
INSERT INTO __change_log(table_name,record_id,operation)
SELECT 'note_document_revisions',r.version_id,'INSERT' FROM note_document_revisions r
WHERE NOT EXISTS(SELECT 1 FROM __change_log c WHERE c.table_name='note_document_revisions'
    AND c.record_id=r.version_id AND COALESCE(c.sync_version,0)=0);
INSERT INTO __change_log(table_name,record_id,operation)
SELECT 'note_document_formats',f.note_id,'INSERT' FROM note_document_formats f
WHERE NOT EXISTS(SELECT 1 FROM __change_log c WHERE c.table_name='note_document_formats'
    AND c.record_id=f.note_id AND COALESCE(c.sync_version,0)=0);

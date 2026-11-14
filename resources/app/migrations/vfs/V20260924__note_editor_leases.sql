-- RowSync uses the same table + record identity for replay log suppression.
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_learning_relations_insert
AFTER INSERT ON note_learning_relations BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('note_learning_relations',NEW.id,'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_learning_relations_update
AFTER UPDATE ON note_learning_relations BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('note_learning_relations',NEW.id,'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_learning_relations_delete
AFTER DELETE ON note_learning_relations BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('note_learning_relations',OLD.id,'DELETE');
END;
CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_revisions_pin
AFTER UPDATE OF pinned ON note_document_revisions WHEN OLD.pinned != NEW.pinned BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('note_document_revisions',NEW.version_id,'UPDATE');
END;
INSERT INTO __change_log(table_name,record_id,operation)
SELECT 'note_learning_relations',r.id,'INSERT' FROM note_learning_relations r
WHERE NOT EXISTS(SELECT 1 FROM __change_log c WHERE c.table_name='note_learning_relations' AND c.record_id=r.id AND COALESCE(c.sync_version,0)=0);
INSERT INTO __change_log(table_name,record_id,operation)
SELECT 'note_document_revisions',r.version_id,'UPDATE' FROM note_document_revisions r
WHERE r.pinned=1 AND NOT EXISTS(SELECT 1 FROM __change_log c WHERE c.table_name='note_document_revisions' AND c.record_id=r.version_id AND COALESCE(c.sync_version,0)=0);

-- Local coordination only. Never upload these five tables. Identity is one
-- mounted editor, bound by IPC to its actual WebView/window, not supplied labels.
CREATE TABLE IF NOT EXISTS note_editor_participants (
    id TEXT PRIMARY KEY, webview_label TEXT NOT NULL, window_label TEXT NOT NULL,
    note_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_editor_participants_note ON note_editor_participants(note_id);
CREATE TABLE IF NOT EXISTS note_editor_leases (
    token TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('pending','ready','refreshing')),
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_editor_lease_notes (
    note_id TEXT PRIMARY KEY, token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_editor_lease_notes_token ON note_editor_lease_notes(token);
CREATE TABLE IF NOT EXISTS note_editor_lease_acks (
    token TEXT NOT NULL, participant_id TEXT NOT NULL,
    draft_json TEXT, refreshed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(token,participant_id)
);
-- Exists only inside the same write transaction as an authorized operation.
-- SQLite's writer lock prevents another connection from observing this grant.
CREATE TABLE IF NOT EXISTS note_editor_write_grants (token TEXT PRIMARY KEY);

CREATE TRIGGER IF NOT EXISTS trg_note_lease_write_scope
BEFORE UPDATE ON notes WHEN EXISTS(SELECT 1 FROM note_editor_write_grants)
AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g JOIN note_editor_lease_notes ln ON ln.token=g.token WHERE ln.note_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'notes.lease_scope'); END;

CREATE TRIGGER IF NOT EXISTS trg_note_lease_note_update
BEFORE UPDATE ON notes WHEN EXISTS (
    SELECT 1 FROM note_editor_lease_notes ln JOIN note_editor_leases l ON l.token=ln.token
    WHERE ln.note_id=OLD.id AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g WHERE g.token=l.token)
) BEGIN SELECT RAISE(ABORT,'notes.lease_conflict'); END;
CREATE TRIGGER IF NOT EXISTS trg_note_lease_note_delete
BEFORE DELETE ON notes WHEN EXISTS (
    SELECT 1 FROM note_editor_lease_notes ln WHERE ln.note_id=OLD.id
) BEGIN SELECT RAISE(ABORT,'notes.lease_conflict'); END;
CREATE TRIGGER IF NOT EXISTS trg_note_lease_resource_update
BEFORE UPDATE OF data,deleted_at ON resources WHEN EXISTS (
    SELECT 1 FROM notes n JOIN note_editor_lease_notes ln ON ln.note_id=n.id
    WHERE n.resource_id=OLD.id AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g WHERE g.token=ln.token)
) BEGIN SELECT RAISE(ABORT,'notes.lease_conflict'); END;
CREATE TRIGGER IF NOT EXISTS trg_note_lease_resource_delete
BEFORE DELETE ON resources WHEN EXISTS (
    SELECT 1 FROM notes n JOIN note_editor_lease_notes ln ON ln.note_id=n.id
    WHERE n.resource_id=OLD.id AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g WHERE g.token=ln.token)
) BEGIN SELECT RAISE(ABORT,'notes.lease_conflict'); END;

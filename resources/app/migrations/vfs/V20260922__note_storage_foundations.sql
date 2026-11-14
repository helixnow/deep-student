-- Local document format gate and immutable pre-migration baseline.
CREATE TABLE IF NOT EXISTS note_document_formats (
    note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    content_format TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    serializer_version TEXT NOT NULL,
    baseline_version_id TEXT,
    updated_at TEXT NOT NULL
);

-- Local transaction receipts. Bodies and asset refs are retained for exact undo.
CREATE TABLE IF NOT EXISTS note_transfer_operations (
    operation_id TEXT PRIMARY KEY,
    source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    request_json TEXT NOT NULL,
    source_before TEXT NOT NULL,
    target_before TEXT NOT NULL,
    asset_refs_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    undo_result_json TEXT,
    created_at TEXT NOT NULL
);

-- One CAS row per review/draft; tombstones preserve revisions against ABA.
CREATE TABLE IF NOT EXISTS note_state (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    state_type TEXT NOT NULL CHECK (state_type IN ('review','draft')),
    state_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (note_id, state_type, state_key)
);

-- Persistent semantic relationships. Keep missing targets as invalid references.
-- Deliberately no target FK: a deleted target must remain visible to the user.
CREATE TABLE IF NOT EXISTS note_learning_relations (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    block_id TEXT,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('source','card','mistake')),
    resource_id TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    invalidated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_learning_relations_note ON note_learning_relations(note_id, id);
CREATE INDEX IF NOT EXISTS idx_note_learning_relations_resource ON note_learning_relations(resource_id);
CREATE TRIGGER IF NOT EXISTS trg_note_relations_resource_deleted
AFTER DELETE ON resources BEGIN
    UPDATE note_learning_relations SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revision = revision + 1
    WHERE resource_id = OLD.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_note_relations_resource_trashed
AFTER UPDATE OF deleted_at ON resources WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE note_learning_relations SET invalidated_at = NEW.deleted_at,
        updated_at = NEW.deleted_at, revision = revision + 1
    WHERE resource_id = NEW.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_note_relations_note_trashed
AFTER UPDATE OF deleted_at ON notes WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE note_learning_relations SET invalidated_at = NEW.deleted_at,
        updated_at = NEW.deleted_at, revision = revision + 1
    WHERE resource_id = NEW.resource_id AND invalidated_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_note_relations_file_trashed
AFTER UPDATE OF deleted_at ON files WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE note_learning_relations SET invalidated_at = NEW.deleted_at,
        updated_at = NEW.deleted_at, revision = revision + 1
    WHERE resource_id = NEW.resource_id AND invalidated_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_note_relations_exam_trashed
AFTER UPDATE OF deleted_at ON exam_sheets WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE note_learning_relations SET invalidated_at = NEW.deleted_at,
        updated_at = NEW.deleted_at, revision = revision + 1
    WHERE resource_id = NEW.resource_id AND invalidated_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_note_relations_question_trashed
AFTER UPDATE OF deleted_at ON questions WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE note_learning_relations SET invalidated_at = NEW.deleted_at,
        updated_at = NEW.deleted_at, revision = revision + 1
    WHERE json_extract(locator_json,'$.type') = 'question'
        AND json_extract(locator_json,'$.value') = NEW.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_note_relations_question_deleted
AFTER DELETE ON questions BEGIN
    UPDATE note_learning_relations SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revision = revision + 1
    WHERE json_extract(locator_json,'$.type') = 'question'
        AND json_extract(locator_json,'$.value') = OLD.id AND invalidated_at IS NULL;
END;

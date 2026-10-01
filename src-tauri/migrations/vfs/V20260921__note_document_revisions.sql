-- Local, full-document history. Never points at reclaimable resources.
-- The latest seq is the local head; do not add local history pointers to RowSync notes.
CREATE TABLE IF NOT EXISTS note_document_revisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT NOT NULL UNIQUE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    parent_version_id TEXT,
    restored_from_version_id TEXT,
    title TEXT NOT NULL,
    content_md TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    props_json TEXT,
    asset_refs_json TEXT NOT NULL,
    content_format TEXT NOT NULL DEFAULT 'markdown-legacy',
    format_version INTEGER NOT NULL DEFAULT 1,
    serializer_version TEXT NOT NULL DEFAULT 'markdown-v1',
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edit_bucket INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_note_revisions_timeline
    ON note_document_revisions(note_id, seq DESC);
-- Protect fixed versions even when a caller purges via a different repo or sync.
CREATE TRIGGER IF NOT EXISTS trg_note_revisions_protect_purge
BEFORE DELETE ON notes
WHEN EXISTS (SELECT 1 FROM note_document_revisions WHERE note_id = OLD.id AND pinned = 1)
BEGIN
    SELECT RAISE(ABORT, '笔记包含已保留的历史版本，不能永久删除');
END;

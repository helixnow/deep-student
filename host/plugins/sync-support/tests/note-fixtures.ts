/** SQLite fixtures only. Note behavior is always supplied by the installed L10 plugin. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export const MINIMAL_NOTES_SCHEMA = `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]', is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT, props TEXT
  );
  CREATE TABLE resources (id TEXT PRIMARY KEY, data TEXT, type TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE note_document_formats (
    note_id TEXT PRIMARY KEY, content_format TEXT NOT NULL, format_version INTEGER NOT NULL,
    serializer_version TEXT NOT NULL, baseline_version_id TEXT, updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE note_document_revisions (
    version_id TEXT NOT NULL UNIQUE, note_id TEXT NOT NULL, parent_version_id TEXT,
    restored_from_version_id TEXT, title TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, content_bytes INTEGER NOT NULL DEFAULT 0, content_md TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]', props_json TEXT, asset_refs_json TEXT NOT NULL DEFAULT '[]',
    content_format TEXT NOT NULL DEFAULT 'markdown-legacy', format_version INTEGER NOT NULL DEFAULT 1,
    serializer_version TEXT NOT NULL DEFAULT 'markdown-v1', seq INTEGER PRIMARY KEY AUTOINCREMENT,
    edit_bucket INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE note_learning_relations (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, relation_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    locator_json TEXT NOT NULL, block_id TEXT, revision INTEGER NOT NULL DEFAULT 0,
    invalidated_at TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE note_history_retention (
    id INTEGER PRIMARY KEY, edit_bucket_seconds INTEGER NOT NULL, max_edit_versions INTEGER, updated_at TEXT NOT NULL
  );
  INSERT INTO note_history_retention VALUES (1, 0, NULL, '');
`;

export function seedNote(db: SqlExecutor, id: string, resourceId: string, content: string, title = 'Fixture'): void {
  const now = '2026-08-01T00:00:00Z';
  db.run("INSERT INTO resources(id,data,type,updated_at) VALUES(?1,?2,'note',?3)", [resourceId, content, now]);
  db.run('INSERT INTO notes(id,resource_id,title,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)', [id, resourceId, title, now]);
  db.run(`INSERT INTO note_document_formats(note_id,content_format,format_version,serializer_version,updated_at)
    VALUES(?1,'markdown-legacy',1,'markdown-v1',?2)`, [id, now]);
}

export function setResourceContent(db: SqlExecutor, resourceId: string, content: string): void {
  db.run('UPDATE resources SET data=?1, updated_at=?2 WHERE id=?3', [content, '2026-08-02T00:00:00Z', resourceId]);
}

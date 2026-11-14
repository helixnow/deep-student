import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsDatabaseStats } from '../api.ts';

export const foreignKeys = defineQuery('PRAGMA foreign_keys');
export const schemaVersion = defineQuery('SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history');
export const statistics = defineQuery<void, Omit<VfsDatabaseStats, 'schema_version'>>(`SELECT
  (SELECT COUNT(*) FROM resources) AS resource_count,
  (SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL) AS note_count,
  (SELECT COUNT(*) FROM files WHERE status = 'active') AS textbook_count,
  (SELECT COUNT(*) FROM exam_sheets) AS exam_count,
  (SELECT COUNT(*) FROM translations) AS translation_count,
  (SELECT COUNT(*) FROM essays) AS essay_count,
  (SELECT COUNT(*) FROM blobs) AS blob_count`);

export function readSchemaVersion(conn: SqlExecutor): number {
  try { return conn.pluck<number>(schemaVersion) ?? 0; }
  catch { return 0; } // Rust query_row(...).unwrap_or(0), database.rs:428-434.
}

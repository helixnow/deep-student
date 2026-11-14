/** Read-only queries owned by builtin_resource_executor/content_helpers. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { resolveFileIdForReadWithConn } from './resources.ts';
export function sourceIdForResource(conn: SqlExecutor, type: string, resourceId: string): string | null {
  const sql: Record<string, string> = {
    notes: 'SELECT id FROM notes WHERE resource_id = ?1 LIMIT 1',
    files: 'SELECT id FROM files WHERE resource_id = ?1 LIMIT 1',
    exams: 'SELECT id FROM exam_sheets WHERE resource_id = ?1 LIMIT 1',
    essays: 'SELECT id FROM essays WHERE resource_id = ?1 ORDER BY updated_at DESC LIMIT 1',
    translations: 'SELECT id FROM translations WHERE resource_id = ?1 LIMIT 1',
    mindmaps: 'SELECT id FROM mindmaps WHERE resource_id = ?1 LIMIT 1',
  };
  const query = sql[type];
  if (query === undefined) return null;
  try { return conn.pluck<string>(query, [resourceId]) ?? null; }
  catch { return null; }
}
export function ocrJsonForResource(conn: SqlExecutor, id: string): string | null {
  const fileId = resolveFileIdForReadWithConn(conn, id) ?? id;
  try { return conn.pluck<string | null>('SELECT ocr_pages_json FROM files WHERE id = ?1 OR resource_id = ?1 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1', [fileId]) ?? null; }
  catch { return null; }
}

/** SQL for the PDF commands whose repositories are not published by another lane. */
import { defineQuery } from '../../../platform/storage/query.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

const pendingPdfIds = defineQuery<[number], { id: string }>(
  `SELECT id FROM files
   WHERE mime_type = 'application/pdf'
     AND status = 'active'
     AND (processing_status = 'pending' OR processing_status IS NULL)
   ORDER BY created_at DESC
   LIMIT ?1`,
  { name: 'vfs.handlers.pendingPdfIds' },
);

const filePreview = defineQuery<[string], { preview_json: string | null }>(
  'SELECT preview_json FROM files WHERE resource_id = ?1',
  { name: 'vfs.handlers.filePreview' },
);

const examPreview = defineQuery<[string], { preview_json: string | null }>(
  'SELECT preview_json FROM exam_sheets WHERE resource_id = ?1',
  { name: 'vfs.handlers.examPreview' },
);

export function pendingPdfFileIds(conn: SqlExecutor, limit: number): string[] {
  return conn.all(pendingPdfIds, [limit]).map(row => row.id);
}

/** handlers.rs:2960-3000 — preview_json by resources.source_table. */
export function previewJsonForSource(
  conn: SqlExecutor,
  resourceId: string,
  sourceTable: string | null,
): { previewJson: string | null; errorPrefix: string } | null {
  const errorPrefix = sourceTable === 'textbooks' ? '查询教材 preview_json 失败'
    : sourceTable === 'files' ? '查询附件 preview_json 失败'
      : sourceTable === 'exam_sheets' ? '查询题目集 preview_json 失败' : null;
  if (errorPrefix === null) return null;
  try {
    const row = conn.get(sourceTable === 'exam_sheets' ? examPreview : filePreview, [resourceId]);
    // Rust query_row::<String> rejects SQL NULL; optional() only covers no row.
    if (row?.preview_json === null) throw new Error('Invalid column type Null at index: 0, name: preview_json');
    return { previewJson: row?.preview_json ?? null, errorPrefix };
  } catch (error) { throw new Error(`${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`); }
}

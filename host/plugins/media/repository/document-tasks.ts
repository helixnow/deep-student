/**
 * `dstu-storage/src/database/mod.rs:7350 get_recent_document_tasks` 的只读 SQL。
 * 主库（`mistakes`）里的文档任务，按 `updated_at` 倒序、排除软删除。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface DocumentTaskRow {
  id: string;
  document_id: string;
  original_document_name: string;
  segment_index: number;
  content_segment: string;
  status: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  anki_generation_options_json: string;
}

export function recentDocumentTaskRows(conn: SqlExecutor, limit: number): DocumentTaskRow[] {
  return conn.all<DocumentTaskRow>(
    `SELECT id, document_id, original_document_name, segment_index, content_segment,
            status, created_at, updated_at, error_message, anki_generation_options_json
     FROM document_tasks
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT ?1`,
    [limit],
  );
}

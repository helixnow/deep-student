/**
 * `dstu-media/src/media/{commands,pipeline}.rs` reads: media file rows, task
 * state. The `files.extracted_text` write goes through L11
 * `files.setMediaExtractedTextWithConn`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface MediaFileRow {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  resource_id: string | null;
}

export interface MediaTaskRow {
  status: string | null;
  progress_json: string | null;
  error: string | null;
}

/** `pipeline.rs::load_media_file`（`res_*` 也按 `resource_id` 反查）。 */
export function loadMediaFileRow(conn: SqlExecutor, id: string): MediaFileRow | null {
  return conn.get<MediaFileRow>(
    "SELECT id, file_name, COALESCE(mime_type, '') AS mime_type, COALESCE(size, 0) AS size, resource_id "
    + 'FROM files WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NULL '
    + 'ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1',
    [id],
  ) ?? null;
}

/** `commands.rs::load_task_row`。 */
export function loadMediaTaskRow(conn: SqlExecutor, fileId: string): MediaTaskRow {
  return conn.get<MediaTaskRow>(
    'SELECT processing_status AS status, processing_progress AS progress_json, '
    + 'processing_error AS error FROM files WHERE id = ?1',
    [fileId],
  ) ?? { status: null, progress_json: null, error: null };
}

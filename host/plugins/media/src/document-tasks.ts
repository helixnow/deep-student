/**
 * `dstu-storage/src/database/mod.rs:7350 get_recent_document_tasks`: read-only
 * view of the main (`mistakes`) database for the card-generation recovery UI.
 * Rows are ordered by `updated_at` descending and exclude soft-deleted tasks.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import { recentDocumentTaskRows } from '../repository/document-tasks.ts';

const TASK_STATUSES = [
  'Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled',
] as const;

type TaskStatus = DocumentTask['status'];

/** `TaskStatus::from_str`：未知字符串回落到 `Pending`。 */
export function documentTaskStatus(raw: string): TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(raw) ? raw as TaskStatus : 'Pending';
}

export function recentDocumentTasks(conn: SqlExecutor, limit: number): DocumentTask[] {
  return recentDocumentTaskRows(conn, limit).map(row => ({
    id: row.id,
    document_id: row.document_id,
    original_document_name: row.original_document_name,
    segment_index: row.segment_index,
    content_segment: row.content_segment,
    status: documentTaskStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    error_message: row.error_message,
    anki_generation_options_json: row.anki_generation_options_json,
  }));
}

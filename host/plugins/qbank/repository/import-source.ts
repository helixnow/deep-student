/** SQL of `chat_v2/tools/qbank_import_source.rs`. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** qbank_import_source.rs:166 — the note whose content resource is `resourceId`. */
export function noteIdForResource(db: SqlExecutor, resourceId: string): string | null {
  return db.pluck<string>('SELECT id FROM notes WHERE resource_id = ?1 LIMIT 1', [resourceId]) ?? null;
}

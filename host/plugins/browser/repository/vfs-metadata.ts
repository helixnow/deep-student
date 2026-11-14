// VFS resource metadata update for `builtin-webpage_save`.
// Rust performs this inline in `index_webpage_executor.rs`; in the Host the SQL
// stays in the owning plugin's repository layer.

import type { SqlExecutor } from '../../../platform/storage/api.ts';

export function updateResourceMetadata(
  conn: SqlExecutor, resourceId: string, metadataJson: string, updatedAt: number,
): void {
  conn.run(
    'UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3',
    [metadataJson, updatedAt, resourceId],
  );
}

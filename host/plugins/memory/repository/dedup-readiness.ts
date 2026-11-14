/** Rust service.rs:2444-2492,2645-2671: read-only index-readiness aggregation. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { getFolderIdsRecursive } from './vfs.ts';

export function countActiveMemories(db: SqlExecutor, rootId: string): number {
  const folders = getFolderIdsRecursive(db, rootId);
  if (folders.length === 0) return 0;
  return Math.max(0, db.pluck<number>(String.raw`SELECT COUNT(DISTINCT n.id)
    FROM notes n JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
    WHERE fi.folder_id IN (${folders.map(() => '?').join(', ')})
      AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
      AND n.title NOT LIKE '\_\_%\_\_%' ESCAPE '\'`, folders) ?? 0);
}

export function countIndexedMemoryUnits(db: SqlExecutor, rootId: string): number {
  const folders = getFolderIdsRecursive(db, rootId);
  if (folders.length === 0) return 0;
  return Math.max(0, db.pluck<number>(String.raw`SELECT COUNT(*)
    FROM vfs_index_units u JOIN notes n ON n.resource_id = u.resource_id
    JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
    WHERE fi.folder_id IN (${folders.map(() => '?').join(', ')})
      AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
      AND n.title NOT LIKE '\_\_%\_\_%' ESCAPE '\'`, folders) ?? 0);
}

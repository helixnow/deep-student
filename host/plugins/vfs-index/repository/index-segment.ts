/** Orphan queue SQL, mirroring `vfs_index_segment_repo::enqueue_lance_orphan`. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { requireVfsTableOwners } from './owners.ts';

export function enqueueLanceOrphan(
  db: SqlExecutor,
  lanceRowId: string,
  resourceId: string | null,
): void {
  requireVfsTableOwners(db).embeddingSegments.enqueueLanceOrphan(db, lanceRowId, resourceId);
}

export function deleteLanceOrphan(db: SqlExecutor, lanceRowId: string): void {
  db.run('DELETE FROM __lance_orphan_queue WHERE lance_row_id = ?1', [lanceRowId]);
}

/** Port of index_unit_repo.rs `purge_index_artifacts_by_resource`. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { databaseResult } from './errors.ts';

/**
 * Enqueues every segment's Lance row id for the resource, then deletes the
 * resource's index units (segments follow via FK CASCADE). Returns deleted units.
 */
export function purgeIndexArtifactsByResource(conn: SqlExecutor, resourceId: string): number {
  return databaseResult(() => {
    conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
       SELECT s.lance_row_id, u.resource_id
       FROM vfs_index_segments s
       JOIN vfs_index_units u ON s.unit_id = u.id
       WHERE u.resource_id = ?1
       ON CONFLICT(lance_row_id) DO UPDATE SET
           resource_id = excluded.resource_id,
           enqueued_at = excluded.enqueued_at,
           next_retry_at = 0,
           last_error = NULL`, [resourceId]);
    return conn.run('DELETE FROM vfs_index_units WHERE resource_id = ?1', [resourceId]).changes;
  });
}

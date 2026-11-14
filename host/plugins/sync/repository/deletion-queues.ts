/** commands_sync.rs:408-480,519-587,625-680. No retry-count abandonment. */
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
export type DeletionKind = 'blob' | 'asset' | 'workspace';
const keys = { blob: 'hash', asset: 'key', workspace: 'workspace_id' } as const;
export interface QueuedDeletion { id: string; path: string | null; size: bigint | null; deletedAt: string }
export function readDeletionQueue(db: SqlExecutor, kind: DeletionKind): QueuedDeletion[] {
  const table = `__${kind}_deletion_queue`;
  let exists;
  try { exists = db.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]); }
  catch { return []; }
  if (!exists) return [];
  const columns = kind === 'workspace' ? `${keys[kind]} AS id, deleted_at` : kind === 'blob' ? 'hash AS id, relative_path, size, deleted_at' : 'key AS id, size, deleted_at';
  const rows = db.all(defineQuery<[], Record<string, unknown>>(`SELECT ${columns} FROM ${table} ORDER BY retry_count ASC, deleted_at ASC LIMIT 500`, { options: { safeIntegers: true } }), []);
  const result: QueuedDeletion[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.deleted_at !== 'string') continue;
    if (kind === 'blob' && row.relative_path !== null && typeof row.relative_path !== 'string') continue;
    if (kind !== 'workspace' && row.size !== null && typeof row.size !== 'bigint') continue;
    result.push({ id: row.id, path: kind === 'blob' ? row.relative_path as string | null : null,
      size: typeof row.size === 'bigint' && row.size >= 0n ? row.size : null, deletedAt: row.deleted_at });
  }
  return result;
}
export function finishDeletionQueue(db: SqlExecutor, kind: DeletionKind, ids: readonly string[], success: boolean): void {
  const table = `__${kind}_deletion_queue`;
  for (const id of ids) {
    try {
      db.run(success ? `DELETE FROM ${table} WHERE ${keys[kind]}=?1`
        : `UPDATE ${table} SET retry_count=retry_count+1 WHERE ${keys[kind]}=?1`, [id]);
    } catch { // boundary-allow empty-catch: commands_sync.rs:463,476,571,584,664,677 uses let _ = conn.execute without logging.
    }
  }
}

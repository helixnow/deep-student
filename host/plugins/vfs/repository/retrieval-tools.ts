/** builtin_retrieval_executor.rs:1127-1161: read-only memory-note exclusion and session mount scope expansion. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';

export function memoryNoteResourceIdsWithConn(conn: SqlExecutor, folders: readonly string[]): Set<string> {
  if (folders.length === 0) return new Set();
  const rows = conn.all<{ resource_id: unknown }>(`SELECT DISTINCT n.resource_id FROM notes n
    JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
    WHERE fi.folder_id IN (${folders.map(() => '?').join(', ')}) AND n.deleted_at IS NULL`, folders);
  return new Set(rows.flatMap(row => typeof row.resource_id === 'string' ? [row.resource_id] : []));
}

export function expandSessionRagFolderScopeWithConn(
  conn: SqlExecutor,
  repos: VfsReposService,
  scope: readonly string[],
): string[] {
  if (repos.studySpaces !== undefined) {
    return repos.studySpaces.resolveMountScopeForFolders(conn, scope).effectiveFolderIds.sort();
  }
  const expanded = new Set<string>();
  for (const folder of scope) {
    expanded.add(folder);
    try {
      for (const id of repos.folders.getFolderIdsRecursive(conn, folder)) expanded.add(id);
    } catch {
      continue;
    }
  }
  return [...expanded].sort();
}

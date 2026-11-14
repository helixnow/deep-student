// chat_v2 主库的 workspace_index 同步 SQL（coordinator.rs 的 sync_to_index 等）。
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface WorkspaceIndexRecord {
  id: string;
  name: string | null;
  status: string;
  creatorSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export function upsertWorkspaceIndex(db: SqlExecutor, record: WorkspaceIndexRecord): void {
  db.run(
    `INSERT OR REPLACE INTO workspace_index (workspace_id, name, status, creator_session_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [record.id, record.name, record.status, record.creatorSessionId, record.createdAt, record.updatedAt],
  );
}

export function deleteWorkspaceIndex(db: SqlExecutor, workspaceId: string): void {
  db.run('DELETE FROM workspace_index WHERE workspace_id = ?1', [workspaceId]);
}

export function updateWorkspaceIndexStatus(
  db: SqlExecutor,
  workspaceId: string,
  status: string,
  updatedAt: string,
): void {
  db.run('UPDATE workspace_index SET status = ?1, updated_at = ?2 WHERE workspace_id = ?3', [
    status, updatedAt, workspaceId,
  ]);
}

export function workspaceIndexExists(db: SqlExecutor, workspaceId: string): boolean {
  const value = db.pluck<number>(
    `SELECT EXISTS(
         SELECT 1 FROM workspace_index WHERE workspace_id = ?1
     )`,
    [workspaceId],
  );
  return Number(value ?? 0) !== 0;
}

export function readyOrPublishedDeletionExists(db: SqlExecutor, workspaceId: string): boolean {
  const value = db.pluck<number>(
    `SELECT EXISTS(
         SELECT 1 FROM __file_deletion_journal
          WHERE target_kind = 'workspace'
            AND entity_key = ?1
            AND state IN ('ready', 'published')
     )`,
    [workspaceId],
  );
  return Number(value ?? 0) !== 0;
}

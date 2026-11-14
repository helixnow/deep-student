import { Slot, type Disposer } from '../../kernel/api.ts';
import type { SqlExecutor } from './api.ts';

/** L05 owns workspace_index; the caller lends its existing savepoint connection. */
export type WorkspaceIndexDeletionOwner = (conn: SqlExecutor, workspaceId: string) => void;

const workspaceIndexOwner = new Slot<WorkspaceIndexDeletionOwner>();

/** Register during L05 apply; retain/dispose with that plugin's scope. */
export function registerWorkspaceIndexDeletionOwner(owner: WorkspaceIndexDeletionOwner): Disposer {
  return workspaceIndexOwner.provide(owner);
}

/** Internal F3 call site, after the prepared row and before savepoint release. */
export function deleteWorkspaceIndexWithOwner(conn: SqlExecutor, workspaceId: string): void {
  const owner = workspaceIndexOwner.get();
  if (!owner) throw new Error('workspace index deletion owner is not registered');
  owner(conn, workspaceId);
}

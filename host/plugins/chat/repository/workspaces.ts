/**
 * `workspace_index` reads used by `workspace_list_all`
 * (workspace_handlers.rs:1022-1074). The index table lives in the chat_v2 DB.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { WorkspaceInfo } from '../api.ts';
import { errorText } from '../src/logger.ts';

const ACTIVE_WORKSPACES = `SELECT workspace_id AS id, name, status, creator_session_id, created_at, updated_at
    FROM workspace_index WHERE status = 'active' ORDER BY created_at DESC`;

export function listActiveWorkspaceIndex(db: SqlExecutor): WorkspaceInfo[] {
  // SqlExecutor combines preparation and stepping. EXPLAIN compiles the same
  // query without reading rows, preserving Rust's separate preparation error.
  try { db.all(`EXPLAIN ${ACTIVE_WORKSPACES}`); }
  catch (error) { throw new Error(`Failed to prepare statement: ${errorText(error)}`); }
  let rows: WorkspaceInfo[];
  try { rows = db.all<WorkspaceInfo>(ACTIVE_WORKSPACES); }
  catch (error) { throw new Error(`Failed to query workspaces: ${errorText(error)}`); }
  // query_map(...).flatten(): invalid String/Option<String> rows are skipped.
  return rows.filter(row => typeof row.id === 'string'
    && (row.name === null || typeof row.name === 'string')
    && typeof row.status === 'string' && typeof row.creator_session_id === 'string'
    && typeof row.created_at === 'string' && typeof row.updated_at === 'string');
}

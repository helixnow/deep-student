/**
 * Super 会话状态机读的 chat_v2 表（state.rs:278–295, 461–478 的 SQL）。
 *
 * 只做只读查询；会话的增改仍走 `chatSession`（避免第二份会话行映射）。
 * 两条 SQL 与 Rust 逐字一致：
 * - 活跃 Super：`persist_status='active'` 且 `json_extract($.super_agent.active)=1`，
 *   `ORDER BY created_at DESC, rowid DESC`（最新优先）；
 * - 硬删后定位工作区：`workspace_index.creator_session_id` + `name`。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { SUPER_WORKSPACE_NAME, type SuperSessionLookup } from '../src/super-state.ts';

/** state.rs:278–295：所有活跃 Super 会话 id，最新在前。 */
export function listActiveSuperIds(db: SqlExecutor): string[] {
  const rows = db.all<{ id: unknown }>(`SELECT id FROM chat_v2_sessions
    WHERE persist_status = 'active'
      AND (CASE WHEN json_valid(metadata_json)
                THEN json_extract(metadata_json, '$.super_agent.active')
           END) = 1
    ORDER BY created_at DESC, rowid DESC`);
  return rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));
}

/** state.rs:461–478：由该会话创建、名为 Super-agent 的工作区。 */
export function superWorkspaceIdsCreatedBy(db: SqlExecutor, sessionId: string): string[] {
  const rows = db.all<{ workspace_id: unknown }>(
    'SELECT workspace_id FROM workspace_index WHERE creator_session_id = ?1 AND name = ?2',
    [sessionId, SUPER_WORKSPACE_NAME],
  );
  return rows.flatMap((row) => (typeof row.workspace_id === 'string' ? [row.workspace_id] : []));
}

export function createSuperSessionLookup(db: SqlExecutor): SuperSessionLookup {
  return {
    listActiveSuperIds: () => listActiveSuperIds(db),
    workspacesCreatedBy: (sessionId) => superWorkspaceIdsCreatedBy(db, sessionId),
  };
}

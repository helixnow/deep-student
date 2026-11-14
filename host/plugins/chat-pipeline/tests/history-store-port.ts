/** External L04 hydration/sidecar reads until owner API is integrated. No L03 replay logic is duplicated. */
import type { ChatSessionService } from '../../chat/api.ts';
import type { PipelineHistoryStore, BlockReplayData } from '../api.ts';
import type { PipelinePersistenceStore } from '../src/persistence-port.ts';

export function historyStorePort(sessions: ChatSessionService, persistence: PipelinePersistenceStore): PipelineHistoryStore {
  return {
    getSessionMessageIdsWithConn: (_conn, sessionId) => sessions.getSessionMessages(sessionId).map(m => m.id),
    getMessagesByIdsWithConn: (_conn, _sessionId, ids) => ids.map(id => sessions.getMessage(id)!),
    getHistoryBlocksWithReplayWithConn(conn, ids) {
      const replay = new Map<string, BlockReplayData>();
      const groups = new Map(ids.map(id => [id, persistence.getMessageBlocksWithConn(conn, id)]));
      for (const id of ids) {
        for (const row of conn.all<{ id: string; llmContent: string | null; toolCallId: string | null; roundText: string | null }>(
          'SELECT id, llm_content AS llmContent, tool_call_id AS toolCallId, round_text AS roundText FROM chat_v2_blocks WHERE message_id = ?', [id])) {
          replay.set(row.id, { llmContent: row.llmContent, toolCallId: row.toolCallId, roundText: row.roundText });
        }
      }
      return [groups, replay];
    },
    getMessageBlocksWithConn: (conn, id) => persistence.getMessageBlocksWithConn(conn, id),
    getActiveCompactionWithConn: () => null,
    getCompactionSummaryMessageIdsWithConn: () => [],
    markAvailableSkillsSnapshotStaleWithConn: () => null,
  };
}

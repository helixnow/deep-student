/** L04 owner-only reads required by history.rs. Caller passes conn, never executes owner SQL. */
import type { ChatMessage } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { BlockReplayData } from '../api.ts';
import type { PersistenceBlock } from './persistence-port.ts';

export interface HistoryCompactionRecord {
  id: string;
  summaryMessageId: string;
  tailStartMessageId: string;
  rangeEndMessageId: string | null;
}
export interface PipelineHistoryStore {
  getSessionMessageIdsWithConn(conn: SqlExecutor, sessionId: string): string[];
  getMessagesByIdsWithConn(conn: SqlExecutor, sessionId: string, messageIds: string[]): ChatMessage[];
  getHistoryBlocksWithReplayWithConn(conn: SqlExecutor, messageIds: readonly string[]):
    [Map<string, PersistenceBlock[]>, Map<string, BlockReplayData>];
  getMessageBlocksWithConn(conn: SqlExecutor, messageId: string): PersistenceBlock[];
  getActiveCompactionWithConn(conn: SqlExecutor, sessionId: string): HistoryCompactionRecord | null;
  /** Requested IDs-only compaction-artifact lookup, compaction.rs:1504–1514. */
  getCompactionSummaryMessageIdsWithConn(conn: SqlExecutor, sessionId: string): string[];
  markAvailableSkillsSnapshotStaleWithConn(conn: SqlExecutor, sessionId: string): number | bigint | null;
}

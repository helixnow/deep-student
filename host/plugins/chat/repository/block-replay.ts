/** Rust repo.rs:2084-2211. Sidecar methods retain the caller's transaction. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { databaseOperation } from './errors.ts';
import type { ChatLogger } from '../src/logger.ts';

export interface BlockReplayData { llmContent: string | null; toolCallId: string | null; roundText: string | null }

function empty(replay: BlockReplayData): boolean {
  return replay.llmContent === null && replay.toolCallId === null && replay.roundText === null;
}

/** rusqlite Option<String> conversions; empty and malformed sidecars are omitted. */
export function replayFromColumns(row: { llm_content: unknown; tool_call_id: unknown; round_text: unknown }): BlockReplayData | null {
  if ([row.llm_content, row.tool_call_id, row.round_text].some(value => value !== null && typeof value !== 'string')) return null;
  const replay = { llmContent: row.llm_content as string | null,
    toolCallId: row.tool_call_id as string | null, roundText: row.round_text as string | null };
  return empty(replay) ? null : replay;
}
export function isMissingReplayColumn(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no such column');
}

export function updateBlockReplay(db: SqlExecutor, blockId: string, replay: BlockReplayData,
  log: Pick<ChatLogger, 'debug'>): void {
  if (empty(replay)) return;
  databaseOperation(() => {
    try {
      db.run('UPDATE chat_v2_blocks SET llm_content = ?2, tool_call_id = ?3, round_text = ?4 WHERE id = ?1',
        [blockId, replay.llmContent, replay.toolCallId, replay.roundText]);
    } catch (error) {
      if (!isMissingReplayColumn(error)) throw error;
      log.debug(`[ChatV2::Repo] Replay columns missing (V20260806 not applied), skipping sidecar write for block ${blockId}`);
    }
  });
}

export function getBlockReplayMap(db: SqlExecutor, messageId: string): Map<string, BlockReplayData> {
  return databaseOperation(() => {
    let rows: { id: string; llm_content: unknown; tool_call_id: unknown; round_text: unknown }[];
    try {
      rows = db.all('SELECT id, llm_content, tool_call_id, round_text FROM chat_v2_blocks WHERE message_id = ?1', [messageId]);
    } catch (error) {
      if (!isMissingReplayColumn(error)) throw error;
      return new Map();
    }
    const map = new Map<string, BlockReplayData>();
    for (const row of rows) {
      // Rust rows.flatten(): failed Option<String> conversions are silently skipped.
      if (typeof row.id !== 'string') continue;
      const replay = replayFromColumns(row);
      if (replay !== null) map.set(row.id, replay);
    }
    return map;
  });
}

export function clearBlockLlmContent(db: SqlExecutor, blockId: string): void {
  databaseOperation(() => {
    try { db.run('UPDATE chat_v2_blocks SET llm_content = NULL WHERE id = ?1', [blockId]); }
    catch (error) { if (!isMissingReplayColumn(error)) throw error; }
  });
}

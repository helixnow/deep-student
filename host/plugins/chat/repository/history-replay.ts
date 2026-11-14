/** Rust repo.rs:2000-2072: bounded history block/replay batches and legacy-column fallback. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { BLOCK_COLUMNS, rowToBlock, type BlockRow, type StoredBlock } from './blocks.ts';
import { isMissingReplayColumn, replayFromColumns, type BlockReplayData } from './block-replay.ts';
import { databaseOperation } from './errors.ts';
import { errorText, type ChatLogger } from '../src/logger.ts';

export function getHistoryBlocksWithReplay(db: SqlExecutor, messageIds: readonly string[],
  log: ChatLogger): [Map<string, StoredBlock[]>, Map<string, BlockReplayData>] {
  return databaseOperation(() => {
    const blocks = new Map<string, StoredBlock[]>();
    const replay = new Map<string, BlockReplayData>();
    let hasReplayColumns = true;
    for (let start = 0; start < messageIds.length; start += 400) {
      const chunk = messageIds.slice(start, start + 400);
      const sql = () => `SELECT ${BLOCK_COLUMNS}${hasReplayColumns ? ', llm_content, tool_call_id, round_text' : ''}
        FROM chat_v2_blocks WHERE message_id IN (${chunk.map(() => '?').join(',')}) ORDER BY message_id, block_index ASC`;
      type Row = BlockRow & { llm_content: unknown; tool_call_id: unknown; round_text: unknown };
      let rows: Row[];
      try { rows = db.all<Row>(sql(), chunk); }
      catch (error) {
        if (!hasReplayColumns || !isMissingReplayColumn(error)) throw error;
        hasReplayColumns = false;
        rows = db.all<Row>(sql(), chunk);
      }
      for (const row of rows) {
        let block: StoredBlock;
        try { block = rowToBlock(row); }
        catch (error) {
          log.warn('[ChatV2Repo] Skipping malformed history block: ' + errorText(error));
          continue;
        }
        const sidecar = hasReplayColumns ? replayFromColumns(row) : null;
        if (sidecar !== null) replay.set(block.id, sidecar);
        const list = blocks.get(block.messageId) ?? [];
        list.push(block); blocks.set(block.messageId, list);
      }
    }
    return [blocks, replay];
  });
}

/** External L04 repository replacement only. The L03 save/selection/transaction logic is never replaced. */
import { vi } from 'vitest';
import { ChatV2Error } from '../../chat/api.ts';
import type { PipelinePersistenceStore, PersistenceBlock } from '../src/persistence-port.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

function ownerWrite(operation: () => void): void {
  try { operation(); }
  catch (error) { throw new ChatV2Error('Database', error instanceof Error ? error.message : String(error)); }
}

export function persistenceStorePort(): PipelinePersistenceStore {
  return {
    // L04 owns construction. This fixture supplies simple prepared values, not the code under test.
    buildUserMessage: vi.fn<PipelinePersistenceStore['buildUserMessage']>(params => ({
      message: { id: params.id!, sessionId: params.sessionId, role: 'user',
        blockIds: [`fixture_content_${params.id}`], timestamp: params.timestamp! },
      block: { id: `fixture_content_${params.id}`, messageId: params.id!, type: 'content',
        status: 'success', content: params.content, blockIndex: 0 },
    })),
    createMessageWithConn: vi.fn<PipelinePersistenceStore['createMessageWithConn']>((conn, message) => ownerWrite(() => {
      conn.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, meta_json)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        block_ids_json=excluded.block_ids_json, timestamp=excluded.timestamp, meta_json=excluded.meta_json`,
      [message.id, message.sessionId, message.role, JSON.stringify(message.blockIds), message.timestamp,
        message._meta == null ? null : JSON.stringify(message._meta)]);
    })),
    createBlockWithConn: vi.fn<PipelinePersistenceStore['createBlockWithConn']>((conn, block) => ownerWrite(() => {
      conn.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, content, block_index,
        tool_name, tool_input_json, tool_output_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content, status=excluded.status,
          block_index=excluded.block_index, tool_output_json=excluded.tool_output_json, error=excluded.error`,
      [block.id, block.messageId, block.type, block.status, block.content ?? null, block.blockIndex,
        block.toolName ?? null, block.toolInput == null ? null : JSON.stringify(block.toolInput),
        block.toolOutput == null ? null : JSON.stringify(block.toolOutput), block.error ?? null]);
    })),
    getMessageBlocksWithConn: vi.fn<PipelinePersistenceStore['getMessageBlocksWithConn']>((conn, messageId) => conn.all<PersistenceBlock>(
      `SELECT id, message_id AS messageId, block_type AS type, status, content, block_index AS blockIndex
       FROM chat_v2_blocks WHERE message_id = ? ORDER BY block_index`, [messageId])),
    listBlockPositionsWithConn: vi.fn((conn: SqlExecutor, messageId: string, type: string) =>
      conn.all<{ block_index: number; id: string }>(
        'SELECT block_index, id FROM chat_v2_blocks WHERE message_id = ? AND block_type = ?',
        [messageId, type]).map(row => [row.block_index, row.id] as [number, string])),
    updateBlockReplayWithConn: vi.fn<PipelinePersistenceStore['updateBlockReplayWithConn']>((conn, blockId, replay) => ownerWrite(() => {
      conn.run('UPDATE chat_v2_blocks SET llm_content = ?, tool_call_id = ?, round_text = ? WHERE id = ?',
        [replay.llmContent, replay.toolCallId, replay.roundText, blockId]);
    })),
  };
}

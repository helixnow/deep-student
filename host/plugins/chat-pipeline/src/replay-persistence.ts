/** L03 persistence.rs:423–537. L04 owns all replay-column SQL and compatibility. */
import type { Context } from '@deepseek-ai/cordis';
import type { MessageBlock } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ReplaySidecarWriter } from '../api.ts';
import type { PipelineContext } from './pipeline-context.ts';

export type ReadMessageBlocks = (conn: SqlExecutor, messageId: string) => readonly Pick<MessageBlock, 'id' | 'type'>[];

export function existingUserContentBlockId(conn: SqlExecutor, readBlocks: ReadMessageBlocks,
  userMessageId: string): string | null {
  try {
    return readBlocks(conn, userMessageId).find(block => block.type === 'content')?.id ?? null;
  } catch { return null; } // Rust get_message_blocks_with_conn(...).ok()? silently skips lookup errors.
}

export function persistUserLlmContentEarly(execution: PipelineContext, getConnection: () => SqlExecutor,
  readBlocks: ReadMessageBlocks,
  writer: ReplaySidecarWriter, logger: Pick<Context['logger'], 'debug'>): void {
  const llmContent = execution.liveUserLlmContent();
  if (llmContent === null) {
    logger.debug(`[ChatV2::pipeline] persist_user_llm_content_early: no compiled user message yet, skip (session=${execution.sessionId})`);
    return;
  }
  const conn = getConnection();
  const blockId = existingUserContentBlockId(conn, readBlocks, execution.userMessageId);
  if (blockId === null) {
    logger.debug(`[ChatV2::pipeline] persist_user_llm_content_early: user content block not found (message=${execution.userMessageId}), skip — target row missing; later save points may retry if the block exists`);
    return;
  }
  writer.updateBlockReplayWithConn(conn, blockId, { llmContent, toolCallId: null, roundText: null });
  logger.debug(`[ChatV2::pipeline] persist_user_llm_content_early: llm_content persisted before first provider request (message=${execution.userMessageId}, block=${blockId})`);
}

export function persistReplaySidecar(conn: SqlExecutor, execution: PipelineContext,
  userBlockId: string | null, dirtyBlocks: ReadonlySet<string> | null, writer: ReplaySidecarWriter): void {
  const llmContent = execution.liveUserLlmContent();
  if (userBlockId !== null && llmContent !== null) {
    writer.updateBlockReplayWithConn(conn, userBlockId, { llmContent, toolCallId: null, roundText: null });
  }
  for (const result of execution.toolResults) {
    const blockId = result.blockId;
    if (blockId == null || (dirtyBlocks !== null && !dirtyBlocks.has(blockId))) continue;
    const toolCallId = result.toolCallId;
    if (toolCallId == null || toolCallId === '') continue;
    writer.updateBlockReplayWithConn(conn, blockId, { llmContent: null, toolCallId,
      roundText: execution.roundTextByToolCallId.get(toolCallId) ?? null });
  }
}

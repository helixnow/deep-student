/**
 * 停止生成后按存档对齐消息内容。
 *
 * 用户点停止后，前端先把会话置为 aborting/idle，此后到达的块事件不再进入 store；
 * 而 Host 在真正处理取消之前仍可能落盘一个片段（取消本身在 Host 侧是同步的，
 * stream_cancelled 发出时存档已是终态）。因此收到 stream_cancelled 后读回该消息的存档，
 * 补上界面缺失的块、补全被截断的块内容。只增不删：存档没有而界面有的内容保持原样。
 */
import { invoke } from '@tauri-apps/api/core';
import type { BlockStatus, BlockType, LoadSessionResponseType } from '../../core/types';
import type { LoadMessagesPageResponseType, TauriAdapterHost } from './adapterHost';

export type CancelAlignmentHost = Pick<
  TauriAdapterHost,
  'sessionId' | 'store' | 'getCurrentState' | 'setupGeneration' | 'historyWindowStartOffset' | 'isSessionRuntimeOwner'
>;

type ArchivedBlock = LoadSessionResponseType['blocks'][number];

/** 目标消息前后各留一条余量，避免窗口起点与 store 顺序有细微偏差时漏取。 */
const PAGE_MARGIN = 1;

async function loadArchivedMessage(host: CancelAlignmentHost, messageId: string) {
  const index = host.store.getOrderedMessages().findIndex((m) => m.id === messageId);
  if (index >= 0) {
    const offset = Math.max(0, host.historyWindowStartOffset + index - PAGE_MARGIN);
    const page = await invoke<LoadMessagesPageResponseType>('chat_v2_load_messages_page', {
      sessionId: host.sessionId,
      offset,
      limit: PAGE_MARGIN * 2 + 1,
    });
    const message = page?.messages?.find((m) => m.id === messageId);
    if (message) return { message, blocks: page.blocks ?? [] };
  }
  const full = await invoke<LoadSessionResponseType>('chat_v2_load_session', { sessionId: host.sessionId });
  const message = full?.messages?.find((m) => m.id === messageId);
  return message ? { message, blocks: full?.blocks ?? [] } : null;
}

/** @returns 新增或补全的块数 */
export async function alignCancelledMessageWithArchive(host: CancelAlignmentHost, messageId: string): Promise<number> {
  const generation = host.setupGeneration;
  const archived = await loadArchivedMessage(host, messageId);
  if (!archived || generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) return 0;
  // 多变体消息的块挂在变体上，按消息追加会放错位置；交给下次加载会话恢复。
  if ((archived.message.variants?.length ?? 0) > 1) return 0;

  const state = host.getCurrentState();
  if (state.currentStreamingMessageId === messageId) return 0;

  const order = new Map(archived.message.blockIds.map((id, i) => [id, i]));
  const blocks = archived.blocks
    .filter((b) => b.messageId === messageId && order.has(b.id))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  let changed = 0;
  for (const blk of blocks) {
    const live = state.blocks.get(blk.id);
    if (!live) {
      host.store.createBlockWithId(messageId, blk.type as BlockType, blk.id);
      host.store.updateBlock(blk.id, archivedFields(blk));
      changed += 1;
      continue;
    }
    const visible = live.content ?? '';
    if (typeof blk.content === 'string' && blk.content.length > visible.length && blk.content.startsWith(visible)) {
      host.store.updateBlock(blk.id, { content: blk.content });
      changed += 1;
    }
  }
  return changed;
}

function archivedFields(blk: ArchivedBlock) {
  return {
    status: blk.status as BlockStatus,
    content: blk.content,
    toolName: blk.toolName,
    toolInput: blk.toolInput as Record<string, unknown> | undefined,
    toolOutput: blk.toolOutput,
    citations: blk.citations,
    error: blk.error,
    startedAt: blk.startedAt,
    endedAt: blk.endedAt,
    firstChunkAt: blk.firstChunkAt,
  };
}

/**
 * Chat V2 - ankiCards 事件处理：mediaReport / _qa_flags 数据流测试
 *
 * 覆盖点：
 * - patch chunk 中的 mediaReport 合入 toolOutput
 * - onEnd result 中的 mediaReport 合入 toolOutput
 * - 重放 start 事件（幂等复用路径）不丢 mediaReport 等既有字段
 * - 卡片 extra_fields 中的 _qa_flags 原样透传（供前端结构化展示）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eventRegistry } from '@/features/chat/registry/eventRegistry';
import type { ChatStore, Block } from '@/features/chat/core/types';

// 导入插件（触发自动注册）
import '@/features/chat/plugins/events/ankiCards';

function createLeanStore(): ChatStore {
  const blocks = new Map<string, Block>();
  return {
    sessionId: 'sess-media',
    messageMap: new Map(),
    blocks,
    activeBlockIds: new Set(),
    createBlock: vi.fn((messageId: string, type: string) => {
      const blockId = `${type}-block-1`;
      blocks.set(blockId, { id: blockId, type, status: 'pending', messageId } as Block);
      return blockId;
    }),
    createBlockWithId: vi.fn((messageId: string, type: string, blockId: string) => {
      blocks.set(blockId, { id: blockId, type, status: 'pending', messageId } as Block);
      return blockId;
    }),
    updateBlock: vi.fn((blockId: string, patch: Partial<Block>) => {
      const block = blocks.get(blockId);
      if (block) Object.assign(block, patch);
    }),
    updateBlockStatus: vi.fn((blockId: string, status: Block['status']) => {
      const block = blocks.get(blockId);
      if (block) block.status = status;
    }),
    setBlockError: vi.fn((blockId: string, error: string) => {
      const block = blocks.get(blockId);
      if (block) {
        block.status = 'error';
        block.error = error;
      }
    }),
  } as unknown as ChatStore;
}

const MEDIA_REPORT = {
  declared: 2,
  imported: 1,
  skipped: 1,
  skips: [{ reason: 'entry_missing', count: 1, filenames: ['a.png'] }],
};

describe('ankiCards event handler: mediaReport & _qa_flags flow', () => {
  let store: ChatStore;
  const handler = () => eventRegistry.get('anki_cards')!;

  beforeEach(() => {
    store = createLeanStore();
  });

  it('merges mediaReport from a patch chunk into toolOutput', () => {
    const blockId = handler().onStart!(store, 'msg-1', { blockType: 'anki_cards' });
    handler().onChunk!(
      store,
      blockId,
      JSON.stringify({ mediaReport: MEDIA_REPORT, documentId: 'doc-1' }),
    );

    const output = store.blocks.get(blockId)?.toolOutput as Record<string, unknown>;
    expect(output.mediaReport).toEqual(MEDIA_REPORT);
    expect(output.documentId).toBe('doc-1');
  });

  it('merges mediaReport from the onEnd result into toolOutput', () => {
    const blockId = handler().onStart!(store, 'msg-1', { blockType: 'anki_cards' });
    handler().onEnd!(store, blockId, {
      status: 'completed',
      cards: [{ id: 'c1', front: 'Q', back: 'A' }],
      mediaReport: MEDIA_REPORT,
    });

    const block = store.blocks.get(blockId);
    expect(block?.status).toBe('success');
    expect((block?.toolOutput as Record<string, unknown>).mediaReport).toEqual(MEDIA_REPORT);
  });

  it('preserves mediaReport and progress across a replayed start event (idempotent reuse)', () => {
    const blockId = handler().onStart!(
      store,
      'msg-1',
      { blockType: 'anki_cards' },
      'blk-replay-media',
    );
    handler().onChunk!(
      store,
      blockId,
      JSON.stringify({
        mediaReport: MEDIA_REPORT,
        documentId: 'doc-replay',
        progress: { stage: 'generating', cardsGenerated: 1 },
      }),
    );

    // 重连/重放触发的重复 start 不得清空既有 tool_output 字段
    handler().onStart!(store, 'msg-1', { blockType: 'anki_cards' }, 'blk-replay-media');

    const output = store.blocks.get(blockId)?.toolOutput as Record<string, unknown>;
    expect(output.mediaReport).toEqual(MEDIA_REPORT);
    expect(output.documentId).toBe('doc-replay');
    expect(output.progress).toEqual(
      expect.objectContaining({ stage: 'generating', cardsGenerated: 1 }),
    );
  });

  it('passes card extra_fields._qa_flags through streaming untouched', () => {
    const qaFlags = JSON.stringify([
      { code: 'front_too_long', field: 'front', message: 'too long', severity: 'warn' },
    ]);
    const blockId = handler().onStart!(store, 'msg-1', { blockType: 'anki_cards' });
    handler().onChunk!(
      store,
      blockId,
      JSON.stringify({
        cards: [
          { id: 'c1', front: 'Q', back: 'A', extra_fields: { _qa_flags: qaFlags } },
        ],
      }),
    );

    const output = store.blocks.get(blockId)?.toolOutput as { cards: Array<Record<string, any>> };
    expect(output.cards).toHaveLength(1);
    // 原样保留：既不丢失，也不被拼进 front/back
    expect(output.cards[0].extra_fields._qa_flags).toBe(qaFlags);
    expect(output.cards[0].back).toBe('A');
    expect(output.cards[0].front).toBe('Q');
  });

  it('accepts a late mediaReport after cancellation without reopening the block', () => {
    const blockId = handler().onStart!(store, 'msg-1', { blockType: 'anki_cards' });
    handler().onEnd!(store, blockId, {
      status: 'cancelled',
      cards: [{ id: 'c1', front: 'Q', back: 'A' }],
    });

    expect(store.blocks.get(blockId)?.status).toBe('success');
    handler().onChunk!(
      store,
      blockId,
      JSON.stringify({ mediaReport: MEDIA_REPORT, finalStatus: 'completed' }),
    );

    const block = store.blocks.get(blockId);
    const output = block?.toolOutput as Record<string, unknown>;
    expect(block?.status).toBe('success');
    expect(output.finalStatus).toBe('cancelled');
    expect(output.mediaReport).toEqual(MEDIA_REPORT);
  });

  it('keeps an error terminal while merging mediaReport from a late end event', () => {
    const blockId = handler().onStart!(store, 'msg-1', { blockType: 'anki_cards' });
    handler().onError!(store, blockId, 'import failed');
    handler().onEnd!(store, blockId, {
      status: 'completed',
      cards: [{ id: 'stale', front: 'stale', back: 'stale' }],
      mediaReport: MEDIA_REPORT,
    });

    const block = store.blocks.get(blockId);
    const output = block?.toolOutput as Record<string, unknown>;
    expect(block?.status).toBe('error');
    expect(block?.error).toBe('import failed');
    expect(output.finalStatus).toBe('error');
    expect(output.cards).toEqual([]);
    expect(output.mediaReport).toEqual(MEDIA_REPORT);
  });
});

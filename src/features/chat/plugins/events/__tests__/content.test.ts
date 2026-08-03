import { afterEach, describe, expect, it } from 'vitest';
import { chunkBuffer } from '../../../core/middleware/chunkBuffer';
import { contentEventHandler } from '../content';

function createStore() {
  const sessionId = 'sess-content-terminal';
  const blockId = 'blk-content-terminal';
  const blocks = new Map<string, any>([
    [blockId, { id: blockId, content: '实时', status: 'running' }],
  ]);
  const store: any = {
    sessionId,
    blocks,
    updateBlockContent(id: string, chunk: string) {
      const current = blocks.get(id);
      blocks.set(id, { ...current, content: `${current?.content ?? ''}${chunk}` });
    },
    batchUpdateBlockContent(updates: Array<{ blockId: string; content: string }>) {
      for (const update of updates) {
        this.updateBlockContent(update.blockId, update.content);
      }
    },
    updateBlock(id: string, patch: Record<string, unknown>) {
      blocks.set(id, { ...blocks.get(id), ...patch });
    },
    updateBlockStatus(id: string, status: string) {
      blocks.set(id, { ...blocks.get(id), status });
    },
  };
  return { store, sessionId, blockId, blocks };
}

describe('content terminal reconciliation', () => {
  afterEach(() => {
    chunkBuffer.clear();
  });

  it('restores a missing realtime tail from authoritative end content', () => {
    const { store, sessionId, blockId, blocks } = createStore();
    chunkBuffer.setStore(store);
    chunkBuffer.push(blockId, '增量', sessionId);

    contentEventHandler.onEnd?.(store, blockId, {
      content: '实时增量以及完整尾段',
    });

    expect(blocks.get(blockId)).toMatchObject({
      content: '实时增量以及完整尾段',
      status: 'success',
    });
  });
});

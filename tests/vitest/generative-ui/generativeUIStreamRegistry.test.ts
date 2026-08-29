import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryStreamPersistStorage } from '@/features/generative-ui/bridge/generativeUIStreamPersistence';
import {
  appendGenerativeUIStreamContent,
  clearGenerativeUIStreamRegistry,
  finalizeGenerativeUIStream,
  getLastGoodGenerativeUIIntent,
} from '@/features/generative-ui/bridge/generativeUIStreamRegistry';
import { STREAM_BUFFER_CAPPED_WARNING } from '@/features/generative-ui/utils/streamBufferGuard';

describe('generativeUIStreamRegistry', () => {
  beforeEach(() => {
    clearGenerativeUIStreamRegistry();
  });

  it('applies content deltas incrementally per blockId', () => {
    const blockId = 'blk-stream-1';
    const part1 =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"a"}';
    const part2 = '},{"type":"stat-card","props":{"title":"T","value":1}}]}';

    appendGenerativeUIStreamContent(blockId, part1);
    const snap2 = appendGenerativeUIStreamContent(blockId, part1 + part2);

    expect(snap2.committedBlockCount).toBe(2);
    expect(snap2.intent?.blocks.map((b) => b.type)).toEqual(['text', 'stat-card']);
  });

  it('finalize clears registry entry', () => {
    const blockId = 'blk-stream-2';
    appendGenerativeUIStreamContent(
      blockId,
      '{"version":"1","blocks":[{"type":"text","props":{"body":"x"}}]}',
    );
    const final = finalizeGenerativeUIStream(blockId);
    expect(final?.blocks).toHaveLength(1);
    expect(finalizeGenerativeUIStream(blockId)).toBeNull();
  });

  it('resets incremental state when content shrinks (block reload)', () => {
    const blockId = 'blk-stream-3';
    appendGenerativeUIStreamContent(
      blockId,
      '{"version":"1","blocks":[{"type":"text","props":{"body":"long"}}]}',
    );
    const snap = appendGenerativeUIStreamContent(blockId, '{"version":"1"}');
    expect(snap.committedBlockCount).toBe(0);
  });

  it('resets incremental state when cumulative content is replaced at the same length', () => {
    const blockId = 'blk-stream-replaced';
    const first = '{"version":"1","blocks":[{"type":"text","props":{"body":"A"}}';
    const replacement = '{"version":"1","blocks":[{"type":"text","props":{"body":"B"}}';
    expect(replacement).toHaveLength(first.length);

    appendGenerativeUIStreamContent(blockId, first);
    const snap = appendGenerativeUIStreamContent(blockId, replacement);

    expect(snap.committedBlockCount).toBe(1);
    expect(snap.intent?.blocks[0]?.props?.body).toBe('B');
  });

  it('falls back to lastGoodIntent when end-event JSON cannot be finalized', () => {
    const blockId = 'blk-stream-last-good';
    const open = '{"version":"1","blocks":[{"type":"text","props":{"body":"alpha"}}';
    appendGenerativeUIStreamContent(blockId, open);
    appendGenerativeUIStreamContent(blockId, `${open},{"type":"stat-card","props":{`);
    const final = finalizeGenerativeUIStream(blockId);
    expect(final?.blocks[0]?.props?.body).toBe('alpha');
  });

  it('stops appending when fullContent exceeds the stream char cap', () => {
    const blockId = 'blk-stream-buffer-capped';
    const open = '{"version":"1","blocks":[{"type":"text","props":{"body":"alpha"}}';
    appendGenerativeUIStreamContent(blockId, open);
    const snap = appendGenerativeUIStreamContent(
      blockId,
      open + 'x'.repeat(128),
      { maxChars: 128 },
    );
    expect(snap.warnings).toContain(STREAM_BUFFER_CAPPED_WARNING);
    expect(snap.intent?.blocks[0]?.props?.body).toBe('alpha');
    expect(snap.bufferLength).toBe(open.length);
    expect(getLastGoodGenerativeUIIntent(blockId)?.blocks[0]?.props?.body).toBe('alpha');
  });

  it('optionally persists lastGoodIntent when persistKey + storage are injected', () => {
    const storage = createMemoryStreamPersistStorage();
    const blockId = 'blk-stream-persist';
    const persistKey = 'opt:blk-stream-persist';
    appendGenerativeUIStreamContent(
      blockId,
      '{"version":"1","blocks":[{"type":"text","props":{"body":"keep"}}',
      { persistKey, storage },
    );
    clearGenerativeUIStreamRegistry();
    expect(getLastGoodGenerativeUIIntent(blockId, { persistKey, storage })?.blocks[0]?.props?.body).toBe(
      'keep',
    );
  });
});

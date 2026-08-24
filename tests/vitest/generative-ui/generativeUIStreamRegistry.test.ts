import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendGenerativeUIStreamContent,
  clearGenerativeUIStreamRegistry,
  finalizeGenerativeUIStream,
} from '@/features/generative-ui/bridge/generativeUIStreamRegistry';

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

  it('falls back to lastGoodIntent when end-event JSON cannot be finalized', () => {
    const blockId = 'blk-stream-last-good';
    const open = '{"version":"1","blocks":[{"type":"text","props":{"body":"alpha"}}';
    appendGenerativeUIStreamContent(blockId, open);
    appendGenerativeUIStreamContent(blockId, `${open},{"type":"stat-card","props":{`);
    const final = finalizeGenerativeUIStream(blockId);
    expect(final?.blocks[0]?.props?.body).toBe('alpha');
  });
});

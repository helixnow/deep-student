import { describe, expect, it } from 'vitest';
import {
  findActiveCompactionInfo,
  readCompactionInfo,
  type CompactionInfoSource,
} from '../contextCompactionInfo';

function buildSource(blocks: Array<{ id: string; type: string; toolOutput?: unknown }>): CompactionInfoSource {
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  return {
    messageOrder: ['m1'],
    messageMap: new Map([['m1', { blockIds: blocks.map((block) => block.id) }]]),
    blocks: blockMap,
  };
}

describe('readCompactionInfo', () => {
  it('parses object metadata with token counts', () => {
    expect(
      readCompactionInfo({ isActive: true, tokensBefore: 12000, tokensAfter: 3000, compactedMessageCount: 8 }),
    ).toEqual({ isActive: true, tokensBefore: 12000, tokensAfter: 3000, compactedMessageCount: 8 });
  });

  it('parses JSON string metadata', () => {
    expect(readCompactionInfo(JSON.stringify({ isActive: false, tokensBefore: 100 }))).toEqual({
      isActive: false,
      tokensBefore: 100,
    });
  });

  it('treats missing isActive as active (与撤销按钮语义一致)', () => {
    expect(readCompactionInfo({ tokensBefore: 100 })?.isActive).toBe(true);
  });

  it('returns null for invalid metadata', () => {
    expect(readCompactionInfo('not-json')).toBeNull();
    expect(readCompactionInfo(null)).toBeNull();
    expect(readCompactionInfo([1, 2])).toBeNull();
  });
});

describe('findActiveCompactionInfo', () => {
  it('returns the latest active compaction block metadata', () => {
    const source = buildSource([
      { id: 'b1', type: 'content' },
      { id: 'b2', type: 'compaction_summary', toolOutput: { isActive: true, tokensBefore: 9000, tokensAfter: 2000 } },
    ]);
    expect(findActiveCompactionInfo(source)).toEqual({
      isActive: true,
      tokensBefore: 9000,
      tokensAfter: 2000,
    });
  });

  it('returns null when the latest compaction has been undone', () => {
    const source = buildSource([
      { id: 'b1', type: 'compaction_summary', toolOutput: { isActive: false, tokensBefore: 9000 } },
    ]);
    expect(findActiveCompactionInfo(source)).toBeNull();
  });

  it('returns null when no compaction block exists', () => {
    const source = buildSource([{ id: 'b1', type: 'content' }]);
    expect(findActiveCompactionInfo(source)).toBeNull();
  });

  it('prefers the newest compaction block when multiple exist', () => {
    const source = buildSource([
      { id: 'b1', type: 'compaction_summary', toolOutput: { isActive: false, tokensBefore: 1 } },
      { id: 'b2', type: 'compaction_summary', toolOutput: { isActive: true, tokensBefore: 2, tokensAfter: 1 } },
    ]);
    expect(findActiveCompactionInfo(source)).toEqual({ isActive: true, tokensBefore: 2, tokensAfter: 1 });
  });
});

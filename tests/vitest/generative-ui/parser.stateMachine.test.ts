import { describe, it, expect, beforeEach } from 'vitest';
import {
  GenerativeUIStreamParser,
  type GenerativeUIStreamPhase,
} from '@/features/generative-ui/parser';

describe('GenerativeUIStreamParser state machine', () => {
  it('starts in idle phase', () => {
    const parser = new GenerativeUIStreamParser();
    expect(parser.getSnapshot()).toMatchObject({
      phase: 'idle',
      committedBlockCount: 0,
      intent: null,
    });
  });

  it('commits blocks incrementally across chunks without re-growing count spuriously', () => {
    const parser = new GenerativeUIStreamParser();
    const block1 =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"first"}}';
    const block2 = ',{"type":"stat-card","props":{"title":"Due","value":2}}]}';

    const snap1 = parser.appendChunk(block1);
    expect(snap1.phase).toBe('streaming');
    expect(snap1.committedBlockCount).toBe(1);
    expect(snap1.intent?.blocks[0]?.type).toBe('text');

    const snap2 = parser.appendChunk(block2);
    expect(snap2.committedBlockCount).toBe(2);
    expect(snap2.intent?.blocks[1]?.type).toBe('stat-card');
  });

  it('transitions to complete on finalize', () => {
    const parser = new GenerativeUIStreamParser();
    parser.appendChunk(
      '{"version":"1","blocks":[{"type":"text","props":{"body":"done"}}]}',
    );
    const final = parser.finalize();
    expect(final?.blocks).toHaveLength(1);
    expect(parser.getSnapshot().phase).toBe('complete');
  });

  it('reset returns to idle', () => {
    const parser = new GenerativeUIStreamParser();
    parser.appendChunk('{"version":"1","blocks":[{"type":"text","props":{"body":"x"}}]}');
    parser.reset();
    expect(parser.getSnapshot()).toMatchObject({
      phase: 'idle',
      committedBlockCount: 0,
      bufferLength: 0,
    });
  });

  it('marks overflow when buffer exceeds cap', () => {
    const cap = 128;
    const parser = new GenerativeUIStreamParser(cap);
    const snap = parser.appendChunk('x'.repeat(cap + 1));
    const phases: GenerativeUIStreamPhase[] = ['overflow', 'streaming'];
    expect(phases).toContain(snap.phase);
    expect(snap.phase).toBe('overflow');
    expect(snap.warnings).toContain('stream-buffer-capped');
  });
});

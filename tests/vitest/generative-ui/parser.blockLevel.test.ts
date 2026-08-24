import { describe, it, expect } from 'vitest';
import {
  sanitizeGenerativeJsonBuffer,
  extractClosedBlockObjectSlices,
  tryParsePartialIntent,
  GenerativeUIStreamParser,
} from '@/features/generative-ui/parser';

describe('generative-ui parser block-level', () => {
  it('strips markdown fences', () => {
    expect(sanitizeGenerativeJsonBuffer('```json\n{"version":"1"}\n```')).toBe('{"version":"1"}');
  });

  it('extracts complete blocks from truncated stream', () => {
    const partial =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"a"}},{"type":"stat-card","props":{"title":"T","value":1';
    const slices = extractClosedBlockObjectSlices(partial);
    expect(slices).toHaveLength(1);
    const intent = tryParsePartialIntent(partial);
    expect(intent?.blocks).toHaveLength(1);
    expect(intent?.blocks[0]?.type).toBe('text');
  });

  it('parser append keeps last-good when tail is incomplete', () => {
    const complete =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"hello"}}]}';
    const parser = new GenerativeUIStreamParser();
    parser.append(complete);
    parser.append(',{"type":"stat-card","props":{"title":"X","val');
    expect(parser.append('')?.blocks.length).toBeGreaterThanOrEqual(1);
  });
});

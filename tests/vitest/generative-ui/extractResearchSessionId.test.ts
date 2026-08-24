import { describe, it, expect } from 'vitest';
import { extractResearchSessionId } from '@/features/generative-ui/utils/extractResearchSessionId';

describe('extractResearchSessionId', () => {
  it('reads from toolInput', () => {
    expect(
      extractResearchSessionId({ researchSessionId: ' chat-s1 ' }, undefined, undefined),
    ).toBe('chat-s1');
  });

  it('falls back to toolOutput then intent.meta', () => {
    expect(
      extractResearchSessionId(undefined, { researchSessionId: 'out-s1' }, undefined),
    ).toBe('out-s1');

    expect(
      extractResearchSessionId(undefined, undefined, {
        version: '1',
        meta: { researchSessionId: 'meta-s1' },
        blocks: [],
      }),
    ).toBe('meta-s1');
  });

  it('returns null for blank values', () => {
    expect(extractResearchSessionId({ researchSessionId: '  ' }, undefined, undefined)).toBeNull();
  });
});

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

  it('rejects oversized or unsafe session ids', () => {
    expect(
      extractResearchSessionId({ researchSessionId: 'x'.repeat(129) }, undefined, undefined),
    ).toBeNull();
    expect(
      extractResearchSessionId({ researchSessionId: '../evil' }, undefined, undefined),
    ).toBeNull();
    expect(
      extractResearchSessionId({ researchSessionId: 'javascript:alert(1)' }, undefined, undefined),
    ).toBeNull();
    expect(
      extractResearchSessionId({ researchSessionId: 'sess_2026-08-24.1' }, undefined, undefined),
    ).toBe('sess_2026-08-24.1');
  });
});

import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_HEX_LENGTH,
  fingerprintGenerativeUIIntent,
  hashToShortHex,
  stableStringify,
} from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const SAMPLE: GenerativeUIIntent = {
  version: '1',
  meta: { title: 'brief', description: 'desc' },
  layout: { mode: 'stack' },
  blocks: [
    { type: 'text', id: 'a', props: { body: 'one' } },
    { type: 'stat-card', id: 'b', props: { title: 'Due', value: 2 } },
  ],
};

describe('stableStringify', () => {
  it('sorts object keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: 2, skip: undefined })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ skip: undefined })).toBe('{}');
  });

  it('treats omitted and undefined object keys as equal', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('maps array undefined to null and keeps order', () => {
    expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('recursively sorts nested objects', () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, y: 0 })).toBe('{"y":0,"z":{"a":2,"b":1}}');
  });
});

describe('fingerprintGenerativeUIIntent', () => {
  it('is deterministic for the same intent', () => {
    const once = fingerprintGenerativeUIIntent(SAMPLE);
    const twice = fingerprintGenerativeUIIntent({ ...SAMPLE, blocks: [...SAMPLE.blocks] });
    expect(once).toBe(twice);
    expect(once).toMatch(/^[0-9a-f]+$/);
    expect(once).toHaveLength(FINGERPRINT_HEX_LENGTH);
  });

  it('ignores object key order', () => {
    const shuffled: GenerativeUIIntent = {
      blocks: [
        { props: { body: 'one' }, id: 'a', type: 'text' },
        { props: { value: 2, title: 'Due' }, type: 'stat-card', id: 'b' },
      ],
      layout: { mode: 'stack' },
      meta: { description: 'desc', title: 'brief' },
      version: '1',
    };
    expect(fingerprintGenerativeUIIntent(shuffled)).toBe(fingerprintGenerativeUIIntent(SAMPLE));
  });

  it('ignores undefined fields versus omitted fields', () => {
    const withUndefined = {
      ...SAMPLE,
      meta: { title: 'brief', description: 'desc', extra: undefined },
    } as GenerativeUIIntent;
    expect(fingerprintGenerativeUIIntent(withUndefined)).toBe(fingerprintGenerativeUIIntent(SAMPLE));
  });

  it('changes when content changes', () => {
    const other: GenerativeUIIntent = {
      ...SAMPLE,
      blocks: [{ type: 'text', id: 'a', props: { body: 'two' } }],
    };
    expect(fingerprintGenerativeUIIntent(other)).not.toBe(fingerprintGenerativeUIIntent(SAMPLE));
  });

  it('treats block order as significant by default', () => {
    const reversed: GenerativeUIIntent = {
      ...SAMPLE,
      blocks: [SAMPLE.blocks[1]!, SAMPLE.blocks[0]!],
    };
    expect(fingerprintGenerativeUIIntent(reversed)).not.toBe(fingerprintGenerativeUIIntent(SAMPLE));
  });

  it('can ignore block order when requested', () => {
    const reversed: GenerativeUIIntent = {
      ...SAMPLE,
      blocks: [SAMPLE.blocks[1]!, SAMPLE.blocks[0]!],
    };
    expect(fingerprintGenerativeUIIntent(reversed, { ignoreBlockOrder: true })).toBe(
      fingerprintGenerativeUIIntent(SAMPLE, { ignoreBlockOrder: true }),
    );
  });

  it('does not mutate the source intent when ignoring block order', () => {
    const source: GenerativeUIIntent = {
      version: '1',
      blocks: [
        { type: 'text', id: 'z', props: { body: 'z' } },
        { type: 'text', id: 'a', props: { body: 'a' } },
      ],
    };
    const snapshot = structuredClone(source);
    fingerprintGenerativeUIIntent(source, { ignoreBlockOrder: true });
    expect(source).toEqual(snapshot);
  });

  it('hashes null / undefined as the same empty payload', () => {
    expect(fingerprintGenerativeUIIntent(null)).toBe(fingerprintGenerativeUIIntent(undefined));
    expect(fingerprintGenerativeUIIntent(null)).toHaveLength(FINGERPRINT_HEX_LENGTH);
  });

  it('hashToShortHex is stable and 16 hex chars', () => {
    expect(hashToShortHex('{"a":1}')).toBe(hashToShortHex('{"a":1}'));
    expect(hashToShortHex('{"a":1}')).toHaveLength(16);
    expect(hashToShortHex('{"a":1}')).not.toBe(hashToShortHex('{"a":2}'));
  });
});

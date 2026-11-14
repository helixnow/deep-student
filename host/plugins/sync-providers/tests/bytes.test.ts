import { describe, expect, it } from 'vitest';
import { bytesEqual, compareBytes, utf8Decode, utf8Encode } from '../src/bytes.ts';

const samples = ['', 'a', 'ab', 'b', 'aé', 'a\u0000', '中', '𝄞', 'z'.repeat(5), '\uFEFF{}'];

describe('sync-providers byte helpers match Buffer', () => {
  it('bytesEqual and compareBytes agree with Buffer#equals and Buffer.compare', () => {
    for (const left of samples) {
      for (const right of samples) {
        const a = utf8Encode(left);
        const b = utf8Encode(right);
        expect(bytesEqual(a, b)).toBe(Buffer.from(a).equals(Buffer.from(b)));
        expect(compareBytes(a, b)).toBe(Buffer.compare(Buffer.from(a), Buffer.from(b)));
      }
    }
  });

  it('UTF-8 codecs agree with Buffer, keeping a leading BOM so JSON.parse still rejects it', () => {
    for (const text of [...samples, 'lone \uD800 surrogate']) {
      expect([...utf8Encode(text)]).toEqual([...Buffer.from(text, 'utf8')]);
      const bytes = Buffer.from(text, 'utf8');
      expect(utf8Decode(bytes)).toBe(bytes.toString('utf8'));
    }
    expect(() => JSON.parse(utf8Decode(utf8Encode('\uFEFF{}')))).toThrow(SyntaxError);
    const invalid = Uint8Array.of(0x61, 0xff, 0xc3, 0x28, 0xe2, 0x82);
    expect(utf8Decode(invalid)).toBe(Buffer.from(invalid).toString('utf8'));
  });
});

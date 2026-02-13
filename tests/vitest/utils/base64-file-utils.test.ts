import { describe, expect, it } from 'vitest';

import {
  base64ToBlob,
  base64ToUint8Array,
  cleanBase64String,
  decodeBase64ToText,
  uint8ArrayToBase64,
} from '@/utils/base64FileUtils';

describe('base64FileUtils', () => {
  it('strips data URL prefix and whitespace', () => {
    const input = 'data:text/plain;base64, YQ==\n';
    expect(cleanBase64String(input)).toBe('YQ==');
  });

  it('encodes and decodes large Uint8Array in chunks', () => {
    const bytes = new Uint8Array(120000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251;
    }

    const encoded = uint8ArrayToBase64(bytes);
    const decoded = base64ToUint8Array(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.length).toBe(bytes.length);
    expect(decoded?.[0]).toBe(bytes[0]);
    expect(decoded?.[59999]).toBe(bytes[59999]);
    expect(decoded?.[119999]).toBe(bytes[119999]);
  });

  it('decodes utf-8 text from base64', () => {
    const source = '中文 mixed with English 123';
    const encoded = uint8ArrayToBase64(new TextEncoder().encode(source));

    expect(decodeBase64ToText(encoded)).toBe(source);
  });

  it('returns null blob for invalid base64 input', () => {
    expect(base64ToBlob('@@invalid@@', 'text/plain')).toBeNull();
  });
});

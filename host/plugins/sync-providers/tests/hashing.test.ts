import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeCrypto } from '../../../platform/crypto/index.ts';
import { setCryptoLookup, sha256Hasher, sha256Hex } from '../src/hashing.ts';

const nodeHex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

describe('sync-providers SHA-256 via ctx.crypto', () => {
  afterEach(() => setCryptoLookup(null));

  const inputs: (Uint8Array | string)[] = [
    new Uint8Array(0),
    'abc',
    '中文 checksum',
    Uint8Array.from({ length: 1_000_003 }, (_, i) => (i * 31) & 0xff),
  ];

  it('portable fallback matches node:crypto for one-shot and chunked input', () => {
    for (const data of inputs) {
      expect(sha256Hex(data)).toBe(nodeHex(data));
      if (typeof data !== 'string') {
        const hasher = sha256Hasher();
        for (let offset = 0; offset < data.length; offset += 65_536) hasher.update(data.subarray(offset, offset + 65_536));
        expect(hasher.digestHex()).toBe(nodeHex(data));
      }
    }
  });

  it('uses the installed ctx.crypto service when present', () => {
    const native = createNodeCrypto();
    let calls = 0;
    setCryptoLookup(() => { calls += 1; return native; });
    for (const data of inputs) expect(sha256Hex(data)).toBe(nodeHex(data));
    expect(calls).toBe(inputs.length);
    setCryptoLookup(() => undefined);
    expect(sha256Hex('abc')).toBe(nodeHex('abc'));
  });
});

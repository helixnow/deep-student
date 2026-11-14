/** `sync.ts`（@noble/hashes）与 `node:crypto` 逐例一致；`ctx.crypto.sha256Sync` 两个实现一致。 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { CryptoError, type DigestAlgorithm } from '../api.ts';
import { createNodeCrypto } from '../index.ts';
import { createHasherSync, digestSync, hmacSync, sha256HexSync, sha256Sync } from '../sync.ts';
import { createWebCrypto } from '../web.ts';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const NODE_NAME: Record<DigestAlgorithm, string> = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** SHA-256 / SHA-512 的块边界附近与较大的输入。 */
const SIZES = [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 1000, 4096, 65_535, 65_536, 1_000_003];
const STRINGS = ['', 'abc', 'vfs-index-profile-v2\0', '中文 / 日本語 / 한국어', '😀𝄞', 'lone \ud800 surrogate', 'tail \udfff', JSON.stringify({ a: [1, 2.5, 'x'], b: null })];

describe('sync digests match node:crypto', () => {
  it.each(Object.keys(NODE_NAME) as DigestAlgorithm[])('%s over bytes of boundary sizes and over UTF-8 strings', (algorithm) => {
    for (const size of SIZES) {
      const data = bytes(size, size + 1);
      expect(Buffer.from(digestSync(algorithm, data)).toString('hex'), `${size}`).toBe(createHash(NODE_NAME[algorithm]).update(data).digest('hex'));
    }
    for (const text of STRINGS) {
      expect(Buffer.from(digestSync(algorithm, text)).toString('hex'), text).toBe(createHash(NODE_NAME[algorithm]).update(text, 'utf8').digest('hex'));
    }
  });

  it('sha256Sync / sha256HexSync equal createHash("sha256")', () => {
    for (const size of SIZES) {
      const data = bytes(size, 7 * size + 3);
      const expected = createHash('sha256').update(data).digest();
      expect(Buffer.from(sha256Sync(data)).equals(expected), `${size}`).toBe(true);
      expect(sha256HexSync(data), `${size}`).toBe(expected.toString('hex'));
    }
    for (const text of STRINGS) expect(sha256HexSync(text), text).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(sha256Sync('abc')).not.toBeInstanceOf(Buffer);
  });

  it('createHasherSync with arbitrary chunking equals one createHash pass', () => {
    const data = bytes(200_003, 11);
    const cuts = [0, 1, 63, 64, 65, 1000, 65_536, 131_071, 200_000, 200_003];
    for (const algorithm of Object.keys(NODE_NAME) as DigestAlgorithm[]) {
      const hasher = createHasherSync(algorithm);
      for (let i = 1; i < cuts.length; i++) hasher.update(data.subarray(cuts[i - 1], cuts[i]));
      hasher.update('😀');
      expect(hasher.digestHex()).toBe(createHash(NODE_NAME[algorithm]).update(data).update('😀', 'utf8').digest('hex'));
      expect(() => hasher.update('x')).toThrow(CryptoError);
    }
  });

  it('hmacSync equals createHmac, including empty and long keys', () => {
    for (const key of ['', 'k', 'x'.repeat(200), bytes(64, 5), bytes(129, 6)]) {
      for (const algorithm of Object.keys(NODE_NAME) as DigestAlgorithm[]) {
        expect(Buffer.from(hmacSync(algorithm, key, 'payload')).toString('hex')).toBe(createHmac(NODE_NAME[algorithm], key).update('payload').digest('hex'));
      }
    }
  });

  it('rejects unknown algorithms with CryptoError(InvalidArgument)', () => {
    expect(() => digestSync('MD5' as DigestAlgorithm, 'x')).toThrow(expect.objectContaining({ kind: 'InvalidArgument' }));
    expect(() => createHasherSync('SHA-3' as DigestAlgorithm)).toThrow(CryptoError);
  });

  it('ctx.crypto.sha256Sync is identical on the node and web implementations', () => {
    const node = createNodeCrypto();
    const web = createWebCrypto();
    for (const input of [...STRINGS, bytes(70_001, 9)]) {
      const expected = createHash('sha256').update(input).digest();
      expect(Buffer.from(node.sha256Sync(input)).equals(expected)).toBe(true);
      expect(Buffer.from(web.sha256Sync(input)).equals(expected)).toBe(true);
      expect(node.sha256Sync(input)).not.toBeInstanceOf(Buffer);
    }
  });

  it('sync.ts carries no Node dependencies', () => {
    expect(checkModulesClosure(ROOT, ['host/platform/crypto/sync.ts'])).toEqual([]);
  });
});

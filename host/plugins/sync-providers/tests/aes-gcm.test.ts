/** The portable (`@noble/ciphers`) and desktop (`node:crypto`) AES-256-GCM ports must be interchangeable byte for byte. */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { aesGcmOpen, aesGcmSeal, portableAesGcm, setAesGcm } from '../src/aes-gcm.ts';
import { nodeAesGcm } from '../src/aes-gcm.node.ts';

afterEach(() => setAesGcm(null));

describe('Sync V5 AES-GCM port', () => {
  it.each([0, 1, 15, 16, 17, 65535, 65536, 100_000])('%i bytes: both implementations seal to the same bytes and open each other', size => {
    const key = randomBytes(32), nonce = randomBytes(12), aad = randomBytes(size % 50), plain = new Uint8Array(randomBytes(size));
    const portable = portableAesGcm.seal(key, nonce, aad, plain);
    const node = nodeAesGcm.seal(key, nonce, aad, plain);
    expect(portable.length).toBe(size + 16);
    expect(node).toEqual(portable);
    expect(portableAesGcm.open(key, nonce, aad, node)).toEqual(plain);
    expect(nodeAesGcm.open(key, nonce, aad, portable)).toEqual(plain);
  });

  it.each([['portable', portableAesGcm], ['node', nodeAesGcm]] as const)('%s rejects a changed tag, ciphertext, AAD, nonce or key and a short input', (_name, impl) => {
    const key = randomBytes(32), nonce = randomBytes(12), aad = randomBytes(9), plain = randomBytes(64);
    const sealed = impl.seal(key, nonce, aad, plain);
    const flipped = (index: number) => { const copy = new Uint8Array(sealed); copy[index]! ^= 1; return copy; };
    expect(() => impl.open(key, nonce, aad, flipped(sealed.length - 1))).toThrow();
    expect(() => impl.open(key, nonce, aad, flipped(0))).toThrow();
    expect(() => impl.open(key, nonce, randomBytes(9), sealed)).toThrow();
    expect(() => impl.open(key, randomBytes(12), aad, sealed)).toThrow();
    expect(() => impl.open(randomBytes(32), nonce, aad, sealed)).toThrow();
    expect(() => impl.open(key, nonce, aad, sealed.subarray(0, 15))).toThrow();
  });

  it('the facade uses the portable implementation until an entry injects another, and null restores it', () => {
    const calls: string[] = [];
    setAesGcm({
      seal: (...args) => { calls.push('seal'); return nodeAesGcm.seal(...args); },
      open: (...args) => { calls.push('open'); return nodeAesGcm.open(...args); },
    });
    const key = randomBytes(32), nonce = randomBytes(12), aad = new Uint8Array(), plain = new Uint8Array(randomBytes(33));
    const sealed = aesGcmSeal(key, nonce, aad, plain);
    expect(aesGcmOpen(key, nonce, aad, sealed)).toEqual(plain);
    expect(calls).toEqual(['seal', 'open']);
    setAesGcm(null);
    expect(aesGcmOpen(key, nonce, aad, sealed)).toEqual(plain);
    expect(calls).toEqual(['seal', 'open']);
  });
});

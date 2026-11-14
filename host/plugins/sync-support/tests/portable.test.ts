import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hasher, sha256Hex, uint32be, uint64be, utf8ByteLength } from '../src/portable.ts';

function nodeU64(value: bigint): Uint8Array {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return new Uint8Array(buffer);
}

function nodeError(run: () => unknown): { name: string; code: unknown; message: string } {
  try { run(); } catch (error) {
    const e = error as Error & { code?: unknown };
    return { name: e.name, code: e.code, message: e.message };
  }
  throw new Error('expected a throw');
}

describe('sync-support portable hashing and length prefixes match Node', () => {
  it('sha256 over strings and mixed updates', () => {
    for (const text of ['', 'device-1', '中文/路径', '𝄞'.repeat(100)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    }
    const mixed = sha256Hasher().update(uint64be(3n)).update('abc').update(Uint8Array.of(1)).digestHex();
    const node = createHash('sha256').update(nodeU64(3n)).update('abc', 'utf8').update(Buffer.from([1])).digest('hex');
    expect(mixed).toBe(node);
  });

  it('uint64be / uint32be bytes and out-of-range errors', () => {
    for (const value of [0n, 1n, 2n ** 32n, 2n ** 63n, 2n ** 64n - 1n]) expect(uint64be(value)).toEqual(nodeU64(value));
    for (const value of [-1n, 2n ** 64n, -(2n ** 40n), 2n ** 70n]) {
      expect(nodeError(() => uint64be(value))).toEqual(nodeError(() => Buffer.alloc(8).writeBigUInt64BE(value)));
    }
    for (const value of [0, 1, 0xffffffff, -1, 2 ** 33 + 5]) {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(value >>> 0);
      expect(uint32be(value)).toEqual(new Uint8Array(buffer));
    }
  });
});

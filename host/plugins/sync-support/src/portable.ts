/** SHA-256 and big-endian length prefixes without `node:crypto` / `Buffer`; inputs here are short identifiers. */
import type { Hasher } from '../../../platform/crypto/api.ts';
import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';

export { utf8Encode };

const crypto = createWebCrypto();

export function sha256Hasher(): Hasher {
  return crypto.createHasher('SHA-256');
}

export function sha256Hex(text: string): string {
  return sha256Hasher().update(text).digestHex();
}

export function utf8ByteLength(text: string): number {
  return utf8Encode(text).byteLength;
}

const U64_LIMIT = 2n ** 64n;

/** Node `addNumericalSeparator` (internal/errors.js), used in `ERR_OUT_OF_RANGE` messages. */
function withSeparators(digits: string): string {
  let out = '';
  let i = digits.length;
  const start = digits[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) out = `_${digits.slice(i - 3, i)}${out}`;
  return `${digits.slice(0, i)}${out}`;
}

/** `Buffer#writeBigUInt64BE`, including its `RangeError` for values outside `[0, 2^64)`. */
export function uint64be(value: bigint): Uint8Array {
  if (value < 0n || value >= U64_LIMIT) {
    const received = value > 2n ** 32n || value < -(2n ** 32n) ? withSeparators(String(value)) : String(value);
    throw Object.assign(
      new RangeError(`The value of "value" is out of range. It must be >= 0n and < 2n ** 64n. Received ${received}n`),
      { code: 'ERR_OUT_OF_RANGE' },
    );
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value);
  return bytes;
}

/** `Buffer#writeUInt32BE(value >>> 0)`. */
export function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

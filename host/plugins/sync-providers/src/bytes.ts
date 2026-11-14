/** Byte helpers without `Buffer`; UTF-8 codecs come from the portable crypto encoding module. */
export { utf8Decode, utf8Encode } from '../../../platform/crypto/encoding.ts';
export { compareUtf8, utf8ByteLength } from '../../../platform/util/utf8.ts';
export { compareBytes, concatBytes } from '../../../platform/util/bytes.ts';

/** `Buffer#equals`: same length and contents. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

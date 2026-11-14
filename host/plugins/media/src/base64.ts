/**
 * Rust `base64 0.21.7` `general_purpose::STANDARD` decoder, including the exact
 * `DecodeError` Display text and error precedence (`RequireCanonical` padding,
 * `decode_allow_trailing_bits = false`).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Map([...ALPHABET].map((c, i) => [c.charCodeAt(0), i] as [number, number]));
const PAD = 0x3d;

export class Base64DecodeError extends Error {
  constructor(message: string) { super(message); this.name = 'Base64DecodeError'; }
}

function invalidByte(index: number, byte: number): never {
  throw new Base64DecodeError(`Invalid byte ${byte}, offset ${index}.`);
}

function decodeMorsels(morsels: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  for (; i + 4 <= morsels.length; i += 4) {
    const a = morsels[i]!, b = morsels[i + 1]!, c = morsels[i + 2]!, d = morsels[i + 3]!;
    out.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d);
  }
  if (morsels.length - i === 2) {
    out.push((morsels[i]! << 2) | (morsels[i + 1]! >> 4));
  } else if (morsels.length - i === 3) {
    out.push((morsels[i]! << 2) | (morsels[i + 1]! >> 4),
      ((morsels[i + 1]! & 15) << 4) | (morsels[i + 2]! >> 2));
  }
  return out;
}

export function decodeBase64Standard(input: string): Uint8Array {
  const data = new TextEncoder().encode(input);
  const length = data.length;
  if (length === 0) return new Uint8Array(0);

  const remainder = length % 8;
  if (remainder === 1 || remainder === 5) {
    const last = data[length - 1]!;
    if (last !== PAD && !VALUES.has(last)) invalidByte(length - 1, last);
    throw new Base64DecodeError('Encoded text cannot have a 6-bit remainder.');
  }

  const chunks = Math.ceil(length / 8);
  const suffixStart = (chunks - 1) * 8;
  const out: number[] = [];
  for (let start = 0; start < suffixStart; start += 8) {
    const morsels: number[] = [];
    for (let i = 0; i < 8; i++) {
      const byte = data[start + i]!;
      const value = VALUES.get(byte);
      if (value === undefined) invalidByte(start + i, byte);
      morsels.push(value);
    }
    out.push(...decodeMorsels(morsels));
  }

  const suffix = data.subarray(suffixStart);
  const morsels: number[] = [];
  let padding = 0;
  let firstPadding = 0;
  let lastSymbol = 0;
  for (let i = 0; i < suffix.length; i++) {
    const byte = suffix[i]!;
    if (byte === PAD) {
      if (i % 4 < 2) invalidByte(suffixStart + (padding > 0 ? firstPadding : i), PAD);
      if (padding === 0) firstPadding = i;
      padding += 1;
      continue;
    }
    if (padding > 0) invalidByte(suffixStart + firstPadding, PAD);
    lastSymbol = byte;
    const value = VALUES.get(byte);
    if (value === undefined) invalidByte(suffixStart + i, byte);
    morsels.push(value);
  }

  // DecodePaddingMode::RequireCanonical
  if ((padding + morsels.length) % 4 !== 0) throw new Base64DecodeError('Invalid padding');

  // decode_allow_trailing_bits = false: unused low bits of the final symbol must be zero.
  const unusedBits = morsels.length % 4 === 2 ? 0b1111 : morsels.length % 4 === 3 ? 0b11 : 0;
  if (unusedBits !== 0 && (morsels[morsels.length - 1]! & unusedBits) !== 0) {
    throw new Base64DecodeError(
      `Invalid last symbol ${lastSymbol}, offset ${suffixStart + morsels.length - 1}.`);
  }

  out.push(...decodeMorsels(morsels));
  return Uint8Array.from(out);
}

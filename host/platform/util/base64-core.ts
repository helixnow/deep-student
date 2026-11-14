/**
 * Rust `base64 0.22.1` STANDARD 解码的可移植实现：结果为普通 `Uint8Array`。
 * 桌面入口 `base64.ts` 在此之上包成 `Buffer`（保持原有返回类型）。
 */
import { encodeUtf8 } from './utf8.ts';

const BASE64_VALUE = (() => {
  const table = new Int16Array(256).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  return table;
})();

export type Base64DecodeResult<Bytes extends Uint8Array = Uint8Array> =
  | { readonly bytes: Bytes; readonly error?: never }
  | { readonly bytes?: never; readonly error: string };

/**
 * `base64 0.22.1` `general_purpose::STANDARD.decode` 的逐分支移植：
 * `RequireCanonical` 填充 + `decode_allow_trailing_bits = false`。
 * 错误文本保留 crate `DecodeError` 的 Display（见 `decode.rs:32-45`）。
 */
export function decodeBase64Standard(text: string): Base64DecodeResult {
  const input = encodeUtf8(text);
  const length = input.length;
  if (length === 0) return { bytes: new Uint8Array(0) };
  const invalidByte = (index: number, byte: number): Base64DecodeResult => ({
    error: `Invalid symbol ${byte}, offset ${index}.`,
  });
  const remainder = length % 4;
  // `complete_quads_len`：输入 %4==1 时先报告尾部的非法字节（换行等）。
  if (remainder === 1) {
    const byte = input[length - 1]!;
    if (byte !== 0x3d && BASE64_VALUE[byte] === -1) return invalidByte(length - 1, byte);
  }
  const complete = length - remainder - (remainder === 0 ? 4 : 0);
  const output: number[] = [];
  for (let index = 0; index < complete; index += 4) {
    const a = BASE64_VALUE[input[index]!]!;
    const b = BASE64_VALUE[input[index + 1]!]!;
    const c = BASE64_VALUE[input[index + 2]!]!;
    const d = BASE64_VALUE[input[index + 3]!]!;
    if (a < 0) return invalidByte(index, input[index]!);
    if (b < 0) return invalidByte(index + 1, input[index + 1]!);
    if (c < 0) return invalidByte(index + 2, input[index + 2]!);
    if (d < 0) return invalidByte(index + 3, input[index + 3]!);
    output.push((a << 2) | (b >> 4), ((b & 0x0f) << 4) | (c >> 2), ((c & 0x03) << 6) | d);
  }

  const morsels: number[] = [];
  let paddingCount = 0;
  let firstPaddingOffset = -1;
  let lastSymbol = 0;
  for (let index = complete; index < length; index += 1) {
    const byte = input[index]!;
    if (byte === 0x3d) {
      if (index - complete < 2) return invalidByte(index, byte);
      if (paddingCount === 0) firstPaddingOffset = index;
      paddingCount += 1;
      continue;
    }
    if (paddingCount > 0) return invalidByte(firstPaddingOffset, 0x3d);
    lastSymbol = byte;
    const value = BASE64_VALUE[byte]!;
    if (value < 0) return invalidByte(index, byte);
    morsels.push(value);
  }
  if (morsels.length < 2) return { error: `Invalid input length: ${complete + morsels.length}` };
  if ((paddingCount + morsels.length) % 4 !== 0) return { error: 'Invalid padding' };
  const leftoverBytes = Math.floor(morsels.length * 6 / 8);
  let leftover = ((morsels[0] ?? 0) << 26) | ((morsels[1] ?? 0) << 20)
    | ((morsels[2] ?? 0) << 14) | ((morsels[3] ?? 0) << 8);
  leftover >>>= 0;
  const mask = (0xffffffff >>> (leftoverBytes * 8)) >>> 0;
  if ((leftover & mask) !== 0) {
    return { error: `Invalid last symbol ${lastSymbol}, offset ${complete + morsels.length - 1}.` };
  }
  for (let index = 0; index < leftoverBytes; index += 1) output.push((leftover >>> (24 - index * 8)) & 0xff);
  return { bytes: Uint8Array.from(output) };
}

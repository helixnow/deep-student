/**
 * APKG 归档读写用到的字节原语（可移植）：ZIP 头与 protobuf 字段都是小端定长整数。
 *
 * 只依赖 `Uint8Array` / `DataView` / `TextDecoder`，不出现 `Buffer`——移动端 WebView 与 Worker
 * 没有 Node 全局量。字符串编解码统一走 `platform/crypto/encoding.ts` 与 `platform/util/utf8.ts`。
 */

/** `Buffer.readUInt16LE`。 */
export function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** `Buffer.readUInt32LE`。 */
export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;
}

/** `Buffer.readBigUInt64LE`。 */
export function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

/** `Buffer.writeUInt16LE`。 */
export function writeU16LE(bytes: Uint8Array, value: number, offset: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

/** `Buffer.writeUInt32LE`。 */
export function writeU32LE(bytes: Uint8Array, value: number, offset: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/** `Buffer.concat`。 */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** `Buffer.equals` / `Buffer.compare(..) === 0`。 */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** `bytes.toString('latin1')`：zip 通用标志位未置 UTF-8 时的单字节解码（CP437 的 ASCII 子集）。 */
export function latin1Decode(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

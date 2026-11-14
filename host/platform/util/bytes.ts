/**
 * `Uint8Array` 上的拼接、排序与大端整数读写，替代可移植代码里的 `Buffer` 调用。
 * 只依赖 ECMAScript，不得 import Node 模块。
 */

/** `Buffer.concat(list, totalLength)`：按顺序复制到一段连续内存。 */
export function concatBytes(chunks: readonly Uint8Array[], totalLength?: number): Uint8Array {
  const length = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `Buffer.compare`：按无符号字节的字典序，返回 -1 / 0 / 1。 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.byteLength === b.byteLength ? 0 : a.byteLength < b.byteLength ? -1 : 1;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 同 `Buffer#writeUInt*BE`：越界的值抛 `RangeError`，不像 `DataView` 那样静默回绕。 */
function assertUint(value: number, max: number): void {
  if (value < 0 || value > max) throw new RangeError(`value ${value} is out of range [0, ${max}]`);
}

export function writeU16be(target: Uint8Array, value: number, offset = 0): void {
  assertUint(value, 0xffff);
  view(target).setUint16(offset, value);
}

export function writeU32be(target: Uint8Array, value: number, offset = 0): void {
  assertUint(value, 0xffffffff);
  view(target).setUint32(offset, value);
}

export function writeU64be(target: Uint8Array, value: bigint, offset = 0): void {
  if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError(`value ${value} is out of range [0, 2^64 - 1]`);
  view(target).setBigUint64(offset, value);
}

/** 读取越过末尾时抛 `RangeError`（同 `Buffer#readUInt*BE`）。 */
export function readU16be(source: Uint8Array, offset = 0): number {
  return view(source).getUint16(offset);
}

export function readU32be(source: Uint8Array, offset = 0): number {
  return view(source).getUint32(offset);
}

export function readU64be(source: Uint8Array, offset = 0): bigint {
  return view(source).getBigUint64(offset);
}

export function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  writeU16be(out, value);
  return out;
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  writeU32be(out, value);
  return out;
}

export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  writeU64be(out, value);
  return out;
}

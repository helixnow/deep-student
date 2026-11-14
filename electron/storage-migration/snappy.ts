/**
 * Snappy 原始格式解压（LevelDB 数据块 `kSnappyCompression`）。只读路径，不引入原生依赖。
 * 格式：varint32 解压后长度 + 元素序列（literal / 1、2、4 字节偏移的回溯复制）。
 */

export class SnappyError extends Error {
  constructor(message: string) {
    super(`snappy: ${message}`);
    this.name = 'SnappyError';
  }
}

function readLengthPrefix(input: Uint8Array): { length: number; offset: number } {
  let length = 0;
  let shift = 0;
  let offset = 0;
  for (;;) {
    if (offset >= input.length || shift > 28) throw new SnappyError('truncated length prefix');
    const byte = input[offset]!;
    offset += 1;
    length += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (length > 0xffffffff) throw new SnappyError('length prefix overflows uint32');
  return { length, offset };
}

export function snappyDecompress(input: Uint8Array): Uint8Array {
  const prefix = readLengthPrefix(input);
  const out = new Uint8Array(prefix.length);
  let pos = prefix.offset;
  let op = 0;
  while (pos < input.length) {
    const tag = input[pos]!;
    pos += 1;
    const kind = tag & 3;
    if (kind === 0) {
      let length = tag >>> 2;
      if (length >= 60) {
        const extra = length - 59;
        if (pos + extra > input.length) throw new SnappyError('truncated literal length');
        length = 0;
        for (let index = 0; index < extra; index += 1) length += input[pos + index]! * 2 ** (8 * index);
        pos += extra;
      }
      length += 1;
      if (pos + length > input.length) throw new SnappyError('literal runs past input');
      if (op + length > out.length) throw new SnappyError('literal overflows declared length');
      out.set(input.subarray(pos, pos + length), op);
      pos += length;
      op += length;
      continue;
    }
    let length: number;
    let distance: number;
    if (kind === 1) {
      if (pos >= input.length) throw new SnappyError('truncated copy-1');
      length = ((tag >>> 2) & 7) + 4;
      distance = ((tag >>> 5) << 8) | input[pos]!;
      pos += 1;
    } else if (kind === 2) {
      if (pos + 2 > input.length) throw new SnappyError('truncated copy-2');
      length = (tag >>> 2) + 1;
      distance = input[pos]! | (input[pos + 1]! << 8);
      pos += 2;
    } else {
      if (pos + 4 > input.length) throw new SnappyError('truncated copy-4');
      length = (tag >>> 2) + 1;
      distance = (input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16)) + input[pos + 3]! * 2 ** 24;
      pos += 4;
    }
    if (distance === 0 || distance > op) throw new SnappyError('copy offset outside output');
    if (op + length > out.length) throw new SnappyError('copy overflows declared length');
    for (let index = 0; index < length; index += 1) out[op + index] = out[op - distance + index]!;
    op += length;
  }
  if (op !== out.length) throw new SnappyError(`decompressed ${op} bytes, header declared ${out.length}`);
  return out;
}

/**
 * `node:buffer` 在 Worker / 页面中的实现：`Buffer` 是 `Uint8Array` 的子类，覆盖 Host 与业务插件常用的
 * 编码（utf8 / hex / base64 / base64url / latin1 / ascii）与拼接、比较、切片接口。没有的接口就是没有（调用时报 TypeError）。
 */
export type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii' | 'utf16le' | 'ucs2';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function normalizeEncoding(encoding: string | undefined): BufferEncoding {
  const lower = (encoding ?? 'utf8').toLowerCase();
  switch (lower) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'hex': case 'base64': case 'base64url': case 'latin1': case 'ascii': return lower;
    case 'binary': return 'latin1';
    case 'utf16le': case 'utf-16le': case 'ucs2': case 'ucs-2': return 'utf16le';
    default: throw new TypeError(`Unknown encoding: ${encoding}`);
  }
}

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function encode(text: string, encoding: BufferEncoding): Uint8Array {
  switch (encoding) {
    case 'utf8': case 'utf-8': return encoder.encode(text);
    case 'hex': {
      const length = text.length >>> 1;
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) return out.subarray(0, i);
        out[i] = byte;
      }
      return out;
    }
    case 'base64': case 'base64url': return base64ToBytes(text);
    case 'latin1': case 'binary': case 'ascii': {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
    case 'utf16le': case 'ucs2': {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >>> 8;
      }
      return out;
    }
  }
}

function decode(bytes: Uint8Array, encoding: BufferEncoding): string {
  switch (encoding) {
    case 'utf8': case 'utf-8': return decoder.decode(bytes);
    case 'hex': {
      let out = '';
      for (const byte of bytes) out += HEX[byte];
      return out;
    }
    case 'base64': return bytesToBase64(bytes);
    case 'base64url': return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    case 'latin1': case 'binary': {
      let out = '';
      for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return out;
    }
    case 'ascii': {
      let out = '';
      for (const byte of bytes) out += String.fromCharCode(byte & 0x7f);
      return out;
    }
    case 'utf16le': case 'ucs2': {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
      return out;
    }
  }
}

export class Buffer extends Uint8Array {
  static override from<T>(value: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): Buffer;
  static override from(value: Iterable<number>, mapfn?: (value: number, index: number) => number, thisArg?: unknown): Buffer;
  static override from(value: string | ArrayBuffer | ArrayBufferView | ArrayLike<number> | Iterable<number>, encodingOrOffset?: string | number, length?: number): Buffer;
  static override from(value: any, encodingOrOffset?: string | number | ((value: any, index: number) => number), length?: any): Buffer {
    if (typeof encodingOrOffset === 'function') {
      return Buffer.from(Array.from(value as ArrayLike<unknown>, encodingOrOffset, length));
    }
    if (typeof value === 'string') {
      const bytes = encode(value, normalizeEncoding(encodingOrOffset as string | undefined));
      return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      const offset = (encodingOrOffset as number | undefined) ?? 0;
      return new Buffer(value as ArrayBuffer, offset, length ?? value.byteLength - offset);
    }
    if (ArrayBuffer.isView(value)) {
      const copy = new Buffer(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return copy;
    }
    const array = Array.from(value as ArrayLike<number>);
    const out = new Buffer(array.length);
    out.set(array);
    return out;
  }

  static alloc(size: number, fill?: number | string, encoding?: string): Buffer {
    const out = new Buffer(size);
    if (fill !== undefined) out.fill(fill as number, 0, size, encoding);
    return out;
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size);
  }

  static isBuffer(value: unknown): value is Buffer {
    return value instanceof Buffer;
  }

  static isEncoding(encoding: string): boolean {
    try {
      normalizeEncoding(encoding);
      return true;
    } catch {
      return false;
    }
  }

  static byteLength(value: string | ArrayBuffer | ArrayBufferView, encoding?: string): number {
    if (typeof value === 'string') return encode(value, normalizeEncoding(encoding)).byteLength;
    return value.byteLength;
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
    const out = new Buffer(total);
    let offset = 0;
    for (const item of list) {
      if (offset >= total) break;
      const chunk = item.subarray(0, total - offset);
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  static compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  override toString(encoding?: string, start = 0, end = this.length): string {
    return decode(this.subarray(start, end), normalizeEncoding(encoding));
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }

  equals(other: Uint8Array): boolean {
    return Buffer.compare(this, other) === 0;
  }

  compare(other: Uint8Array): -1 | 0 | 1 {
    return Buffer.compare(this, other);
  }

  write(text: string, offset = 0, encoding?: string): number {
    const bytes = encode(text, normalizeEncoding(encoding)).subarray(0, Math.max(0, this.length - offset));
    this.set(bytes, offset);
    return bytes.length;
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const chunk = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + target.length - targetStart));
    target.set(chunk, targetStart);
    return chunk.length;
  }

  // Node 的 `slice` 与 `subarray` 一样共享内存（Uint8Array.prototype.slice 是复制）。
  override slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end);
  }

  override subarray(start?: number, end?: number): Buffer {
    const view = Uint8Array.prototype.subarray.call(this, start, end);
    return new Buffer(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }

  override fill(value: number | string, start = 0, end = this.length, encoding?: string): this {
    if (typeof value === 'number') return super.fill(value, start, end);
    const bytes = encode(value, normalizeEncoding(encoding));
    if (bytes.length === 0) return super.fill(0, start, end);
    for (let i = start; i < end; i++) this[i] = bytes[(i - start) % bytes.length]!;
    return this;
  }

  readUInt8(offset = 0): number {
    return this.view().getUint8(offset);
  }

  readUInt16BE(offset = 0): number {
    return this.view().getUint16(offset, false);
  }

  readUInt16LE(offset = 0): number {
    return this.view().getUint16(offset, true);
  }

  readUInt32BE(offset = 0): number {
    return this.view().getUint32(offset, false);
  }

  readUInt32LE(offset = 0): number {
    return this.view().getUint32(offset, true);
  }

  writeUInt32BE(value: number, offset = 0): number {
    this.view().setUint32(offset, value, false);
    return offset + 4;
  }

  writeUInt32LE(value: number, offset = 0): number {
    this.view().setUint32(offset, value, true);
    return offset + 4;
  }

  private view(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }
}

export const constants = { MAX_LENGTH: 2 ** 32 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 };
export const kMaxLength = constants.MAX_LENGTH;
const BlobCtor = globalThis.Blob;
export { BlobCtor as Blob };

export default { Buffer, constants, kMaxLength, Blob: BlobCtor };

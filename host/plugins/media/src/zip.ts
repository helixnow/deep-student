/**
 * Minimal read-only ZIP central-directory reader used by the document guards, the
 * EPUB parser and the Office fidelity inspector. Supports stored and deflated
 * entries (the two methods produced by Office/zip writers); ZIP64 is not read.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Buffer;
}

export interface ZipDirectoryEntry {
  name: string;
  method: number;
  /** 中央目录声明的解压后大小（不可信，可能被伪造）。 */
  declaredSize: number;
  compressedSize: number;
  localOffset: number;
}

const EOCD = 0x0605_4b50;
const CENTRAL = 0x0201_4b50;
const LOCAL = 0x0403_4b50;

export function zipDirectory(bytes: Uint8Array): ZipDirectoryEntry[] | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let eocd = -1;
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= earliest; i -= 1) {
    if (i >= 0 && buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffff_ffff || offset > buffer.length) return null;
  const entries: ZipDirectoryEntry[] = [];
  let pos = offset;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL) return null;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const declaredSize = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    if (pos + 46 + nameLength > buffer.length) return null;
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.push({ name, method, declaredSize, compressedSize, localOffset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * 读取单个条目内容。`maxOutputLength` 限制真实解压字节数：超过时
 * `node:zlib` 抛出 `ERR_BUFFER_TOO_LARGE`（ZIP Bomb 判定依据）。
 * 结构损坏或未知压缩方法返回 null。
 */
export function zipEntryData(
  bytes: Uint8Array,
  entry: ZipDirectoryEntry,
  maxOutputLength?: number,
): Buffer | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const pos = entry.localOffset;
  if (pos + 30 > buffer.length || buffer.readUInt32LE(pos) !== LOCAL) return null;
  const nameLength = buffer.readUInt16LE(pos + 26);
  const extraLength = buffer.readUInt16LE(pos + 28);
  const start = pos + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > buffer.length || end > buffer.length) return null;
  const compressed = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) {
    return inflateRawSync(compressed,
      maxOutputLength === undefined ? {} : { maxOutputLength });
  }
  return null;
}

/** 条目名（不读内容）；不是可解析的 ZIP 时返回 null。 */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  const entries = zipDirectory(bytes);
  return entries === null ? null : entries.map(entry => entry.name);
}

/** 读取全部文件条目；目录条目跳过，未知压缩方法或损坏结构返回 null。 */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const entries = zipDirectory(bytes);
  if (entries === null) return null;
  const result: ZipEntry[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    let content: Buffer | null;
    try { content = zipEntryData(bytes, entry); }
    catch { return null; }
    if (content === null) return null;
    result.push({ name: entry.name.replace(/\\/g, '/'), bytes: content });
  }
  return result;
}

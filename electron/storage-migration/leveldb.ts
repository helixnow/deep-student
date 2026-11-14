/**
 * 只读 LevelDB 读取器，用于 WebView2（Chromium）`Local Storage/leveldb` 的**快照副本**。
 *
 * 只实现读出当前可见键值所需的部分（leveldb `doc/log_format.md`、`doc/table_format.md`、
 * `db/version_edit.cc`）：CURRENT → MANIFEST 求出存活的 table 与 log，按序列号合并，
 * 删除标记生效。校验每条 log 记录与每个 block 的 masked CRC32C；块压缩支持 none / snappy。
 * 不写任何文件，也不做 compaction。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snappyDecompress } from './snappy.ts';

export class LevelDbCorruption extends Error {
  constructor(message: string) {
    super(`leveldb: ${message}`);
    this.name = 'LevelDbCorruption';
  }
}

export interface LevelDbRecord {
  readonly key: Buffer;
  readonly value: Buffer;
}

const BLOCK_SIZE = 32768;
const HEADER_SIZE = 7;
const RECORD_FULL = 1;
const RECORD_FIRST = 2;
const RECORD_MIDDLE = 3;
const RECORD_LAST = 4;
const TYPE_DELETION = 0;
const TYPE_VALUE = 1;
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const FOOTER_SIZE = 48;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(chunks: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      crc = CRC32C_TABLE[(crc ^ chunk[index]!) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function maskCrc(crc: number): number {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

class Cursor {
  offset = 0;
  readonly data: Uint8Array;
  readonly what: string;

  // Electron main 以 Node 类型剥离运行本文件，不支持构造参数属性。
  constructor(data: Uint8Array, what: string) {
    this.data = data;
    this.what = what;
  }

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  byte(): number {
    if (this.offset >= this.data.length) throw new LevelDbCorruption(`${this.what}: unexpected end`);
    const value = this.data[this.offset]!;
    this.offset += 1;
    return value;
  }

  varint(maxBits: 32 | 64): number {
    let result = 0;
    for (let shift = 0; shift < maxBits; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw new LevelDbCorruption(`${this.what}: varint exceeds 2^53`);
        return result;
      }
    }
    throw new LevelDbCorruption(`${this.what}: varint too long`);
  }

  bytes(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw new LevelDbCorruption(`${this.what}: slice runs past end`);
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  lengthPrefixed(): Uint8Array {
    return this.bytes(this.varint(32));
  }
}

function u32(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) + data[offset + 3]! * 2 ** 24;
}

/** leveldb `log::Reader`：返回完整的逻辑记录。文件尾部被截断的记录按 EOF 处理（写入方崩溃的正常形态）。 */
export function readLogRecords(data: Uint8Array, what: string): Uint8Array[] {
  const records: Uint8Array[] = [];
  let fragments: Uint8Array[] | null = null;
  let pos = 0;
  while (pos < data.length) {
    const blockRemaining = BLOCK_SIZE - (pos % BLOCK_SIZE);
    if (blockRemaining < HEADER_SIZE) {
      pos += blockRemaining;
      continue;
    }
    if (pos + HEADER_SIZE > data.length) break;
    const storedCrc = u32(data, pos);
    const length = data[pos + 4]! | (data[pos + 5]! << 8);
    const type = data[pos + 6]!;
    if (type === 0 && length === 0) {
      pos += blockRemaining;
      continue;
    }
    if (HEADER_SIZE + length > blockRemaining) throw new LevelDbCorruption(`${what}: record crosses a block boundary at ${pos}`);
    if (pos + HEADER_SIZE + length > data.length) break;
    const payload = data.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + length);
    if (maskCrc(crc32c([Uint8Array.of(type), payload])) !== storedCrc) {
      throw new LevelDbCorruption(`${what}: checksum mismatch at ${pos}`);
    }
    pos += HEADER_SIZE + length;
    switch (type) {
      case RECORD_FULL:
        if (fragments !== null) throw new LevelDbCorruption(`${what}: FULL record inside a fragmented record`);
        records.push(payload);
        break;
      case RECORD_FIRST:
        if (fragments !== null) throw new LevelDbCorruption(`${what}: FIRST record inside a fragmented record`);
        fragments = [payload];
        break;
      case RECORD_MIDDLE:
        if (fragments === null) throw new LevelDbCorruption(`${what}: MIDDLE record without FIRST`);
        fragments.push(payload);
        break;
      case RECORD_LAST:
        if (fragments === null) throw new LevelDbCorruption(`${what}: LAST record without FIRST`);
        fragments.push(payload);
        records.push(Buffer.concat(fragments));
        fragments = null;
        break;
      default:
        throw new LevelDbCorruption(`${what}: unknown record type ${type}`);
    }
  }
  return records;
}

interface ManifestState {
  logNumber: number;
  prevLogNumber: number;
  files: Map<number, number>;
}

/** `VersionEdit::DecodeFrom` 中与存活文件集合相关的字段。 */
function applyVersionEdit(state: ManifestState, record: Uint8Array): void {
  const cursor = new Cursor(record, 'MANIFEST');
  while (!cursor.done) {
    const tag = cursor.varint(32);
    switch (tag) {
      case 1: cursor.lengthPrefixed(); break;
      case 2: state.logNumber = cursor.varint(64); break;
      case 3: cursor.varint(64); break;
      case 4: cursor.varint(64); break;
      case 5: cursor.varint(32); cursor.lengthPrefixed(); break;
      case 6: {
        cursor.varint(32);
        state.files.delete(cursor.varint(64));
        break;
      }
      case 7: {
        const level = cursor.varint(32);
        const number = cursor.varint(64);
        cursor.varint(64);
        cursor.lengthPrefixed();
        cursor.lengthPrefixed();
        state.files.set(number, level);
        break;
      }
      case 9: state.prevLogNumber = cursor.varint(64); break;
      default:
        throw new LevelDbCorruption(`MANIFEST: unknown VersionEdit tag ${tag}`);
    }
  }
}

interface InternalEntry {
  seq: bigint;
  type: number;
  value: Buffer;
}

type Sink = (key: Uint8Array, seq: bigint, type: number, value: Uint8Array) => void;

function readU64(data: Uint8Array, offset: number): bigint {
  return BigInt(u32(data, offset)) | (BigInt(u32(data, offset + 4)) << 32n);
}

function applyWriteBatch(record: Uint8Array, what: string, sink: Sink): void {
  if (record.length < 12) throw new LevelDbCorruption(`${what}: write batch shorter than its header`);
  let seq = readU64(record, 0);
  const count = u32(record, 8);
  const cursor = new Cursor(record, what);
  cursor.offset = 12;
  for (let index = 0; index < count; index += 1) {
    const type = cursor.byte();
    const key = cursor.lengthPrefixed();
    if (type === TYPE_VALUE) sink(key, seq, type, cursor.lengthPrefixed());
    else if (type === TYPE_DELETION) sink(key, seq, type, new Uint8Array(0));
    else throw new LevelDbCorruption(`${what}: unknown write batch tag ${type}`);
    seq += 1n;
  }
  if (!cursor.done) throw new LevelDbCorruption(`${what}: write batch has trailing bytes`);
}

interface BlockHandle {
  offset: number;
  size: number;
}

function readHandle(cursor: Cursor): BlockHandle {
  return { offset: cursor.varint(64), size: cursor.varint(64) };
}

function readBlock(table: Uint8Array, handle: BlockHandle, what: string): Uint8Array {
  const end = handle.offset + handle.size;
  if (end + 5 > table.length) throw new LevelDbCorruption(`${what}: block handle past end of file`);
  const contents = table.subarray(handle.offset, end);
  const compression = table[end]!;
  if (maskCrc(crc32c([contents, Uint8Array.of(compression)])) !== u32(table, end + 1)) {
    throw new LevelDbCorruption(`${what}: block checksum mismatch at ${handle.offset}`);
  }
  if (compression === 0) return contents;
  if (compression === 1) return snappyDecompress(contents);
  throw new LevelDbCorruption(`${what}: unsupported block compression ${compression}`);
}

function blockEntries(block: Uint8Array, what: string): Array<{ key: Uint8Array; value: Uint8Array }> {
  if (block.length < 4) throw new LevelDbCorruption(`${what}: block too small`);
  const restarts = u32(block, block.length - 4);
  const limit = block.length - 4 - 4 * restarts;
  if (limit < 0) throw new LevelDbCorruption(`${what}: bad restart array`);
  const cursor = new Cursor(block.subarray(0, limit), what);
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  let previous: Uint8Array = new Uint8Array(0);
  while (!cursor.done) {
    const shared = cursor.varint(32);
    const unshared = cursor.varint(32);
    const valueLength = cursor.varint(32);
    if (shared > previous.length) throw new LevelDbCorruption(`${what}: shared prefix longer than previous key`);
    const key = Buffer.concat([previous.subarray(0, shared), cursor.bytes(unshared)]);
    entries.push({ key, value: cursor.bytes(valueLength) });
    previous = key;
  }
  return entries;
}

function readTable(table: Uint8Array, what: string, sink: Sink): void {
  if (table.length < FOOTER_SIZE) throw new LevelDbCorruption(`${what}: file shorter than footer`);
  const footer = table.subarray(table.length - FOOTER_SIZE);
  if (!Buffer.from(footer.subarray(FOOTER_SIZE - 8)).equals(TABLE_MAGIC)) throw new LevelDbCorruption(`${what}: bad table magic`);
  const cursor = new Cursor(footer.subarray(0, FOOTER_SIZE - 8), what);
  readHandle(cursor);
  const index = readBlock(table, readHandle(cursor), what);
  for (const { value } of blockEntries(index, what)) {
    const block = readBlock(table, readHandle(new Cursor(value, what)), what);
    for (const entry of blockEntries(block, what)) {
      if (entry.key.length < 8) throw new LevelDbCorruption(`${what}: internal key shorter than 8 bytes`);
      const trailer = readU64(entry.key, entry.key.length - 8);
      sink(entry.key.subarray(0, entry.key.length - 8), trailer >> 8n, Number(trailer & 0xffn), entry.value);
    }
  }
}

/** 读出数据库当前可见的全部键值（按键的字节序排序）。 */
export function readLevelDb(dir: string): LevelDbRecord[] {
  let current: string;
  try {
    current = readFileSync(join(dir, 'CURRENT'), 'utf8');
  } catch (error) {
    throw new LevelDbCorruption(`CURRENT unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifestName = current.replace(/\n$/, '');
  if (!/^MANIFEST-\d+$/.test(manifestName)) throw new LevelDbCorruption(`CURRENT names ${JSON.stringify(manifestName)}`);
  const state: ManifestState = { logNumber: 0, prevLogNumber: 0, files: new Map() };
  for (const record of readLogRecords(readFileSync(join(dir, manifestName)), manifestName)) applyVersionEdit(state, record);

  const tables = new Map<number, string>();
  const logs = new Map<number, string>();
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.(ldb|sst|log)$/.exec(name);
    if (match === null) continue;
    const number = Number(match[1]);
    if (match[2] === 'log') {
      if (number >= state.logNumber || number === state.prevLogNumber) logs.set(number, name);
    } else {
      tables.set(number, name);
    }
  }

  const latest = new Map<string, InternalEntry>();
  const sink: Sink = (key, seq, type, value) => {
    const id = Buffer.from(key).toString('latin1');
    const existing = latest.get(id);
    if (existing === undefined || existing.seq < seq) latest.set(id, { seq, type, value: Buffer.from(value) });
  };
  for (const number of [...state.files.keys()].sort((a, b) => a - b)) {
    const name = tables.get(number);
    if (name === undefined) throw new LevelDbCorruption(`MANIFEST references missing table ${number}`);
    readTable(readFileSync(join(dir, name)), name, sink);
  }
  for (const [, name] of [...logs].sort(([a], [b]) => a - b)) {
    for (const record of readLogRecords(readFileSync(join(dir, name)), name)) applyWriteBatch(record, name, sink);
  }

  const records: LevelDbRecord[] = [];
  for (const [id, entry] of latest) {
    if (entry.type === TYPE_VALUE) records.push({ key: Buffer.from(id, 'latin1'), value: entry.value });
    else if (entry.type !== TYPE_DELETION) throw new LevelDbCorruption(`unknown value type ${entry.type}`);
  }
  return records.sort((a, b) => Buffer.compare(a.key, b.key));
}

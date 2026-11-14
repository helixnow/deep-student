/**
 * 构造 Tauri 版 WebView 存储文件的测试夹具（只写临时目录）：
 * - WebKit localStorage SQLite（与 DESIGN.md §4 实测的表结构、UTF-16LE 值一致）；
 * - Chromium localStorage LevelDB（log / table / MANIFEST / CURRENT，按 leveldb 文档格式编码）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { crc32c, maskCrc } from '../leveldb.ts';

// ------------------------------------------------------------------ 编码工具

export function utf16le(value: string): Buffer {
  const out = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) out.writeUInt16LE(value.charCodeAt(index), index * 2);
  return out;
}

export function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function lengthPrefixed(bytes: Uint8Array): Buffer {
  return Buffer.concat([varint(bytes.length), bytes]);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

// ------------------------------------------------------------------ snappy（测试用贪心压缩）

export function snappyCompress(input: Uint8Array): Buffer {
  const out: Buffer[] = [varint(input.length)];
  const table = new Map<string, number>();
  let literalStart = 0;
  const flushLiteral = (end: number) => {
    let start = literalStart;
    while (start < end) {
      const length = Math.min(end - start, 65536);
      const n = length - 1;
      if (n < 60) out.push(Buffer.of(n << 2));
      else if (n < 256) out.push(Buffer.of(60 << 2, n));
      else out.push(Buffer.of(61 << 2, n & 0xff, n >> 8));
      out.push(Buffer.from(input.subarray(start, start + length)));
      start += length;
    }
  };
  let pos = 0;
  while (pos + 4 <= input.length) {
    const key = Buffer.from(input.subarray(pos, pos + 4)).toString('latin1');
    const candidate = table.get(key);
    table.set(key, pos);
    if (candidate === undefined || pos - candidate > 0xffff) {
      pos += 1;
      continue;
    }
    let length = 4;
    while (pos + length < input.length && input[candidate + length] === input[pos + length]) length += 1;
    flushLiteral(pos);
    const distance = pos - candidate;
    let remaining = length;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 64);
      if (chunk >= 4 && chunk <= 11 && distance < 2048) out.push(Buffer.of(1 | ((chunk - 4) << 2) | ((distance >> 8) << 5), distance & 0xff));
      else out.push(Buffer.of(2 | ((chunk - 1) << 2), distance & 0xff, distance >> 8));
      remaining -= chunk;
    }
    pos += length;
    literalStart = pos;
  }
  flushLiteral(input.length);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ leveldb

const BLOCK = 32768;

export function encodeLog(records: readonly Uint8Array[]): Buffer {
  const chunks: Buffer[] = [];
  let blockOffset = 0;
  for (const record of records) {
    let left = Buffer.from(record);
    let begin = true;
    do {
      const leftover = BLOCK - blockOffset;
      if (leftover < 7) {
        if (leftover > 0) chunks.push(Buffer.alloc(leftover));
        blockOffset = 0;
      }
      const available = BLOCK - blockOffset - 7;
      const length = Math.min(left.length, available);
      const end = length === left.length;
      const type = begin && end ? 1 : begin ? 2 : end ? 4 : 3;
      const payload = left.subarray(0, length);
      const header = Buffer.alloc(7);
      header.writeUInt32LE(maskCrc(crc32c([Uint8Array.of(type), payload])));
      header.writeUInt16LE(length, 4);
      header[6] = type;
      chunks.push(header, payload);
      blockOffset += 7 + length;
      left = left.subarray(length);
      begin = false;
    } while (left.length > 0);
  }
  return Buffer.concat(chunks);
}

export type BatchOp = { put: Uint8Array; value: Uint8Array } | { del: Uint8Array };

export function encodeBatch(seq: bigint, ops: readonly BatchOp[]): Buffer {
  const parts: Buffer[] = [u64(seq), u32(ops.length)];
  for (const op of ops) {
    if ('put' in op) parts.push(Buffer.of(1), lengthPrefixed(op.put), lengthPrefixed(op.value));
    else parts.push(Buffer.of(0), lengthPrefixed(op.del));
  }
  return Buffer.concat(parts);
}

export interface TableEntry {
  key: Uint8Array;
  seq: bigint;
  deleted?: boolean;
  value?: Uint8Array;
}

function buildBlock(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>, restartInterval: number): Buffer {
  const parts: Buffer[] = [];
  const restarts: number[] = [];
  let offset = 0;
  let previous = Buffer.alloc(0);
  entries.forEach(([key, value], index) => {
    let shared = 0;
    if (index % restartInterval === 0) restarts.push(offset);
    else while (shared < previous.length && shared < key.length && previous[shared] === key[shared]) shared += 1;
    const part = Buffer.concat([varint(shared), varint(key.length - shared), varint(value.length), key.subarray(shared), value]);
    parts.push(part);
    offset += part.length;
    previous = Buffer.from(key);
  });
  if (restarts.length === 0) restarts.push(0);
  return Buffer.concat([...parts, ...restarts.map(u32), u32(restarts.length)]);
}

export function encodeTable(entries: readonly TableEntry[], options: { compress?: boolean; perBlock?: number; restartInterval?: number } = {}): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || (a.seq > b.seq ? -1 : a.seq < b.seq ? 1 : 0));
  const internal = sorted.map((entry) => [
    Buffer.concat([entry.key, u64((entry.seq << 8n) | (entry.deleted === true ? 0n : 1n))]),
    Buffer.from(entry.value ?? new Uint8Array(0)),
  ] as const);
  const perBlock = options.perBlock ?? 4;
  const restartInterval = options.restartInterval ?? 2;
  const out: Buffer[] = [];
  let offset = 0;
  const writeBlock = (raw: Buffer, compress: boolean) => {
    const contents = compress ? snappyCompress(raw) : raw;
    const type = compress ? 1 : 0;
    out.push(contents, Buffer.of(type), u32(maskCrc(crc32c([contents, Uint8Array.of(type)]))));
    const handle = Buffer.concat([varint(offset), varint(contents.length)]);
    offset += contents.length + 5;
    return handle;
  };
  const index: Array<readonly [Buffer, Buffer]> = [];
  for (let start = 0; start < internal.length; start += perBlock) {
    const group = internal.slice(start, start + perBlock);
    index.push([group[group.length - 1]![0], writeBlock(buildBlock(group, restartInterval), options.compress === true)]);
  }
  const meta = writeBlock(buildBlock([], 1), false);
  const indexHandle = writeBlock(buildBlock(index, 1), false);
  const footer = Buffer.alloc(48);
  Buffer.concat([meta, indexHandle]).copy(footer);
  Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]).copy(footer, 40);
  out.push(footer);
  return Buffer.concat(out);
}

export interface VersionEdit {
  logNumber?: number;
  prevLogNumber?: number;
  nextFile?: number;
  lastSeq?: number;
  newFiles?: Array<{ level: number; number: number; size: number }>;
  deletedFiles?: Array<{ level: number; number: number }>;
}

export function encodeVersionEdit(edit: VersionEdit): Buffer {
  const parts: Buffer[] = [varint(1), lengthPrefixed(Buffer.from('leveldb.BytewiseComparator'))];
  if (edit.logNumber !== undefined) parts.push(varint(2), varint(edit.logNumber));
  if (edit.prevLogNumber !== undefined) parts.push(varint(9), varint(edit.prevLogNumber));
  if (edit.nextFile !== undefined) parts.push(varint(3), varint(edit.nextFile));
  if (edit.lastSeq !== undefined) parts.push(varint(4), varint(edit.lastSeq));
  for (const file of edit.deletedFiles ?? []) parts.push(varint(6), varint(file.level), varint(file.number));
  for (const file of edit.newFiles ?? []) {
    parts.push(varint(7), varint(file.level), varint(file.number), varint(file.size),
      lengthPrefixed(Buffer.from('a')), lengthPrefixed(Buffer.from('z')));
  }
  return Buffer.concat(parts);
}

export interface LevelDbLayout {
  manifest: number;
  edits: VersionEdit[];
  tables?: Record<number, Buffer>;
  logs?: Record<number, Buffer>;
  extra?: Record<string, Buffer | string>;
}

export function writeLevelDb(dir: string, layout: LevelDbLayout): void {
  mkdirSync(dir, { recursive: true });
  const manifestName = `MANIFEST-${String(layout.manifest).padStart(6, '0')}`;
  writeFileSync(join(dir, 'CURRENT'), `${manifestName}\n`);
  writeFileSync(join(dir, manifestName), encodeLog(layout.edits.map(encodeVersionEdit)));
  for (const [number, data] of Object.entries(layout.tables ?? {})) writeFileSync(join(dir, `${String(number).padStart(6, '0')}.ldb`), data);
  for (const [number, data] of Object.entries(layout.logs ?? {})) writeFileSync(join(dir, `${String(number).padStart(6, '0')}.log`), data);
  for (const [name, data] of Object.entries(layout.extra ?? {})) writeFileSync(join(dir, name), data);
}

/** Chromium localStorage 数据键：`_<origin>\x00` + 编码前缀 + 键。 */
export function chromiumKey(origin: string, key: string, encoding: 'utf16' | 'latin1' = 'utf16'): Buffer {
  return Buffer.concat([Buffer.from(`_${origin}`, 'latin1'), Buffer.of(0), chromiumString(key, encoding)]);
}

export function chromiumString(value: string, encoding: 'utf16' | 'latin1' = 'utf16'): Buffer {
  return encoding === 'utf16' ? Buffer.concat([Buffer.of(0), utf16le(value)]) : Buffer.concat([Buffer.of(1), Buffer.from(value, 'latin1')]);
}

// ------------------------------------------------------------------ WebKit SQLite

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

export function writeWebKitLocalStorage(file: string, entries: ReadonlyArray<readonly [string, string | Buffer]>, options: { wal?: boolean } = {}): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb };
  const db = new DatabaseSync(file);
  try {
    if (options.wal === true) db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)');
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const [key, value] of entries) insert.run(key, typeof value === 'string' ? utf16le(value) : value);
  } finally {
    db.close();
  }
}

/** 需要优先保证的几类键（作文草稿、恢复回执、学习中心桌面布局、番茄钟）与边界值。 */
export const PRIORITY_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['essay_draft_e1b2', JSON.stringify({ title: '我的妈妈', content: '第一段：……😀', savedAt: 1730900000000 })],
  ['essay_draft_new', '未命名草稿\n第二行'],
  ['deep-student.pending-recovery-receipt', JSON.stringify({ backupId: 'bk_20261101', restoredAt: '2026-11-01T08:00:00Z' })],
  ['learning-hub-desktop', JSON.stringify({ state: { layout: [{ id: 'notes', x: 0, y: 0, w: 6, h: 4 }], pinned: ['qbank'] }, version: 2 })],
  ['pomodoro-storage', JSON.stringify({ state: { focusMinutes: 25, completedToday: 3 }, version: 0 })],
  ['i18nextLng', 'zh-CN'],
  ['empty-value', ''],
  ['lone-surrogate', '\uD800x'],
  ['with-nul', 'a\u0000b'],
  ['huge', 'x'.repeat(70_000)],
];

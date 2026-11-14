/**
 * 可移植 ZIP 核心（`zip/core`）：不经桌面文件适配层，只用内存源/目标与标准 Web 压缩流，
 * 验证与 Rust `zip 0.6.6` 的字节布局、ZIP64、校验与中止语义，以及运行时闭包不触达 Node。
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { analyzeSource, checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import {
  MemoryZipSink, ZIP64_BYTES_THR, ZipEntrySizeMismatchError, ZipFormatError, ZipReader, ZipWriter, crc32Update,
  memoryZipSource, readAllBytes, webZipCodec,
} from '../core/index.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CORE_DIR = join(import.meta.dirname, '..', 'core');
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const encoder = new TextEncoder();

/** 与 `zipgen.rs.txt::pattern` 相同的确定性数据。 */
function pattern(length: number, seed: number): Uint8Array {
  let x = (Math.imul(seed, 2654435761) + 1) >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = i % 7 === 0 ? x & 0xff : 0x61 + (i % 26);
  }
  return out;
}

/** 与 `zip.test.ts` 的 `SMALL_ENTRIES`、Rust 夹具生成器相同的条目序列。 */
const SMALL_ENTRIES: Array<{ name: string; data: Uint8Array | null }> = [
  { name: 'databases', data: null },
  { name: 'databases/chat_v2.db', data: pattern(5000, 1) },
  { name: 'vfs_blobs', data: null },
  { name: 'vfs_blobs/ab', data: null },
  { name: 'vfs_blobs/ab/abcdef.bin', data: pattern(70000, 2) },
  { name: 'manifest.json', data: encoder.encode('{\n  "backup_id": "fixture"\n}') },
  { name: '笔记/文档.md', data: encoder.encode('# 标题\n') },
  { name: 'empty.txt', data: new Uint8Array(0) },
  { name: 'checksums.sha256', data: encoder.encode(`${'0'.repeat(64)}  manifest.json`) },
];

async function writeSmall(compression: 'stored' | 'deflated'): Promise<Uint8Array> {
  const sink = new MemoryZipSink();
  const writer = new ZipWriter(sink);
  for (const entry of SMALL_ENTRIES) {
    if (entry.data === null) await writer.addDirectory(entry.name);
    else await writer.addBytes(entry.name, entry.data, { compression });
  }
  const total = await writer.finish();
  const bytes = sink.bytes();
  expect(bytes.length).toBe(total);
  return bytes;
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

describe('zip/core portability', () => {
  it('core sources mention no Node module, Node global or Node type (even type-only)', () => {
    const files = readdirSync(CORE_DIR).filter(name => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const rel = relative(ROOT, join(CORE_DIR, name));
      expect(analyzeSource(rel, readFileSync(join(CORE_DIR, name), 'utf8')).findings, rel).toEqual([]);
    }
  });

  it('the runtime import closure of zip/core/index.ts never reaches Node', () => {
    expect(checkModulesClosure(ROOT, ['host/platform/zip/core/index.ts'])).toEqual([]);
  });

  it('writes and reads archives in a process without the global Buffer', () => {
    const script = `
      delete globalThis.Buffer;
      const core = await import(${JSON.stringify(pathToFileURL(join(CORE_DIR, 'index.ts')).href)});
      const sink = new core.MemoryZipSink();
      const writer = new core.ZipWriter(sink);
      await writer.addBytes('a.txt', 'hello '.repeat(1000));
      await writer.addBytes('b.bin', new Uint8Array(3000).fill(7), { compression: 'stored' });
      await writer.finish();
      const reader = await core.ZipReader.open(core.memoryZipSource(sink.bytes()));
      const text = new TextDecoder().decode(await reader.readEntry(reader.find('a.txt')));
      const binary = await reader.readEntry(reader.find('b.bin'));
      console.log(JSON.stringify({ buffer: typeof Buffer, text: text.length, binary: binary.every(b => b === 7) && binary.length }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
    expect(result.stderr).not.toMatch(/Error/);
    expect(JSON.parse(result.stdout.trim())).toEqual({ buffer: 'undefined', text: 6000, binary: 3000 });
  });
});

describe('ZipWriter (memory sink, web codec)', () => {
  it('stored output is byte-identical to Rust zip 0.6.6 ZipWriter', async () => {
    expect(await writeSmall('stored')).toEqual(fixture('rust-stored.zip'));
  });

  it('deflated output matches Rust headers, round-trips, and is readable by JSZip', async () => {
    const bytes = await writeSmall('deflated');
    const ours = await ZipReader.open(memoryZipSource(bytes));
    const rust = await ZipReader.open(memoryZipSource(fixture('rust-deflated.zip')));
    const strip = (reader: ZipReader) => reader.entries.map(entry => ({
      name: entry.name, isDirectory: entry.isDirectory, method: entry.method, size: entry.size, crc32: entry.crc32,
      flags: entry.flags, versionMadeBy: entry.versionMadeBy, versionNeeded: entry.versionNeeded,
      dosTime: entry.dosTime, dosDate: entry.dosDate, externalAttributes: entry.externalAttributes,
    }));
    expect(strip(ours)).toEqual(strip(rust));
    const zip = await JSZip.loadAsync(bytes);
    for (const entry of SMALL_ENTRIES) {
      if (entry.data === null) continue;
      expect(await ours.readEntry(ours.find(entry.name)!)).toEqual(entry.data);
      expect(new Uint8Array(await zip.file(entry.name)!.async('uint8array'))).toEqual(entry.data);
    }
  });

  it('accepts ReadableStream and async-iterable sources and reports size and CRC per entry', async () => {
    const data = pattern(200_000, 4);
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    const fromStream = await writer.addStream('s.bin', new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < data.length; offset += 65_536) controller.enqueue(data.subarray(offset, offset + 65_536));
        controller.close();
      },
    }));
    async function* chunks() { yield data.subarray(0, 10); yield data.subarray(10); }
    const seen: number[] = [];
    const fromIterable = await writer.addStream('i.bin', chunks(), { compression: 'stored', onData: chunk => seen.push(chunk.length) });
    await writer.finish();
    expect(fromStream).toMatchObject({ size: data.length, crc32: zlib.crc32(data) });
    expect(fromIterable).toMatchObject({ size: data.length, compressedSize: data.length, crc32: zlib.crc32(data) });
    expect(seen).toEqual([10, data.length - 10]);
    const reader = await ZipReader.open(memoryZipSource(sink.bytes()));
    expect(await reader.readEntry(reader.find('s.bin')!)).toEqual(data);
    expect(await reader.readEntry(reader.find('i.bin')!)).toEqual(data);
  });

  it('writes the 20-byte local ZIP64 field for large_file entries', async () => {
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    await writer.addBytes('a.bin', pattern(1000, 3), { zip64: true });
    await writer.finish();
    const bytes = sink.bytes();
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(18, true)).toBe(ZIP64_BYTES_THR);
    expect(view.getUint16(28, true)).toBe(20);
    expect(view.getBigUint64(30 + 'a.bin'.length + 4, true)).toBe(1000n);
    const reader = await ZipReader.open(memoryZipSource(bytes));
    expect(await reader.readEntry(reader.entries[0]!)).toEqual(pattern(1000, 3));
  });

  it('70000 entries: byte-identical to Rust (ZIP64 EOCD) without touching the file system', async () => {
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    for (let i = 0; i < 70_000; i += 1) {
      await writer.addBytes(`files/${String(i).padStart(6, '0')}.txt`, `entry ${i}\n`, { compression: 'stored' });
    }
    await writer.finish();
    const bytes = sink.bytes();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('aafd96e5b36890e3b17550f791d4420388ab0502d15df03ebe7a978addae502f');
    const reader = await ZipReader.open(memoryZipSource(bytes));
    expect(reader.entries.length).toBe(70_000);
    expect(new TextDecoder().decode(await reader.readEntry(reader.entries[69_999]!))).toBe('entry 69999\n');
  }, 60_000);

  it('fails the writer when onData throws and rejects further writes', async () => {
    const writer = new ZipWriter(new MemoryZipSink());
    await expect(writer.addBytes('x', 'data', { onData: () => { throw new Error('hash failed'); } })).rejects.toThrow('hash failed');
    expect(writer.state).toBe('failed');
    await expect(writer.addBytes('y', 'y')).rejects.toThrow('ZipWriter is failed');
  });

  it('the web codec refuses an explicit non-default level instead of silently ignoring it', async () => {
    const writer = new ZipWriter(new MemoryZipSink());
    await expect(writer.addBytes('x', 'data', { level: 9 })).rejects.toThrow(RangeError);
  });
});

describe('ZipReader (memory source, web codec)', () => {
  it('reads Rust deflated fixtures with UTF-8 names, directories and CRC verification', async () => {
    const reader = await ZipReader.open(memoryZipSource(fixture('rust-deflated.zip')));
    expect(reader.entries.map(entry => entry.name))
      .toEqual(SMALL_ENTRIES.map(entry => entry.data === null ? `${entry.name}/` : entry.name));
    for (const entry of SMALL_ENTRIES) {
      if (entry.data !== null) expect(await reader.readEntry(reader.find(entry.name)!)).toEqual(entry.data);
    }
  });

  it('fails with Invalid checksum when stored data is corrupted', async () => {
    const bytes = fixture('rust-stored.zip');
    const index = Buffer.from(bytes).indexOf(Buffer.from('"backup_id"'));
    bytes[index + 2] = bytes[index + 2]! ^ 0xff;
    const reader = await ZipReader.open(memoryZipSource(bytes));
    const error = await reader.readEntry(reader.find('manifest.json')!).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZipFormatError);
    expect((error as Error).message).toBe('Invalid checksum');
  });

  it('stops a deflate bomb as soon as output exceeds the declared size', async () => {
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    await writer.addBytes('bomb.bin', new Uint8Array(8 * 1024 * 1024));
    await writer.finish();
    const bytes = sink.bytes();
    const central = Buffer.from(bytes).lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    new DataView(bytes.buffer).setUint32(central + 24, 1024, true);
    const reader = await ZipReader.open(memoryZipSource(bytes));
    const error = await reader.readEntry(reader.entries[0]!).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZipEntrySizeMismatchError);
    expect((error as ZipEntrySizeMismatchError).truncated).toBe(true);
    expect((error as ZipEntrySizeMismatchError).actual).toBeLessThanOrEqual(1024 + 256 * 1024);
  });

  it('propagates onData budget errors and stops reading on cancel', async () => {
    const reader = await ZipReader.open(memoryZipSource(fixture('rust-deflated.zip')));
    const budget = await reader.openEntry(reader.find('vfs_blobs/ab/abcdef.bin')!, {
      onData: (_bytes, total) => { if (total > 1000) throw new Error('budget exceeded'); },
    });
    await expect(readAllBytes(budget)).rejects.toThrow('budget exceeded');

    let reads = 0;
    const source = memoryZipSource(fixture('rust-stored.zip'));
    const counting = { size: source.size, read: (position: number, length: number) => { reads += 1; return source.read(position, length); } };
    const cancelled = await (await ZipReader.open(counting)).openEntry((await ZipReader.open(source)).find('vfs_blobs/ab/abcdef.bin')!);
    const before = reads;
    await cancelled.cancel('stop');
    expect(reads).toBe(before);
  });

  it('rejects encrypted entries, unsupported methods, missing EOCD and too many entries', async () => {
    const base = fixture('rust-stored.zip');
    const central = Buffer.from(base).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

    const encrypted = base.slice();
    new DataView(encrypted.buffer).setUint16(central + 8, 1, true);
    const encReader = await ZipReader.open(memoryZipSource(encrypted));
    await expect(encReader.openEntry(encReader.entries[0]!)).rejects.toThrow('Password required to decrypt file');

    const method = base.slice();
    new DataView(method.buffer).setUint16(central + 10, 12, true);
    const methodReader = await ZipReader.open(memoryZipSource(method));
    expect(methodReader.entries[0]!.compression).toBe('unsupported');
    await expect(methodReader.openEntry(methodReader.entries[0]!)).rejects.toThrow('Compression method not supported');

    await expect(ZipReader.open(memoryZipSource(base.subarray(0, base.length - 22)))).rejects.toBeInstanceOf(ZipFormatError);
    await expect(ZipReader.open(memoryZipSource(base), { maxEntries: 3 })).rejects.toThrow('too many entries: 9 > 3');
  });
});

it('RF-W08-zip64-eocd-at-65535-entries: exactly 65535 entries get a ZIP64 end record and stay readable', async () => {
  const sink = new MemoryZipSink();
  const writer = new ZipWriter(sink);
  for (let i = 0; i < 65_535; i += 1) await writer.addBytes(`f/${i}`, '', { compression: 'stored' });
  await writer.finish();
  const bytes = sink.bytes();
  const tail = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 98, 98);
  // zip 0.6.6 只在 > 65535 时写 ZIP64；这里 EOCD 的 0xFFFF 有对应的 ZIP64 EOCD + 定位器。
  expect(tail.getUint32(0, true)).toBe(0x06064b50);
  expect(tail.getBigUint64(32, true)).toBe(65_535n);
  expect(tail.getUint32(56, true)).toBe(0x07064b50);
  expect(tail.getUint32(76, true)).toBe(0x06054b50);
  expect(tail.getUint16(76 + 10, true)).toBe(0xffff);
  expect((await ZipReader.open(memoryZipSource(bytes))).entries).toHaveLength(65_535);
  expect(Object.keys((await JSZip.loadAsync(bytes)).files)).toHaveLength(65_535);
}, 60_000);

it('RF-W08-zip64-large-entry-without-error: a size hint of 4GiB or more switches the entry to ZIP64 instead of failing', async () => {
  const localExtraLength = async (options: Parameters<ZipWriter['addStream']>[2]): Promise<number> => {
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    await writer.addStream('a.bin', [pattern(100, 5)], options);
    await writer.finish();
    return new DataView(sink.bytes().buffer).getUint16(28, true);
  };
  // zip 0.6.6 的 FileOptions::default()（large_file=false）在条目写过 4GiB 时报 'Large file option has not been set'。
  expect(await localExtraLength({ compression: 'stored', sizeHint: ZIP64_BYTES_THR })).toBe(20);
  expect(await localExtraLength({ compression: 'deflated', sizeHint: ZIP64_BYTES_THR - 1000 })).toBe(20);
  expect(await localExtraLength({ compression: 'stored', sizeHint: ZIP64_BYTES_THR - 1 })).toBe(0);
  expect(await localExtraLength({ compression: 'stored' })).toBe(0);
});

describe('abort paths leave no unhandled rejections', () => {
  async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      await run();
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', listener);
    }
    return seen;
  }

  async function deflatedArchive(size: number): Promise<Uint8Array> {
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    await writer.addBytes('big.bin', new Uint8Array(randomBytes(size)));
    await writer.finish();
    return sink.bytes();
  }

  it('cancelling a partially read deflated entry', async () => {
    const reader = await ZipReader.open(memoryZipSource(await deflatedArchive(4 << 20)));
    expect(await collectUnhandled(async () => {
      const stream = (await reader.openEntry(reader.entries[0]!)).getReader();
      expect((await stream.read()).done).toBe(false);
      await stream.cancel('stop');
    })).toEqual([]);
  });

  it('a sink that fails in the middle of a deflated entry', async () => {
    let writes = 0;
    const writer = new ZipWriter({ async write() { writes += 1; if (writes > 2) throw new Error('disk full'); } });
    expect(await collectUnhandled(async () => {
      await expect(writer.addBytes('big.bin', new Uint8Array(randomBytes(8 << 20)))).rejects.toThrow('disk full');
    })).toEqual([]);
    expect(writer.state).toBe('failed');
  });

  it('corrupt deflate data', async () => {
    const bytes = await deflatedArchive(1 << 20);
    for (let i = 200; i < 400; i += 1) bytes[i] = bytes[i]! ^ 0x5a;
    const reader = await ZipReader.open(memoryZipSource(bytes));
    expect(await collectUnhandled(async () => {
      await expect(reader.readEntry(reader.entries[0]!)).rejects.toThrow();
    })).toEqual([]);
  });
});

describe('crc32Update (pure JS)', () => {
  it('matches zlib.crc32 for every length 0..64 and large buffers, incrementally', () => {
    const data = new Uint8Array(randomBytes(1 << 20));
    for (let length = 0; length <= 64; length += 1) {
      expect(crc32Update(data.subarray(0, length)), `length ${length}`).toBe(zlib.crc32(data.subarray(0, length)));
    }
    let crc = 0;
    for (let offset = 0; offset < data.length; offset += 12_345) crc = crc32Update(data.subarray(offset, offset + 12_345), crc);
    expect(crc).toBe(zlib.crc32(data));
    expect(webZipCodec.crc32(data, 0)).toBe(zlib.crc32(data));
  });
});

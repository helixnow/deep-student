import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ZIP64_BYTES_THR, ZipEntrySizeMismatchError, ZipFileReader, ZipFileWriter, ZipFormatError, crc32Update,
} from '../index.ts';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
/** 慢测试（>4GiB、>65535 条目）开关；见 `__fixtures__/zipgen.rs.txt` 的 Rust 生成器。 */
const SLOW = process.env.DS_ZIP_SLOW_TESTS === '1';

/** 与 `zipgen.rs.txt::pattern` 相同的确定性数据。 */
function pattern(length: number, seed: number): Buffer {
  let x = (Math.imul(seed, 2654435761) + 1) >>> 0;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = i % 7 === 0 ? x & 0xff : 0x61 + (i % 26);
  }
  return out;
}

const SMALL_ENTRIES: Array<{ name: string; data: Buffer | null }> = [
  { name: 'databases', data: null },
  { name: 'databases/chat_v2.db', data: pattern(5000, 1) },
  { name: 'vfs_blobs', data: null },
  { name: 'vfs_blobs/ab', data: null },
  { name: 'vfs_blobs/ab/abcdef.bin', data: pattern(70000, 2) },
  { name: 'manifest.json', data: Buffer.from('{\n  "backup_id": "fixture"\n}') },
  { name: '笔记/文档.md', data: Buffer.from('# 标题\n') },
  { name: 'empty.txt', data: Buffer.alloc(0) },
  { name: 'checksums.sha256', data: Buffer.from(`${'0'.repeat(64)}  manifest.json`) },
];

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function drain(reader: ZipFileReader, name: string): Promise<{ bytes: number; crc: number }> {
  const entry = reader.find(name);
  if (!entry) throw new Error(`missing ${name}`);
  let bytes = 0;
  let crc = 0;
  await pipeline(await reader.openEntryStream(entry), new Writable({
    write(chunk: Buffer, _encoding, callback) { bytes += chunk.length; crc = crc32Update(chunk, crc); callback(); },
  }));
  return { bytes, crc };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ds-zip-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function writeSmall(path: string, compression: 'stored' | 'deflated'): Promise<void> {
  const writer = await ZipFileWriter.create(path);
  for (const entry of SMALL_ENTRIES) {
    if (entry.data === null) await writer.addDirectory(entry.name);
    else await writer.addBuffer(entry.name, entry.data, { compression });
  }
  await writer.finish();
}

describe('ZipFileWriter: zip 0.6.6 layout', () => {
  it('stored output is byte-identical to Rust zip 0.6.6 ZipWriter', async () => {
    const path = join(dir, 'out.zip');
    await writeSmall(path, 'stored');
    expect(await readFile(path)).toEqual(await readFile(join(FIXTURES, 'rust-stored.zip')));
  });

  it('deflated output matches Rust headers except compressed payload', async () => {
    const path = join(dir, 'out.zip');
    await writeSmall(path, 'deflated');
    const ours = await ZipFileReader.open(path);
    const rust = await ZipFileReader.open(join(FIXTURES, 'rust-deflated.zip'));
    try {
      const strip = (reader: ZipFileReader) => reader.entries.map(entry => ({
        name: entry.name, isDirectory: entry.isDirectory, method: entry.method, size: entry.size, crc32: entry.crc32,
        flags: entry.flags, versionMadeBy: entry.versionMadeBy, versionNeeded: entry.versionNeeded,
        dosTime: entry.dosTime, dosDate: entry.dosDate, externalAttributes: entry.externalAttributes,
      }));
      expect(strip(ours)).toEqual(strip(rust));
      for (const entry of SMALL_ENTRIES) {
        if (entry.data === null) continue;
        expect(await ours.readEntry(ours.find(entry.name)!)).toEqual(entry.data);
      }
    } finally {
      await ours.close();
      await rust.close();
    }
  });

  it('writes a 20-byte local ZIP64 field when large_file is requested and stays readable by JSZip', async () => {
    const path = join(dir, 'zip64-local.zip');
    const writer = await ZipFileWriter.create(path);
    await writer.addBuffer('a.bin', pattern(1000, 3), { zip64: true });
    await writer.finish();
    const bytes = await readFile(path);
    expect(bytes.readUInt32LE(18)).toBe(ZIP64_BYTES_THR);
    expect(bytes.readUInt16LE(28)).toBe(20);
    expect(bytes.readBigUInt64LE(30 + 'a.bin'.length + 4)).toBe(1000n);
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('a.bin')!.async('nodebuffer')).toEqual(pattern(1000, 3));
    const reader = await ZipFileReader.open(path);
    try { expect(await reader.readEntry(reader.entries[0]!)).toEqual(pattern(1000, 3)); }
    finally { await reader.close(); }
  });

  it('rejects writes after a failure and removes the target on abort', async () => {
    const source = join(dir, 'missing.bin');
    const path = join(dir, 'out.zip');
    const writer = await ZipFileWriter.create(path);
    await expect(writer.addFile('x', source)).rejects.toThrow(/ENOENT/);
    await writer.addBuffer('y', 'y').catch(() => undefined);
    await writer.abort();
    await expect(stat(path)).rejects.toThrow(/ENOENT/);
  });

  it('refuses to overwrite an existing target by default', async () => {
    const path = join(dir, 'exists.zip');
    await writeFile(path, 'keep');
    await expect(ZipFileWriter.create(path)).rejects.toThrow(/EEXIST/);
    expect(await readFile(path, 'utf8')).toBe('keep');
  });
});

describe('ZipFileReader', () => {
  it('reads Rust deflated fixtures with UTF-8 names, directories and CRC verification', async () => {
    const reader = await ZipFileReader.open(join(FIXTURES, 'rust-deflated.zip'));
    try {
      expect(reader.entries.map(entry => entry.name)).toEqual(SMALL_ENTRIES.map(entry => entry.data === null ? `${entry.name}/` : entry.name));
      expect(reader.entries.filter(entry => entry.isDirectory).length).toBe(3);
      for (const entry of SMALL_ENTRIES) {
        if (entry.data !== null) expect(await reader.readEntry(reader.find(entry.name)!)).toEqual(entry.data);
      }
    } finally { await reader.close(); }
  });

  it('reads JSZip archives (no ZIP64, data descriptors when streamFiles)', async () => {
    const zip = new JSZip();
    zip.file('a/b.txt', 'hello');
    zip.file('c.bin', pattern(20000, 5));
    const path = join(dir, 'jszip.zip');
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', streamFiles: true }));
    const reader = await ZipFileReader.open(path);
    try {
      expect(reader.entries.map(entry => entry.name)).toEqual(['a/', 'a/b.txt', 'c.bin']);
      expect((await reader.readEntry(reader.find('a/b.txt')!)).toString()).toBe('hello');
      expect(await reader.readEntry(reader.find('c.bin')!)).toEqual(pattern(20000, 5));
    } finally { await reader.close(); }
  });

  it('honours data prepended before the archive (zip 0.6.6 archive_offset)', async () => {
    const path = join(dir, 'prefixed.zip');
    await writeFile(path, Buffer.concat([Buffer.from('#!/prefix\n'), await readFile(join(FIXTURES, 'rust-stored.zip'))]));
    const reader = await ZipFileReader.open(path);
    try { expect(await reader.readEntry(reader.find('manifest.json')!)).toEqual(SMALL_ENTRIES[5]!.data); }
    finally { await reader.close(); }
  });

  it('fails with Invalid checksum when stored data is corrupted', async () => {
    const path = join(dir, 'corrupt.zip');
    const bytes = Buffer.from(await readFile(join(FIXTURES, 'rust-stored.zip')));
    const index = bytes.indexOf(Buffer.from('"backup_id"'));
    bytes.writeUInt8(bytes.readUInt8(index + 2) ^ 0xff, index + 2);
    await writeFile(path, bytes);
    const reader = await ZipFileReader.open(path);
    try { await expect(reader.readEntry(reader.find('manifest.json')!)).rejects.toThrow('Invalid checksum'); }
    finally { await reader.close(); }
  });

  it('stops a deflate bomb as soon as output exceeds the declared size', async () => {
    const path = join(dir, 'bomb.zip');
    const writer = await ZipFileWriter.create(path);
    await writer.addBuffer('bomb.bin', Buffer.alloc(8 * 1024 * 1024));
    await writer.finish();
    const bytes = Buffer.from(await readFile(path));
    const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(1024, central + 24);
    await writeFile(path, bytes);
    const reader = await ZipFileReader.open(path);
    try {
      const error = await reader.readEntry(reader.entries[0]!).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ZipEntrySizeMismatchError);
      expect((error as ZipEntrySizeMismatchError).truncated).toBe(true);
      expect((error as ZipEntrySizeMismatchError).actual).toBeLessThanOrEqual(1024 + 256 * 1024);
    } finally { await reader.close(); }
  });

  it('propagates onData budget errors', async () => {
    const reader = await ZipFileReader.open(join(FIXTURES, 'rust-deflated.zip'));
    try {
      const stream = await reader.openEntryStream(reader.find('vfs_blobs/ab/abcdef.bin')!, {
        onData: (_bytes, total) => { if (total > 1000) throw new Error('budget exceeded'); },
      });
      await expect(pipeline(stream, new Writable({ write(_c, _e, cb) { cb(); } }))).rejects.toThrow('budget exceeded');
    } finally { await reader.close(); }
  });

  it('destroying a half-read entry stream or a failing source stream raises no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const path = join(dir, 'big.zip');
      const writer = await ZipFileWriter.create(path);
      await writer.addBuffer('big.bin', randomBytes(4 << 20));
      async function* failing() { yield randomBytes(1 << 20); throw new Error('source read failed'); }
      await expect(writer.addStream('bad.bin', Readable.from(failing()))).rejects.toThrow('source read failed');
      await writer.abort();

      const good = await ZipFileWriter.create(join(dir, 'good.zip'));
      await good.addBuffer('big.bin', randomBytes(4 << 20));
      await good.finish();
      const reader = await ZipFileReader.open(join(dir, 'good.zip'));
      try {
        const stream = await reader.openEntryStream(reader.entries[0]!);
        await new Promise<void>((resolve, reject) => { stream.once('data', () => resolve()); stream.once('error', reject); });
        stream.destroy();
        await new Promise(resolve => stream.once('close', resolve));
      } finally { await reader.close(); }
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(seen).toEqual([]);
  });

  it('rejects encrypted entries, unsupported methods, missing EOCD and too many entries', async () => {
    const base = Buffer.from(await readFile(join(FIXTURES, 'rust-stored.zip')));
    const central = base.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

    const encrypted = Buffer.from(base);
    encrypted.writeUInt16LE(1, central + 8);
    await writeFile(join(dir, 'enc.zip'), encrypted);
    const encReader = await ZipFileReader.open(join(dir, 'enc.zip'));
    await expect(encReader.openEntryStream(encReader.entries[0]!)).rejects.toThrow('Password required to decrypt file');
    await encReader.close();

    const method = Buffer.from(base);
    method.writeUInt16LE(12, central + 10);
    await writeFile(join(dir, 'bz.zip'), method);
    const methodReader = await ZipFileReader.open(join(dir, 'bz.zip'));
    expect(methodReader.entries[0]!.compression).toBe('unsupported');
    await expect(methodReader.openEntryStream(methodReader.entries[0]!)).rejects.toThrow('Compression method not supported');
    await methodReader.close();

    await writeFile(join(dir, 'trunc.zip'), base.subarray(0, base.length - 22));
    await expect(ZipFileReader.open(join(dir, 'trunc.zip'))).rejects.toBeInstanceOf(ZipFormatError);

    await expect(ZipFileReader.open(join(FIXTURES, 'rust-stored.zip'), { maxEntries: 3 }))
      .rejects.toThrow('too many entries: 9 > 3');
  });
});

/** 期望摘要来自 `zipgen.rs.txt`（Rust `zip 0.6.6`）对同一输入生成的归档。 */
describe.skipIf(!SLOW)('ZIP64 (slow, DS_ZIP_SLOW_TESTS=1)', () => {
  it('70000 entries: byte-identical to Rust and readable by both readers', async () => {
    const path = join(dir, 'many.zip');
    const writer = await ZipFileWriter.create(path);
    for (let i = 0; i < 70_000; i += 1) {
      await writer.addBuffer(`files/${String(i).padStart(6, '0')}.txt`, `entry ${i}\n`, { compression: 'stored' });
    }
    await writer.finish();
    expect(await sha256File(path)).toBe('aafd96e5b36890e3b17550f791d4420388ab0502d15df03ebe7a978addae502f');
    const reader = await ZipFileReader.open(path);
    try {
      expect(reader.entries.length).toBe(70_000);
      expect((await reader.readEntry(reader.entries[69_999]!)).toString()).toBe('entry 69999\n');
    } finally { await reader.close(); }
    const zip = await JSZip.loadAsync(await readFile(path));
    expect(Object.keys(zip.files).length).toBe(70_000);
  }, 600_000);

  it('exactly 65535 entries: only the ZIP64 trailer differs from Rust, and Rust layout stays readable', async () => {
    const ours = join(dir, 'ours-65535.zip');
    const writer = await ZipFileWriter.create(ours);
    for (let i = 0; i < 65_535; i += 1) {
      await writer.addBuffer(`files/${String(i).padStart(6, '0')}.txt`, `entry ${i}\n`, { compression: 'stored' });
    }
    await writer.finish();
    const bytes = await readFile(ours);
    const eocd = bytes.length - 22;
    expect(bytes.readUInt32LE(eocd - 20)).toBe(0x07064b50);
    expect(bytes.readUInt32LE(eocd - 76)).toBe(0x06064b50);
    // zip 0.6.6 只在条目数 > 65535 时写 ZIP64 EOCD；去掉 76 字节 ZIP64 记录即为 Rust 的原样输出。
    const rustLayout = Buffer.concat([bytes.subarray(0, eocd - 76), bytes.subarray(eocd)]);
    expect(createHash('sha256').update(rustLayout).digest('hex'))
      .toBe('18963d13cf2181720aa625dbc44b74d1376a2d68f8a2215c326ca6eb3f076cbb');
    const rustPath = join(dir, 'rust-65535.zip');
    await writeFile(rustPath, rustLayout);
    const reader = await ZipFileReader.open(rustPath);
    try {
      expect(reader.entries.length).toBe(65_535);
      expect((await reader.readEntry(reader.entries[65_534]!)).toString()).toBe('entry 65534\n');
    } finally { await reader.close(); }
    await expect(JSZip.loadAsync(rustLayout)).rejects.toThrow(/ZIP64/);
    expect(Object.keys((await JSZip.loadAsync(bytes)).files).length).toBe(65_535);
  }, 600_000);

  it('single deflated entry larger than 4GiB round-trips with ZIP64 sizes', async () => {
    const source = join(dir, 'zeros.bin');
    const size = 4 * 1024 ** 3 + 12345;
    await (await open(source, 'w')).close();
    await truncate(source, size);
    const path = join(dir, 'big-entry.zip');
    const writer = await ZipFileWriter.create(path);
    const written = await writer.addFile('zeros.bin', source);
    await writer.finish();
    expect(written.size).toBe(size);
    const reader = await ZipFileReader.open(path);
    try {
      expect(reader.entries[0]!.size).toBe(size);
      const { bytes } = await drain(reader, 'zeros.bin');
      expect(bytes).toBe(size);
    } finally { await reader.close(); }
  }, 1_200_000);

  it('archive offsets beyond 4GiB: byte-identical to Rust (central ZIP64 extra + ZIP64 EOCD)', async () => {
    const sizes = [2_300_000_000, 2_300_000_000];
    const sources: string[] = [];
    for (const [index, size] of sizes.entries()) {
      const source = join(dir, `sparse-${index}.bin`);
      await (await open(source, 'w')).close();
      await truncate(source, size);
      sources.push(source);
    }
    const path = join(dir, 'big-archive.zip');
    const writer = await ZipFileWriter.create(path);
    await writer.addDirectory('assets');
    for (const [index, source] of sources.entries()) await writer.addFile(`assets/big${index}.bin`, source, { compression: 'stored' });
    await writer.addBuffer('manifest.json', '{}', { compression: 'stored' });
    await writer.finish();
    expect((await stat(path)).size).toBeGreaterThan(ZIP64_BYTES_THR);
    expect(await sha256File(path)).toBe('3c5328179a24240ebca5cbc39bbc259d39a147eee31a23b4863795d559ea18ad');
    const reader = await ZipFileReader.open(path);
    try {
      expect(reader.find('manifest.json')!.localHeaderOffset).toBeGreaterThan(ZIP64_BYTES_THR);
      expect((await reader.readEntry(reader.find('manifest.json')!)).toString()).toBe('{}');
      expect((await drain(reader, 'assets/big1.bin')).bytes).toBe(sizes[1]);
    } finally { await reader.close(); }
  }, 1_800_000);
});

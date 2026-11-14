import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMigratedStorage } from './support/storage.ts';
import * as exportService from '../src/export-service.ts';
import { ExportValidation } from '../repository/portable-shared.ts';
import { readPortableEntries } from '../repository/portable-zip.ts';
import { vfsTestAssetRepos } from './support/vfs-ports.ts';

const MIB = 1024 * 1024;
const MANIFEST = '{"schema_version":2,"assets":[]}';
const DOCUMENT = '{"schema_version":2,"mode":"extract","materials":[],"groups":[],"questions":[{"local_id":"q1",'
  + '"content":"N","question_type":"short_answer"}],"coverage":[],"issues":[],"unmatched_answers":[],'
  + '"sources":[],"source_pages":[]}';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

interface RawEntry {
  name: string;
  data?: Buffer;
  method?: number;
  flags?: number;
  /** Central-directory uncompressed size; defaults to the real size. */
  declaredSize?: number;
  crc?: number;
  /** Raw compressed payload; defaults to deflate/stored of `data`. */
  payload?: Buffer;
  localSignature?: number;
}

/** Hand-rolled archive so every central-directory field can lie. */
function zipOf(entries: RawEntry[], options: { centralSignature?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc ?? crc32(data);
    const size = entry.declaredSize ?? data.length;
    const flags = (entry.flags ?? 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(entry.localSignature ?? 0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(options.centralSignature ?? 0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const valid = (): RawEntry[] => [
  { name: 'document.json', data: Buffer.from(DOCUMENT, 'utf8') },
  { name: 'manifest.json', data: Buffer.from(MANIFEST, 'utf8') },
];

async function withImportHost<T>(run: (host: exportService.ImportHost) => Promise<T>): Promise<T> {
  const { storage, base } = await createMigratedStorage('qbank-portable-zip-');
  try {
    return await run({ db: storage.database('vfs'), blobsDir: `${base}/vfs_blobs`, vfsRepo: vfsTestAssetRepos() });
  } finally {
    storage.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function importError(archive: Buffer, platform?: 'darwin' | 'win32' | 'linux'): Promise<unknown> {
  return withImportHost(async host => {
    try {
      await exportService.importPackage({ ...host, ...(platform === undefined ? {} : { platform }) },
        archive.toString('base64'));
    } catch (error) {
      return (error as { appError?: unknown }).appError ?? error;
    }
    return 'imported';
  });
}

const database = (message: string) => ({ error_type: 'Database', message, details: null });
const validation = (message: string) => ({ error_type: 'Validation', message, details: null });

// authoring.rs:198-220 import_portable: ZipArchive::new / by_index / read_to_end → map_err(error)（Database，zip 0.6.6 Display）。
describe('qbank portable import: zip limits and zip-crate error texts (authoring.rs:198-220)', () => {
  it('S01-M1: a declared uncompressed total above 200 MiB is refused before inflating', async () => {
    const archive = zipOf([
      { name: 'manifest.json', data: Buffer.from('{}'), declaredSize: 120 * MIB },
      { name: 'document.json', data: Buffer.from('{}'), declaredSize: 120 * MIB },
    ]);
    expect(await importError(archive)).toEqual(validation('便携包解压超过安全限制'));
  });

  it('directory entries are skipped before the path check (is_dir → continue), even when repeated', async () => {
    const archive = zipOf([{ name: 'assets/' }, { name: 'assets/' }, ...valid()]);
    expect(await importError(archive)).toBe('imported');
  });

  it('a directory entry still goes through by_index (local header and method are checked)', async () => {
    const archive = zipOf([{ name: 'assets/', localSignature: 0x12345678 }, ...valid()]);
    expect(await importError(archive)).toEqual(database('invalid Zip archive: Invalid local file header'));
  });

  it('entries without an enclosed_name are refused like duplicates', async () => {
    for (const name of ['../evil.json', '/abs.json', 'a/../../b.json', 'nul\0.json']) {
      expect(await importError(zipOf([...valid(), { name, data: Buffer.from('x') }]))).toEqual(
        validation('便携包包含无效或重复路径'));
    }
    expect(await importError(zipOf([...valid(), { name: 'manifest.json', data: Buffer.from(MANIFEST) }])))
      .toEqual(validation('便携包包含无效或重复路径'));
    expect(await importError(zipOf([...valid(), { name: 'a/./../b.json', data: Buffer.from('x') }]))).toBe('imported');
  });

  it('enclosed_name follows the host path flavor (Windows prefixes and backslash components)', async () => {
    const backslash = zipOf([...valid(), { name: 'a\\..\\..\\b.json', data: Buffer.from('x') }]);
    expect(await importError(backslash, 'linux')).toBe('imported');
    expect(await importError(backslash, 'win32')).toEqual(validation('便携包包含无效或重复路径'));
    const drive = zipOf([...valid(), { name: 'C:x.json', data: Buffer.from('x') }]);
    expect(await importError(drive, 'darwin')).toBe('imported');
    expect(await importError(drive, 'win32')).toEqual(validation('便携包包含无效或重复路径'));
  });

  it('V05-04: archive-level damage reports zip 0.6.6 ZipError Display as Database', async () => {
    expect(await importError(Buffer.from('not a zip'))).toEqual(database('invalid Zip archive: Invalid zip header'));
    expect(await importError(Buffer.alloc(64, 0x41))).toEqual(
      database('invalid Zip archive: Could not find central directory end'));
    expect(await importError(zipOf(valid(), { centralSignature: 0x02014b51 }))).toEqual(
      database('invalid Zip archive: Invalid Central Directory header'));
    expect(await importError(zipOf([{ ...valid()[0]!, localSignature: 0 }, valid()[1]!]))).toEqual(
      database('invalid Zip archive: Invalid local file header'));
  });

  it('V05-04: entry-level damage reports zip 0.6.6 / flate2 texts as Database', async () => {
    const [document, manifest] = valid() as [RawEntry, RawEntry];
    expect(await importError(zipOf([{ ...document, method: 14 }, manifest]))).toEqual(
      database('unsupported Zip archive: Compression method not supported'));
    expect(await importError(zipOf([{ ...document, flags: 1 }, manifest]))).toEqual(
      database('unsupported Zip archive: Password required to decrypt file'));
    expect(await importError(zipOf([{ ...document, crc: 1 }, manifest]))).toEqual(database('Invalid checksum'));
    expect(await importError(zipOf([{ ...document, method: 0, crc: 1 }, manifest]))).toEqual(
      database('Invalid checksum'));
    expect(await importError(zipOf([{ ...document, payload: Buffer.from([0xff, 0xff, 0xff, 0x00, 0x01]) }, manifest])))
      .toEqual(database('corrupt deflate stream'));
    // flate2 在输入耗尽时返回 Ok(0)，Crc32Reader 随即报校验失败。
    const truncated = deflateRawSync(Buffer.from(DOCUMENT)).subarray(0, 10);
    expect(await importError(zipOf([{ ...document, payload: truncated }, manifest]))).toEqual(
      database('Invalid checksum'));
  });

  it('declared sizes are not compared with the data: only the CRC at EOF decides (Crc32Reader)', async () => {
    const lying = { name: 'padding.bin', data: Buffer.alloc(4 * MIB, 0x20), declaredSize: 1024 };
    expect(await importError(zipOf([...valid(), lying]))).toBe('imported');
    const short = { name: 'padding.bin', data: Buffer.from('abc'), declaredSize: 1024 };
    expect(await importError(zipOf([...valid(), short]))).toBe('imported');
    expect(await importError(zipOf([...valid(), { ...short, crc: 7 }]))).toEqual(database('Invalid checksum'));
  });

  it('RF-W03-portable-zip-actual-size-bound: inflated bytes count against the same cap as the declared sizes', async () => {
    // Rust 只累计声明大小，每个条目再 take(200 MiB + 1)：两个各声明 1 KiB、各解压出 600 KiB 的条目在 1 MiB 上限下仍被整段读入。
    const lying = (name: string) => ({ name, data: Buffer.alloc(600 * 1024, 0x20), declaredSize: 1024 });
    const archive = zipOf([...valid(), lying('a.bin'), lying('b.bin')]);
    await expect(readPortableEntries(archive, 'linux', MIB)).rejects.toThrow(new ExportValidation('便携包解压超过安全限制'));
    const within = await readPortableEntries(zipOf([...valid(), lying('a.bin')]), 'linux', MIB);
    expect(within.get('a.bin')!.length).toBe(600 * 1024);
    const stored = { ...lying('a.bin'), method: 0 };
    await expect(readPortableEntries(zipOf([stored, { ...stored, name: 'b.bin' }]), 'linux', MIB))
      .rejects.toThrow(new ExportValidation('便携包解压超过安全限制'));
  });
});

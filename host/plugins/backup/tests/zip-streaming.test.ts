/**
 * ZIP 流式化回归：导出布局对齐 Rust `zip 0.6.6`、导入侧 `validate_import_archive` 的全部策略、
 * 热路径不做同步大块 I/O，以及 >2GiB / >4GiB / >65535 条目（`DS_ZIP_SLOW_TESTS=1` 才运行）。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, open, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { ZipFileReader, ZipFileWriter } from '../../../platform/zip/index.ts';
import { exportBackupToZip, importBackupFromZip } from '../src/zip.ts';
import { ENCRYPTED_SECRETS_ENTRY } from '../src/zip-codes.ts';
import { createBackupHost, hostBackupRoot, partialManifest, sha256, writeBackup } from './helpers.ts';

const SLOW = process.env.DS_ZIP_SLOW_TESTS === '1';
const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); }, 120_000);

async function setup(): Promise<TestHost> {
  const { host } = await createBackupHost({ secrets: true });
  hosts.push(host);
  return host;
}

const FILES = {
  'persistent/webview_settings.json': '{"theme":"dark"}',
  'persistent/custom_grading_modes.json': '{"modes":[]}',
};

const importOptions = { password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false };

async function rejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => { throw new Error('expected rejection'); }, (error: unknown) => (error as Error).message);
}

/** 把中央目录第 `index` 个条目的声明大小改写为指定值（只改中央目录，不动数据）。 */
async function forgeCentralSizes(path: string, forged: Array<{ index: number; size: number; compressed: number }>): Promise<void> {
  const bytes = Buffer.from(await readFile(path));
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const starts: number[] = [];
  let at = bytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < bytes.readUInt16LE(eocd + 10); index += 1) {
    starts.push(at);
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  for (const { index, size, compressed } of forged) {
    bytes.writeUInt32LE(compressed, starts[index]! + 20);
    bytes.writeUInt32LE(size, starts[index]! + 24);
  }
  await writeFile(path, bytes);
}

describe('export layout follows Rust zip 0.6.6', () => {
  it('directories, attributes, timestamps, versions and entry order', async () => {
    const host = await setup();
    const manifest = partialManifest('layout', { files: FILES });
    const dir = writeBackup(hostBackupRoot(host), manifest, FILES);
    const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true }, () => undefined, () => false);
    const reader = await ZipFileReader.open(result.zipPath);
    try {
      expect(reader.entries.map(entry => entry.name)).toEqual([
        'manifest.json', 'persistent/', 'persistent/custom_grading_modes.json', 'persistent/webview_settings.json', 'checksums.sha256',
      ]);
      for (const entry of reader.entries) {
        expect(entry.versionMadeBy, entry.name).toBe(0x032e);
        expect(entry.versionNeeded, entry.name).toBe(20);
        expect(entry.dosTime, entry.name).toBe(0);
        expect(entry.dosDate, entry.name).toBe(0x21);
        expect(entry.flags & 0x0008, entry.name).toBe(0);
        if (entry.isDirectory) {
          expect(entry.method).toBe(0);
          expect(entry.externalAttributes >>> 16).toBe(0o40755);
        } else {
          expect(entry.method).toBe(8);
          expect(entry.externalAttributes >>> 16).toBe(0o100644);
        }
      }
      expect((await reader.readEntry(reader.find('checksums.sha256')!)).toString())
        .toContain(`${sha256(FILES['persistent/webview_settings.json'])}  persistent/webview_settings.json`);
    } finally { await reader.close(); }
  });

  it('compression level 0 stores every entry (CompressionMethod::Stored)', async () => {
    const host = await setup();
    const dir = writeBackup(hostBackupRoot(host), partialManifest('stored', { files: FILES }), FILES);
    const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 0, includeChecksums: true }, () => undefined, () => false);
    const reader = await ZipFileReader.open(result.zipPath);
    try { expect(reader.entries.every(entry => entry.method === 0)).toBe(true); }
    finally { await reader.close(); }
  });

  it('sealed payload is stored last-but-checksums and its inner archive has no directory entries', async () => {
    const host = await setup();
    const files = { ...FILES, 'crypto/.secure/.key_seed': 'seed-value', 'crypto/.master_key': 'master' };
    const manifest = partialManifest('sealed-layout', {
      files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed', 'crypto/.master_key'],
    });
    const dir = writeBackup(hostBackupRoot(host), manifest, files);
    const result = await exportBackupToZip(host.ctx, dir, {
      compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    }, () => undefined, () => false);
    const outer = await ZipFileReader.open(result.zipPath);
    let payload: Buffer;
    try {
      const names = outer.entries.map(entry => entry.name);
      expect(names.slice(-2)).toEqual([ENCRYPTED_SECRETS_ENTRY, 'checksums.sha256']);
      const sealed = outer.find(ENCRYPTED_SECRETS_ENTRY)!;
      expect(sealed.method).toBe(0);
      payload = await outer.readEntry(sealed);
    } finally { await outer.close(); }
    const header = Buffer.from('FAKE-DSBK:portable-secret-1\n');
    const innerPath = join(host.app.dataDir, 'inner.zip');
    await writeFile(innerPath, payload.subarray(header.length));
    const inner = await ZipFileReader.open(innerPath);
    try {
      // Rust `validate_secrets_archive` 拒绝目录条目；JSZip 的 createFolders 会隐式补 `crypto/`。
      expect(inner.entries.filter(entry => entry.isDirectory).map(entry => entry.name)).toEqual([]);
      expect(inner.entries.map(entry => entry.name)).toEqual(['manifest.json', 'crypto/.master_key', 'crypto/.secure/.key_seed']);
      expect(inner.entries.every(entry => entry.method === 8)).toBe(true);
    } finally { await inner.close(); }
  });
});

describe('import enforces Rust validate_import_archive policy before extracting', () => {
  async function plainZip(host: TestHost, name: string, entries: Array<[string, Buffer]>): Promise<string> {
    const path = join(host.app.dataDir, name);
    const writer = await ZipFileWriter.create(path);
    for (const [entryName, data] of entries) await writer.addBuffer(entryName, data);
    await writer.finish();
    return path;
  }

  it('rejects an entry whose compression ratio exceeds 200', async () => {
    const host = await setup();
    const zipPath = await plainZip(host, 'ratio.zip', [
      ['manifest.json', Buffer.from('{}')],
      ['persistent/zeros.bin', Buffer.alloc(4 * 1024 * 1024)],
    ]);
    const target = join(host.app.dataDir, 'ratio-target');
    expect(await rejection(importBackupFromZip(host.ctx, zipPath, target, importOptions))).toMatch(/ZIP 压缩比异常: \d+\.\d > 200\.0/);
    expect(fs.existsSync(join(target, 'persistent', 'zeros.bin'))).toBe(false);
  });

  it('rejects declared uncompressed totals above 20 GiB', async () => {
    const host = await setup();
    const entries: Array<[string, Buffer]> = [['manifest.json', Buffer.from('{}')]];
    for (let i = 0; i < 6; i += 1) entries.push([`persistent/part${i}.bin`, Buffer.from(`part-${i}`)]);
    const zipPath = await plainZip(host, 'total.zip', entries);
    await forgeCentralSizes(zipPath, [1, 2, 3, 4, 5, 6].map(index => ({ index, size: 0xf000_0000, compressed: 0x0200_0000 })));
    const target = join(host.app.dataDir, 'total-target');
    expect(await rejection(importBackupFromZip(host.ctx, zipPath, target, importOptions)))
      .toMatch(/ZIP 解压总量超限: \d+ > 21474836480 bytes/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rejects a non-empty entry whose compressed size is zero', async () => {
    const host = await setup();
    const zipPath = await plainZip(host, 'zero.zip', [['manifest.json', Buffer.from('{}')], ['persistent/a.bin', Buffer.from('abc')]]);
    await forgeCentralSizes(zipPath, [{ index: 1, size: 3, compressed: 0 }]);
    expect(await rejection(importBackupFromZip(host.ctx, zipPath, join(host.app.dataDir, 'zero-target'), importOptions)))
      .toBe('ZIP 非空条目压缩大小为零: persistent/a.bin');
  });

  it('trial decryption rejects a sealed payload whose declared size disagrees with its data', async () => {
    const host = await setup();
    const files = { ...FILES, 'crypto/.secure/.key_seed': 'seed-value' };
    const manifest = partialManifest('sealed-size', { files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'] });
    const dir = writeBackup(hostBackupRoot(host), manifest, files);
    const result = await exportBackupToZip(host.ctx, dir, {
      compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    }, () => undefined, () => false);
    const reader = await ZipFileReader.open(result.zipPath);
    const sealed = reader.find(ENCRYPTED_SECRETS_ENTRY)!;
    await reader.close();
    await forgeCentralSizes(result.zipPath, [{ index: sealed.index, size: sealed.size - 1, compressed: sealed.compressedSize }]);
    const target = join(host.app.dataDir, 'sealed-size-target');
    // Rust portable_precheck.rs：`take(declared + 1)` 后比较复制字节数。
    expect(await rejection(importBackupFromZip(host.ctx, result.zipPath, target, { ...importOptions, password: 'portable-secret-1' })))
      .toBe(`密封载荷实际大小与中央目录不一致: expected=${sealed.size - 1}, actual=${sealed.size}`);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('ZIP hot path does no synchronous bulk I/O on the shared event loop', () => {
  it('export + import of a backup with a 4 MiB file reads/writes < 256 KiB synchronously', async () => {
    const host = await setup();
    const big = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) >>> 24;
    const files = { ...FILES, 'persistent/large.bin': big };
    const dir = writeBackup(hostBackupRoot(host), partialManifest('sync-io', { files }), files);

    const cjs = createRequire(import.meta.url)('node:fs') as Record<string, (...args: unknown[]) => unknown>;
    const names = ['readFileSync', 'readSync', 'writeFileSync', 'writeSync', 'copyFileSync'] as const;
    const originals = Object.fromEntries(names.map(name => [name, cjs[name]!]));
    let syncBytes = 0;
    const sized = (value: unknown): number => (typeof value === 'number' ? value
      : typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0);
    cjs.readFileSync = (...args) => { const out = originals.readFileSync!(...args); syncBytes += sized(out); return out; };
    cjs.readSync = (...args) => { const out = originals.readSync!(...args); syncBytes += sized(out); return out; };
    cjs.writeFileSync = (...args) => { syncBytes += sized(args[1]); return originals.writeFileSync!(...args); };
    cjs.writeSync = (...args) => { const out = originals.writeSync!(...args); syncBytes += sized(out); return out; };
    cjs.copyFileSync = (...args) => { syncBytes += fs.statSync(args[0] as string).size; return originals.copyFileSync!(...args); };
    syncBuiltinESMExports();
    try {
      const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true }, () => undefined, () => false);
      await importBackupFromZip(host.ctx, result.zipPath, join(host.app.dataDir, 'sync-io-target'), importOptions);
    } finally {
      Object.assign(cjs, originals);
      syncBuiltinESMExports();
    }
    expect(syncBytes).toBeLessThan(256 * 1024);
  });
});

async function sparseFile(path: string, size: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await (await open(path, 'w')).close();
  await truncate(path, size);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 导出 → 导入一个含大文件的备份；返回导出 ZIP 的布局摘要与峰值 RSS 增量。 */
async function roundTripLarge(host: TestHost, id: string, sizes: number[]) {
  const root = hostBackupRoot(host);
  const dir = join(root, id);
  const manifest = partialManifest(id, { files: FILES });
  for (const [index, size] of sizes.entries()) {
    const relative = `persistent/large-${index}.bin`;
    await sparseFile(join(dir, relative), size);
    manifest.files.push({ path: relative, size, sha256: await sha256Of(join(dir, relative)) });
  }
  writeBackup(root, manifest, FILES);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const zipPath = join(host.app.dataDir, `${id}.zip`);
  const target = join(host.app.dataDir, `${id}-imported`);
  try {
    const started = Date.now();
    const exported = await exportBackupToZip(host.ctx, dir, {
      compressionLevel: 0, includeChecksums: true, outputPath: zipPath,
    }, () => undefined, () => false);
    const exportMs = Date.now() - started;
    await rm(dir, { recursive: true, force: true });
    const reader = await ZipFileReader.open(zipPath);
    const layout = {
      zipBytes: (await stat(zipPath)).size,
      entries: reader.entries.length,
      zip64Eocd: false,
      maxOffset: Math.max(...reader.entries.map(entry => entry.localHeaderOffset)),
    };
    await reader.close();
    const handle = await open(zipPath, 'r');
    const trailer = Buffer.alloc(98);
    await handle.read(trailer, 0, 98, layout.zipBytes - 98);
    await handle.close();
    layout.zip64Eocd = trailer.readUInt32LE(0) === 0x06064b50;
    const importStarted = Date.now();
    const count = await importBackupFromZip(host.ctx, zipPath, target, importOptions);
    const importMs = Date.now() - importStarted;
    for (const [index, size] of sizes.entries()) {
      expect((await stat(join(target, `persistent/large-${index}.bin`))).size).toBe(size);
    }
    return { ...layout, fileCount: exported.fileCount, imported: count, exportMs, importMs, peakRssDelta: peak - baseline };
  } finally {
    clearInterval(sampler);
    await rm(zipPath, { force: true });
    await rm(target, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!SLOW)('large archives (slow, DS_ZIP_SLOW_TESTS=1)', () => {
  it('> 2 GiB backup exports and imports without ERR_FS_FILE_TOO_LARGE', async () => {
    const host = await setup();
    const result = await roundTripLarge(host, 'over-2gib', [2_300_000_000]);
    console.info('[zip-slow] >2GiB', JSON.stringify(result));
    expect(result.zipBytes).toBeGreaterThan(2 ** 31);
    expect(result.peakRssDelta).toBeLessThan(512 * 1024 * 1024);
  }, 1_800_000);

  it('> 4 GiB backup uses the Tauri ZIP64 layout (central offsets + ZIP64 EOCD) and round-trips', async () => {
    const host = await setup();
    const result = await roundTripLarge(host, 'over-4gib', [2_300_000_000, 2_300_000_000]);
    console.info('[zip-slow] >4GiB', JSON.stringify(result));
    expect(result.zipBytes).toBeGreaterThan(2 ** 32);
    expect(result.maxOffset).toBeGreaterThan(2 ** 32);
    expect(result.zip64Eocd).toBe(true);
    expect(result.peakRssDelta).toBeLessThan(512 * 1024 * 1024);
  }, 1_800_000);

  it('> 65535 entries round-trip through export and import', async () => {
    const host = await setup();
    const root = hostBackupRoot(host);
    const files: Record<string, string> = { ...FILES };
    for (let i = 0; i < 70_000; i += 1) files[`persistent/many/${String(i).padStart(6, '0')}.txt`] = `entry ${i}\n`;
    const dir = join(root, 'many-entries');
    await mkdir(join(dir, 'persistent', 'many'), { recursive: true });
    const pending = Object.entries(files);
    await Promise.all(Array.from({ length: 16 }, async () => {
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) await writeFile(join(dir, next[0]), next[1]);
    }));
    writeBackup(root, partialManifest('many-entries', { files }));
    const zipPath = join(host.app.dataDir, 'many.zip');
    const target = join(host.app.dataDir, 'many-imported');
    const started = Date.now();
    const exported = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true, outputPath: zipPath }, () => undefined, () => false);
    const exportMs = Date.now() - started;
    const reader = await ZipFileReader.open(zipPath);
    const entries = reader.entries.length;
    await reader.close();
    const importStarted = Date.now();
    const imported = await importBackupFromZip(host.ctx, zipPath, target, importOptions);
    const importMs = Date.now() - importStarted;
    console.info('[zip-slow] >65535', JSON.stringify({ entries, fileCount: exported.fileCount, imported, exportMs, importMs }));
    expect(entries).toBeGreaterThan(65_535);
    expect(imported).toBe(exported.fileCount);
    expect(await readFile(join(target, 'persistent/many/069999.txt'), 'utf8')).toBe('entry 69999\n');
  }, 1_800_000);
});

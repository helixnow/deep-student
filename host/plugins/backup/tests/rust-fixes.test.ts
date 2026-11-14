/**
 * W08 登记的 Rust 偏离（`host/e2e/differential/rust-fixes/RF-W08-*.json`）在备份插件里的专门测试。
 * G3 不比对这些位置，这里是唯一的守护。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import type { ZipEntry } from '../../../platform/zip/index.ts';
import { ZipFileWriter } from '../../../platform/zip/index.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { sanitizePathForUser } from '../src/paths.ts';
import { exportBackupToZip, importBackupFromZip, validateSecretsArchive, type ArchiveEntryInfo } from '../src/zip.ts';
import { createBackupHost, createDatabaseFile, hostBackupRoot, partialManifest, sha256, waitForJob, writeBackup } from './helpers.ts';

const opened = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: ((path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      opened.paths.push(String(path));
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.open,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      opened.paths.push(String(path));
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFile,
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const track = <F extends (...args: never[]) => unknown>(fn: F): F => ((path: unknown, ...rest: unknown[]) => {
    opened.paths.push(String(path));
    return (fn as unknown as (...args: unknown[]) => unknown)(path, ...rest);
  }) as unknown as F;
  return {
    ...actual,
    createReadStream: track(actual.createReadStream),
    openSync: track(actual.openSync),
    readFileSync: track(actual.readFileSync),
  };
});

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
});

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

it('RF-W08-zip-entry-overflow-aborts-early: an entry inflating past its declared size stops at the first overflowing chunk', async () => {
  const host = await setup();
  const zipPath = join(host.app.dataDir, 'overflow.zip');
  const writer = await ZipFileWriter.create(zipPath);
  await writer.addBuffer('manifest.json', Buffer.from('{}'));
  await writer.addBuffer('persistent/zeros.bin', Buffer.alloc(64 * 1024 * 1024));
  await writer.finish();

  // 只改中央目录的声明大小：1 MiB / ~64 KiB 压缩，压缩比检查（声明值）通过。
  const declared = 1024 * 1024;
  const bytes = Buffer.from(await readFile(zipPath));
  const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(bytes.subarray(central + 46, central + 46 + bytes.readUInt16LE(central + 28)).toString()).toBe('persistent/zeros.bin');
  bytes.writeUInt32LE(declared, central + 24);
  await writeFile(zipPath, bytes);

  const target = join(host.app.dataDir, 'overflow-target');
  const message = await rejection(importBackupFromZip(host.ctx, zipPath, target, importOptions));
  const match = /^ZIP 条目实际大小与中央目录不一致: .*zeros\.bin expected=(\d+), actual=(\d+)$/.exec(message);
  expect(match, message).not.toBeNull();
  expect(Number(match![1])).toBe(declared);
  // Rust 会把 64 MiB 全部写进临时文件后才比较；这里在第一个越界块就停（zlib 输出块 256 KiB）。
  const actual = Number(match![2]);
  expect(actual).toBeGreaterThan(declared);
  expect(actual).toBeLessThanOrEqual(declared + 256 * 1024);
  const leftovers = existsSync(join(target, 'persistent')) ? readdirSync(join(target, 'persistent')) : [];
  expect(leftovers).toEqual([]);
});

it('RF-W08-sealed-archive-implicit-parent-dirs: implicit parent directory entries from early Electron sealed archives are skipped', () => {
  const info = (name: string, isDirectory: boolean, size = 0): ArchiveEntryInfo => ({
    name, isDirectory, size, compressedSize: size, entry: {} as ZipEntry,
  });
  // JSZip（createFolders）生成的内层归档：crypto/、crypto/.secure/ 在文件之前出现。Rust 对任何目录条目都拒绝。
  const files = validateSecretsArchive([
    info('manifest.json', false, 2),
    info('crypto', true),
    info('crypto/.secure', true),
    info('crypto/.secure/.key_seed', false, 10),
  ]);
  expect(files.map(entry => entry.name)).toEqual(['manifest.json', 'crypto/.secure/.key_seed']);

  expect(() => validateSecretsArchive([
    info('manifest.json', false, 2), info('crypto/empty', true), info('crypto/.master_key', false, 6),
  ])).toThrow('密封载荷不允许包含目录条目: crypto/empty');
  expect(() => validateSecretsArchive([
    info('manifest.json', false, 2), info('persistent', true), info('crypto/.master_key', false, 6),
  ])).toThrow('密封载荷不允许包含目录条目: persistent');
});

it('RF-W08-zip-export-single-read-checksums: each exported file is opened once and checksums match the archived bytes', async () => {
  const host = await setup();
  const files = { ...FILES, 'persistent/big.bin': randomBytes(1536 * 1024 + 17).toString('hex') };
  const dir = writeBackup(hostBackupRoot(host), partialManifest('single-read', { files }), files);
  const source = join(dir, 'persistent', 'big.bin');
  opened.paths.length = 0;
  const result = await exportBackupToZip(host.ctx, dir, { compressionLevel: 6, includeChecksums: true }, () => undefined, () => false);
  // Rust 先 calculate_file_sha256 读一遍、再打开文件写 ZIP（两遍）。
  expect(opened.paths.filter(path => path === source)).toHaveLength(1);

  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  const archived = Buffer.from(await zip.file('persistent/big.bin')!.async('uint8array'));
  expect(archived.toString()).toBe(files['persistent/big.bin']);
  const checksums = await zip.file('checksums.sha256')!.async('string');
  expect(checksums).toContain(`${createHash('sha256').update(archived).digest('hex')}  persistent/big.bin`);
  expect(checksums).toContain(`${sha256(FILES['persistent/webview_settings.json'])}  persistent/webview_settings.json`);
});

it('RF-W08-zip-export-creates-missing-output-parent: exporting into a folder that does not exist yet creates it', async () => {
  const host = await setup();
  const dir = writeBackup(hostBackupRoot(host), partialManifest('missing-parent', { files: FILES }), FILES);
  const output = join(host.app.dataDir, 'exports', 'new', 'nested', 'out.zip');
  expect(existsSync(join(host.app.dataDir, 'exports'))).toBe(false);
  // Rust ensure_zip_output_outside_source 对父目录 canonicalize，父目录不存在即 IO 错误。
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, outputPath: output,
  }, () => undefined, () => false);
  expect(result.zipPath).toBe(output);
  const zip = await JSZip.loadAsync(readFileSync(output));
  expect(zip.file('manifest.json')).not.toBeNull();

  // 缺失的父目录不影响“不能写进源目录”的检查。
  await expect(exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, outputPath: join(dir, 'new-sub', 'inside.zip'),
  }, () => undefined, () => false)).rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  expect(existsSync(join(dir, 'new-sub'))).toBe(false);
});

it('RF-W08-zip-import-cleanup-before-failed: the half-imported directory is gone when the job reports failed', async ({ signal }) => {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({
    storageFactory: (dataDir) => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      return storage;
    },
  });
  storages.push(storage);
  const host = created.host;
  hosts.push(host);
  for (const name of ['databases/vfs.db', 'mistakes.db', 'llm_usage.db', 'chat_v2.db']) {
    createDatabaseFile(join(storage.locations.activeDir, name));
  }

  // 清单不合法：条目先被解压进目标目录，随后解析清单失败。
  const zipPath = join(host.app.dataDir, 'invalid-manifest.zip');
  const archive = new JSZip();
  archive.file('manifest.json', '{}');
  for (let i = 0; i < 200; i += 1) archive.file(`persistent/f${i}.json`, `{"i":${i}}`);
  await writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer' }));
  const backupId = 'cleanup-order-import';
  const target = join(hostBackupRoot(host), backupId);

  const existedWhenFailed: boolean[] = [];
  const events = host.ctx.backendEvents;
  const emit = events.emit.bind(events);
  vi.spyOn(events, 'emit').mockImplementation((name: string, payload?: unknown) => {
    if (name === 'backup-job-progress' && (payload as { status?: string } | undefined)?.status === 'failed') {
      existedWhenFailed.push(existsSync(target));
    }
    return emit(name, payload);
  });

  const started = await host.invoke<{ job_id: string }>('data_governance_import_zip', { zipPath, backupId });
  const job = await waitForJob(host, started.job_id, signal);
  expect(job.status).toBe('failed');
  // Rust commands_zip.rs:1584 先 fail（发出 failed），1612 才 remove_dir_all。
  expect(existedWhenFailed).toEqual([false]);
  expect(existsSync(target)).toBe(false);
});

it('RF-W08-sanitize-path-component-match: home matching is per component and Windows paths never leak the user name', () => {
  // Rust commands_backup.rs:621-636 used `starts_with` on strings: /Users/anna/... matched home /Users/ann and
  // became "~/a/secret/a.zip"; Windows paths have no '/', so the whole C:\\Users\\<name>\\... path was returned.
  expect(sanitizePathForUser('/Users/anna/secret/a.zip', '/Users/ann')).toBe('.../secret/a.zip');
  expect(sanitizePathForUser('/Users/ann/Documents/a.zip', '/Users/ann')).toBe('~/Documents/a.zip');
  expect(sanitizePathForUser('/Users/ann', '/Users/ann')).toBe('~/');
  expect(sanitizePathForUser('/Users/ann/../bob/x/a.zip', '/Users/ann')).toBe('.../x/a.zip');
  expect(sanitizePathForUser('/var/data/backups/a.zip', '/Users/ann')).toBe('.../backups/a.zip');
  expect(sanitizePathForUser('/tmp/a.zip', null)).toBe('/tmp/a.zip');

  expect(sanitizePathForUser('C:\\Users\\ann\\Documents\\a.zip', 'C:\\Users\\ann')).toBe('~/Documents/a.zip');
  expect(sanitizePathForUser('c:/users/ANN/Documents/a.zip', 'C:\\Users\\ann')).toBe('~/Documents/a.zip');
  expect(sanitizePathForUser('C:\\Users\\anna\\secret\\a.zip', 'C:\\Users\\ann')).toBe('.../secret/a.zip');
  expect(sanitizePathForUser('D:\\Backups\\ann\\a.zip', null)).toBe('.../ann/a.zip');
  expect(sanitizePathForUser('\\\\server\\share\\ann\\a.zip', 'C:\\Users\\ann')).toBe('.../ann/a.zip');
});

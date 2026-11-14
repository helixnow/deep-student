/**
 * 存储层大 ZIP：`export_incident_zip`（data_space.rs:2401）与 `check_zip_security`（backup_common.rs:542）
 * 经 `host/platform/zip` 流式读写，不把整个归档或源文件读入内存。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ZipFileReader, ZipFileWriter } from '../../zip/index.ts';
import { checkZipSecurity } from '../backup-common.ts';
import { exportIncidentZip } from '../recovery-export.ts';

const RUST_DEFLATED = fileURLToPath(new URL('../../zip/tests/__fixtures__/rust-deflated.zip', import.meta.url));
const SLOW = process.env.DS_ZIP_SLOW_TESTS === '1';
const GiB = 1024 ** 3;

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-storage-zip-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function readAll(zipPath: string) {
  const reader = await ZipFileReader.open(zipPath);
  try {
    const out: Array<{ name: string; dir: boolean; method: string; data: string | null }> = [];
    for (const entry of reader.entries) {
      out.push({
        name: entry.name,
        dir: entry.isDirectory,
        method: entry.compression,
        data: entry.isDirectory ? null : (await reader.readEntry(entry)).toString('utf8'),
      });
    }
    return out;
  } finally { await reader.close(); }
}

it('checkZipSecurity reads only the central directory and matches Rust metrics, directories included', async () => {
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const check = await checkZipSecurity(RUST_DEFLATED);
  expect(readFileSync).not.toHaveBeenCalledWith(RUST_DEFLATED, expect.anything());
  expect(readFileSync).not.toHaveBeenCalledWith(RUST_DEFLATED);

  const reader = await ZipFileReader.open(RUST_DEFLATED);
  const entries = reader.entries;
  await reader.close();
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const largest = entries.reduce((best, entry) => (entry.size > best.size ? entry : best), entries[0]!);
  const compressed = fs.statSync(RUST_DEFLATED).size;
  expect(check.file_count).toBe(entries.length);
  expect(check.total_uncompressed_size).toBe(total);
  expect(check.total_compressed_size).toBe(compressed);
  expect(check.compression_ratio).toBe(total / compressed);
  expect(check.largest_file_size).toBe(largest.size);
  expect(check.largest_file_name).toBe(largest.name);
});

it('checkZipSecurity keeps the Rust error prefixes', async () => {
  const dir = tmp();
  await expect(checkZipSecurity(path.join(dir, 'missing.zip'))).rejects.toMatchObject({
    error_type: 'FileSystem', message: expect.stringMatching(/^打开 ZIP 文件失败: /),
  });
  const garbage = path.join(dir, 'garbage.zip');
  fs.writeFileSync(garbage, 'definitely not a zip archive');
  await expect(checkZipSecurity(garbage)).rejects.toMatchObject({
    error_type: 'FileSystem', message: expect.stringMatching(/^解析 ZIP 文件失败: /),
  });
});

it('exportIncidentZip streams files into a Rust-layout archive (pre-order dirs, deflated files, symlinks skipped)', async () => {
  const base = tmp();
  const source = path.join(base, 'incident');
  fs.mkdirSync(path.join(source, 'logs', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), '{"id":"incident-1"}');
  fs.writeFileSync(path.join(source, 'logs', 'host.log'), 'line\n'.repeat(1000));
  fs.writeFileSync(path.join(source, 'logs', 'nested', 'empty.txt'), '');
  fs.symlinkSync(path.join(source, 'manifest.json'), path.join(source, 'link.json'));
  const readFileSync = vi.spyOn(fs, 'readFileSync');

  const destination = path.join(base, 'out', 'incident.zip');
  await exportIncidentZip(source, destination);
  expect(readFileSync.mock.calls.some(([file]) => typeof file === 'string' && file.startsWith(source))).toBe(false);
  expect(fs.existsSync(`${destination.slice(0, -4)}.zip.partial`)).toBe(false);

  const entries = await readAll(destination);
  expect(entries.map((entry) => entry.name).sort()).toEqual([
    'logs/', 'logs/host.log', 'logs/nested/', 'logs/nested/empty.txt', 'manifest.json',
  ]);
  for (const entry of entries) {
    if (entry.dir) {
      const children = entries.filter((other) => other.name !== entry.name && other.name.startsWith(entry.name));
      for (const child of children) expect(entries.indexOf(child)).toBeGreaterThan(entries.indexOf(entry));
    }
  }
  expect(entries.find((entry) => entry.name === 'logs/host.log')).toMatchObject({ method: 'deflated', data: 'line\n'.repeat(1000) });
  expect(entries.find((entry) => entry.name === 'manifest.json')?.data).toBe('{"id":"incident-1"}');
});

it('exportIncidentZip replaces an existing destination and cleans the partial file on failure', async () => {
  const base = tmp();
  const source = path.join(base, 'incident');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.txt'), 'new');
  const destination = path.join(base, 'incident.zip');
  fs.writeFileSync(destination, 'old export');
  await exportIncidentZip(source, destination);
  expect((await readAll(destination)).map((entry) => entry.data)).toEqual(['new']);
  expect(fs.existsSync(path.join(base, 'incident.zip.previous'))).toBe(false);

  await expect(exportIncidentZip(path.join(base, 'missing'), destination)).rejects.toThrow();
  expect(fs.existsSync(path.join(base, 'incident.zip.partial'))).toBe(false);
  expect((await readAll(destination)).map((entry) => entry.data)).toEqual(['new']);
});

it.skipIf(!SLOW)('storage ZIP paths handle archives and sources beyond the 2GiB Buffer limit', async () => {
  const base = tmp();
  const source = path.join(base, 'incident');
  fs.mkdirSync(source);
  const big = path.join(source, 'big.bin');
  const handle = fs.openSync(big, 'w');
  fs.ftruncateSync(handle, Math.floor(2.5 * GiB));
  fs.closeSync(handle);
  const destination = path.join(base, 'incident.zip');
  await exportIncidentZip(source, destination);

  const stored = path.join(base, 'stored.zip');
  const writer = await ZipFileWriter.create(stored);
  await writer.addFile('big.bin', big, { compression: 'stored' });
  await writer.finish({ sync: false });
  const check = await checkZipSecurity(stored);
  expect(check).toMatchObject({ file_count: 1, total_uncompressed_size: Math.floor(2.5 * GiB), largest_file_name: 'big.bin' });
  expect((await checkZipSecurity(destination)).total_uncompressed_size).toBe(Math.floor(2.5 * GiB));
}, 600_000);

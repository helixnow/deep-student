import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import {
  STAGED_UPLOAD_MAX_BYTES,
  STAGED_UPLOAD_MEDIA_MAX_BYTES,
  abort,
  append,
  beginIn,
  maxBytesForName,
  parseAppendRequest,
  stageFromReader,
  sweep,
  takeStagedUpload,
} from '../staged-upload.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-staged-'));
  dirs.push(dir);
  return dir;
}
function part(dir: string, id: string): string {
  return path.join(dir, `${id}.part`);
}
function bytes(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('chunks_assemble_in_order_and_take_cleans_up', () => {
  const dir = tmp();
  const id = beginIn(dir, 'a.bin', 10, STAGED_UPLOAD_MAX_BYTES);
  expect(append(id, 0, Buffer.from('hello'))).toBe(5);
  expect(append(id, 5, Buffer.from('world'))).toBe(10);
  const staged = takeStagedUpload(id);
  expect(staged.name()).toBe('a.bin');
  expect(staged.size()).toBe(10);
  const file = staged.path();
  expect(bytes(staged.readBounded(100))).toBe('helloworld');
  staged.dispose();
  expect(fs.existsSync(file)).toBe(false);
  expect(() => takeStagedUpload(id)).toThrow(/Unknown or expired upload/);
});

it('rejects_out_of_order_and_oversized_chunks', () => {
  const dir = tmp();
  const id = beginIn(dir, 'a.bin', 4, STAGED_UPLOAD_MAX_BYTES);
  expect(() => append(id, 2, Buffer.from('ab'))).toThrow('Unexpected chunk offset 2 (expected 0)');
  append(id, 0, Buffer.from('ab'));
  expect(() => append(id, 0, Buffer.from('ab'))).toThrow('Unexpected chunk offset 0 (expected 2)');
  const file = part(dir, id);
  expect(() => append(id, 2, Buffer.from('abc'))).toThrow('Chunk exceeds declared size: 5 > 4');
  expect(fs.existsSync(file)).toBe(false);
  expect(() => append(id, 2, Buffer.from('ab'))).toThrow(/Unknown or expired upload/);
});

it('begin_enforces_size_limit', () => {
  const dir = tmp();
  expect(() => beginIn(dir, 'big', 11, 10)).toThrow(/File too large/);
  expect(() => beginIn(dir, 'big', STAGED_UPLOAD_MEDIA_MAX_BYTES + 1, Number.MAX_SAFE_INTEGER)).toThrow(/File too large/);
  expect(maxBytesForName('doc.pdf')).toBe(STAGED_UPLOAD_MAX_BYTES);
  expect(maxBytesForName('lecture.MP4')).toBe(STAGED_UPLOAD_MEDIA_MAX_BYTES);
  expect(() => beginIn(dir, 'big.pdf', STAGED_UPLOAD_MAX_BYTES + 1, maxBytesForName('big.pdf'))).toThrow(/File too large/);
  expect(beginIn(dir, 'ok', 10, 10)).toBeTruthy();
});

it('incomplete_upload_cannot_be_taken_and_is_removed', () => {
  const dir = tmp();
  const id = beginIn(dir, 'a', 8, STAGED_UPLOAD_MAX_BYTES);
  append(id, 0, Buffer.from('1234'));
  const file = part(dir, id);
  expect(() => takeStagedUpload(id)).toThrow('Upload incomplete: received 4 of 8 bytes');
  expect(fs.existsSync(file)).toBe(false);
});

it('abort_removes_file_and_is_idempotent', () => {
  const dir = tmp();
  const id = beginIn(dir, 'a', 8, STAGED_UPLOAD_MAX_BYTES);
  append(id, 0, Buffer.from('1234'));
  const file = part(dir, id);
  expect(fs.existsSync(file)).toBe(true);
  abort(id);
  abort(id);
  expect(fs.existsSync(file)).toBe(false);
  expect(() => append(id, 4, Buffer.from('5678'))).toThrow(/Unknown or expired upload/);
});

it('read_bounded_rejects_over_limit', () => {
  const dir = tmp();
  const id = beginIn(dir, 'a', 4, STAGED_UPLOAD_MAX_BYTES);
  append(id, 0, Buffer.from('abcd'));
  const staged = takeStagedUpload(id);
  expect(() => staged.readBounded(3)).toThrow(/File too large/);
  staged.dispose();
});

it('stage_from_reader_enforces_limit_and_cleans_up', async () => {
  const dir = tmp();
  const okReader = (async function* () { yield Buffer.from('0123456789'); })();
  const { uploadId, size } = await stageFromReader(dir, 'r.bin', okReader, 10);
  expect(size).toBe(10);
  const staged = takeStagedUpload(uploadId);
  expect(bytes(staged.readBounded(10))).toBe('0123456789');
  staged.dispose();

  const bigReader = (async function* () { yield Buffer.from('0123456789A'); })();
  await expect(stageFromReader(dir, 'r.bin', bigReader, 10)).rejects.toThrow(/File too large/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('sweep_removes_orphans_but_keeps_registered', () => {
  const dir = tmp();
  const id = beginIn(dir, 'a', 4, STAGED_UPLOAD_MAX_BYTES);
  const orphan = path.join(dir, 'orphan.part');
  fs.writeFileSync(orphan, 'x');
  sweep(dir, true);
  expect(fs.existsSync(orphan)).toBe(false);
  expect(fs.existsSync(part(dir, id))).toBe(true);
  abort(id);
});

it('parses_raw_json_and_array_payloads', () => {
  const raw = new Uint8Array([1, 2, 3]);
  const fromRaw = parseAppendRequest(raw, 'u1', '7');
  expect([fromRaw.uploadId, fromRaw.offset, Array.from(fromRaw.bytes)]).toEqual(['u1', 7, [1, 2, 3]]);
  expect(() => parseAppendRequest(raw, undefined, '0')).toThrow(/Missing x-upload-id header/);

  const json = { uploadId: 'u2', offset: 3, data: Buffer.from([9, 8, 7]).toString('base64') };
  const fromJson = parseAppendRequest(json, undefined, undefined);
  expect([fromJson.uploadId, fromJson.offset, Array.from(fromJson.bytes)]).toEqual(['u2', 3, [9, 8, 7]]);

  const fromArray = parseAppendRequest([4, 5, 255], 'u3', '0');
  expect(Array.from(fromArray.bytes)).toEqual([4, 5, 255]);
  expect(() => parseAppendRequest([256], 'u3', '0')).toThrow('Invalid byte in chunk');
});

it('staged_upload_append reads the raw invoke body and headers through CallContext', async () => {
  const base = tmp();
  const appCacheDir = path.join(base, 'cache');
  const host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: {
        os: { home: base, data: base, dataLocal: base, config: base, cache: appCacheDir, temp: base, download: null },
        appCacheDir,
        appLocalDataDir: path.join(base, 'local'),
      },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  try {
    const uploadId = await host.invoke<string>('staged_upload_begin', { name: 'chunk.bin', totalSize: 6 });
    const source = { window: 'main', webview: 'main' };
    const first = await host.runtime.dispatchInvoke({
      id: 'append-1', cmd: 'staged_upload_append', args: new Uint8Array([1, 2, 3]), source,
      headers: { 'x-upload-id': uploadId, 'x-upload-offset': '0' },
    });
    expect(first).toEqual({ kind: 'ok', value: 3 });
    const second = await host.runtime.dispatchInvoke({
      id: 'append-2', cmd: 'staged_upload_append', args: new Uint8Array([4, 5, 6]), source,
      headers: { 'x-upload-id': uploadId, 'x-upload-offset': '3' },
    });
    expect(second).toEqual({ kind: 'ok', value: 6 });

    const part = path.join(appCacheDir, 'staged_uploads', `${uploadId}.part`);
    expect(Array.from(fs.readFileSync(part))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await host.invoke('staged_upload_abort', { uploadId })).toBeNull();
    expect(fs.existsSync(part)).toBe(false);
  } finally {
    await host.dispose();
  }
});

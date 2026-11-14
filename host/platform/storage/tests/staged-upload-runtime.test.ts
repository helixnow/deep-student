import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import { takeStagedUpload } from '../staged-upload.ts';

// F3-V2-03: exercise registered commands and the consumer's real StagedFile.
let base: string;
let host: Awaited<ReturnType<typeof createTestHost>>;
const uploads: string[] = [];
const ttl = 30 * 60 * 1000;
const stagedPath = (id: string) => path.join(base, 'cache/staged_uploads', `${id}.part`);
async function begin(size = 4): Promise<string> {
  const id = await host.invoke<string>('staged_upload_begin', { name: 'a.bin', totalSize: size });
  uploads.push(id);
  return id;
}
const append = (uploadId: string, offset: number, data: string) =>
  host.invoke('staged_upload_append', { uploadId, offset, data: Buffer.from(data).toString('base64') });

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-staged-runtime-'));
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base },
        appCacheDir: path.join(base, 'cache'), appLocalDataDir: path.join(base, 'local') },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
  });
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const uploadId of uploads.splice(0)) await host.invoke('staged_upload_abort', { uploadId });
});
afterAll(async () => {
  await host?.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

it('sweep_removes_orphans_but_keeps_registered: wall-clock jumps cannot expire live entries', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const id = await begin();
  clock.mockReturnValue(101);
  wall.mockReturnValue(1_800_000_000_000 + ttl + 1);
  await begin(); // production prepare_dir invokes sweep
  expect(fs.existsSync(stagedPath(id))).toBe(true);
  expect(await append(id, 0, 'abcd')).toBe(4);
});

it('sweep_removes_orphans_but_keeps_registered: Instant TTL is strict and append refreshes it', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const id = await begin();
  clock.mockReturnValue(100 + ttl);
  wall.mockReturnValue(1); // a backward wall clock must not postpone expiration
  await begin();
  expect(fs.existsSync(stagedPath(id))).toBe(true); // Rust uses >, not >=
  expect(await append(id, 0, 'ab')).toBe(2);
  clock.mockReturnValue(100 + 2 * ttl);
  await begin();
  expect(fs.existsSync(stagedPath(id))).toBe(true);
  clock.mockReturnValue(101 + 2 * ttl);
  await begin();
  expect(fs.existsSync(stagedPath(id))).toBe(false);
  await expect(append(id, 2, 'cd')).rejects.toBe(`Unknown or expired upload: ${id}`);
});

it('sweep_removes_orphans_but_keeps_registered: orphan mtime still uses SystemTime', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100);
  const now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const id = await begin(); // first sweep precedes creating the orphan fixtures
  const directory = path.dirname(stagedPath(id));
  const old = path.join(directory, 'old.part'), future = path.join(directory, 'future.part');
  fs.writeFileSync(old, 'old'); fs.writeFileSync(future, 'future');
  fs.utimesSync(old, (now - ttl - 1000) / 1000, (now - ttl - 1000) / 1000);
  fs.utimesSync(future, (now + ttl) / 1000, (now + ttl) / 1000);
  await begin();
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.readFileSync(future, 'utf8')).toBe('future');
  fs.unlinkSync(future);
});

function shortWrites(): void {
  const write = fs.writeSync;
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, data: string | Uint8Array, ...args: unknown[]) => {
    if (typeof data === 'string') throw new Error('unexpected text write in staged upload');
    const offset = typeof args[0] === 'number' ? args[0] : 0;
    const length = typeof args[1] === 'number' ? args[1] : data.byteLength - offset;
    return write(fd, data, offset, Math.min(2, length));
  });
}

it('chunks_assemble_in_order_and_take_cleans_up: write_all handles a short filesystem write', async () => {
  const id = await begin(6);
  shortWrites();
  expect(await append(id, 0, 'abcdef')).toBe(6);
  expect(fs.readFileSync(stagedPath(id), 'utf8')).toBe('abcdef');
});

it('stage_from_reader_enforces_limit_and_cleans_up: path copying handles short writes', async () => {
  const file = path.join(base, 'source.bin');
  fs.writeFileSync(file, 'abcdef');
  shortWrites();
  const result = await host.invoke<{ uploadId: string; size: number }>('staged_upload_from_path', { path: file });
  uploads.push(result.uploadId);
  expect(result.size).toBe(6);
  expect(fs.readFileSync(stagedPath(result.uploadId), 'utf8')).toBe('abcdef');
});

it('rejects_out_of_order_and_oversized_chunks: write zero aborts instead of recording unwritten bytes', async () => {
  const id = await begin();
  vi.spyOn(fs, 'writeSync').mockReturnValue(0);
  await expect(append(id, 0, 'abcd')).rejects.toBe('Failed to write staged upload chunk: failed to write whole buffer');
  expect(fs.existsSync(stagedPath(id))).toBe(false);
  await expect(append(id, 0, 'abcd')).rejects.toBe(`Unknown or expired upload: ${id}`);
});

it('read_bounded_rejects_over_limit: disk growth is read to max_bytes + 1, not declared size + 1', async () => {
  const id = await begin();
  await append(id, 0, 'abcd');
  const file = takeStagedUpload(id);
  try {
    fs.appendFileSync(file.path(), 'efghi');
    expect(() => file.readBounded(10)).toThrow('Staged upload changed on disk: expected 4 bytes, read 9');
    // Rust checks limit before the changed-size branch (staged_upload.rs:124-134).
    expect(() => file.readBounded(6)).toThrow('File too large: max 0.0MB, got 0.0MB');
  } finally { file.dispose(); }
  expect(fs.existsSync(stagedPath(id))).toBe(false);
});

it.each([
  ['+0', { kind: 'ok', value: 1 }],
  ['9007199254740993', { kind: 'err', error: 'Unexpected chunk offset 9007199254740993 (expected 0)' }],
  ['18446744073709551615', { kind: 'err', error: 'Unexpected chunk offset 18446744073709551615 (expected 0)' }],
  ['18446744073709551616', { kind: 'err', error: 'Invalid x-upload-offset header' }],
  ['-0', { kind: 'err', error: 'Invalid x-upload-offset header' }],
] as const)('parses_raw_json_and_array_payloads: u64 header %s preserves Rust parsing and offset errors', async (offset, expected) => {
  const uploadId = await begin();
  const outcome = await host.runtime.dispatchInvoke({
    id: `offset-${uploadId}`, cmd: 'staged_upload_append', args: new Uint8Array([1]),
    source: { window: 'main', webview: 'main' },
    headers: { 'x-upload-id': uploadId, 'x-upload-offset': offset },
  });
  expect(outcome).toEqual(expected);
  expect(fs.statSync(stagedPath(uploadId)).size).toBe(expected.kind === 'ok' ? 1 : 0);
});

it('parses_raw_json_and_array_payloads: JSON u64 offset is not restricted to safe integers', async () => {
  const uploadId = await begin();
  await expect(host.invoke('staged_upload_append', {
    uploadId, offset: 9007199254740992, data: 'YQ==',
  })).rejects.toBe('Unexpected chunk offset 9007199254740992 (expected 0)');
  expect(fs.statSync(stagedPath(uploadId)).size).toBe(0);
});

it.each([
  ['AB==', 'Invalid last symbol 66, offset 1.'],
  ['YQ', 'Invalid padding'],
  ['A', 'Invalid input length: 1'],
  ['AA==\n', 'Invalid symbol 10, offset 4.'],
  ['💡', 'Invalid symbol 240, offset 0.'],
])('parses_raw_json_and_array_payloads: preserves STANDARD DecodeError for %j', async (data, error) => {
  const uploadId = await begin();
  await expect(host.invoke('staged_upload_append', { uploadId, offset: 0, data }))
    .rejects.toBe(`Invalid chunk base64: ${error}`);
  expect(fs.statSync(stagedPath(uploadId)).size).toBe(0);
});

it('parses_raw_json_and_array_payloads: encoded-size guard measures UTF-8 bytes before decoding', async () => {
  const uploadId = await begin();
  // Rust str::len=22369630 > div_ceil(16MiB,3)*4+4=22369628; JS length is half.
  await expect(host.invoke('staged_upload_append', { uploadId, offset: 0, data: 'é'.repeat(11184815) }))
    .rejects.toBe('Chunk too large: 22369630 base64 chars');
  expect(fs.statSync(stagedPath(uploadId)).size).toBe(0);
});

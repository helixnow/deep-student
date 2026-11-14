import './local-fs-fixture.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebDavStorage } from '../src/webdav.ts';
import { filePropfindXml, spawnFakeDav, type FakeDav } from './fake_dav.ts';

const ROOT = 'sync-root';
const FILE_KEY = 'backups/r09-resume.zip';

const tempDirs: string[] = [];
const servers: FakeDav[] = [];

afterAll(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDest(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'webdav-resume-'));
  tempDirs.push(dir);
  return join(dir, 'resume.part');
}

type RangeMode = 'Honor' | 'Ignore' | 'Misaligned' | 'TruncateBody';

function payload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 239;
  return bytes;
}

interface RangeServer {
  storage: WebDavStorage;
  ranges: Array<string | null>;
}

async function spawnRangeServer(body: Uint8Array, mode: RangeMode): Promise<RangeServer> {
  const ranges: Array<string | null> = [];
  const server = await spawnFakeDav((method, path, _index, headers) => {
    if (method === 'PROPFIND') return { status: 207, body: filePropfindXml(path, body.byteLength) };
    if (method !== 'GET') return { status: 404 };

    const rangeHeader = headers.range ?? null;
    ranges.push(rangeHeader);
    const requestedStart = rangeHeader?.startsWith('bytes=')
      ? Number(rangeHeader.slice('bytes='.length).split('-')[0])
      : null;
    const total = body.byteLength;

    if (mode === 'Ignore' || requestedStart === null) {
      return { status: 200, body };
    }
    const start = requestedStart;
    if (mode === 'Honor') {
      return {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${total - 1}/${total}` },
        body: body.subarray(start),
      };
    }
    if (mode === 'Misaligned') {
      const wrongStart = start + 1;
      return {
        status: 206,
        headers: { 'Content-Range': `bytes ${wrongStart}-${total - 1}/${total}` },
        body: body.subarray(wrongStart),
      };
    }
    const full = body.subarray(start);
    const half = Math.floor(full.byteLength / 2);
    const served = full.subarray(0, half);
    return {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${total - 1}/${total}` },
      body: served,
      declaredLength: served.byteLength * 2,
    };
  });
  servers.push(server);
  const storage = new WebDavStorage(
    { endpoint: server.endpoint, username: 'student', password: 'correct-horse' },
    ROOT,
    { rateLimitEnv: '0' },
  );
  return { storage, ranges };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

describe('webdav_download_resume_tests.rs', () => {
  it('webdav_advertises_resumable_download', async () => {
    const { storage } = await spawnRangeServer(payload(16), 'Honor');
    expect(storage.supportsResumableDownload()).toBe(true);
  });

  it('range_206_resumes_exactly_from_offset', async () => {
    const data = payload(20_000);
    const { storage, ranges } = await spawnRangeServer(data, 'Honor');
    const dest = await tempDest();
    await writeFile(dest, data.subarray(0, 7_000));

    const resumedFrom = await storage.getFileResumable(FILE_KEY, dest, 7_000, null);

    expect(resumedFrom).toBe(7_000);
    expect(ranges).toEqual(['bytes=7000-']);
    expect(Buffer.from(await readFile(dest)).equals(Buffer.from(data))).toBe(true);
  });

  it('range_ignored_200_truncates_and_rewrites_from_zero', async () => {
    const data = payload(12_000);
    const { storage } = await spawnRangeServer(data, 'Ignore');
    const dest = await tempDest();
    await writeFile(dest, Buffer.alloc(5_000, 0xee));

    const resumedFrom = await storage.getFileResumable(FILE_KEY, dest, 5_000, null);

    expect(resumedFrom).toBe(0);
    expect(Buffer.from(await readFile(dest)).equals(Buffer.from(data))).toBe(true);
  });

  it('misaligned_content_range_fails_closed_and_keeps_partial', async () => {
    const data = payload(10_000);
    const { storage } = await spawnRangeServer(data, 'Misaligned');
    const dest = await tempDest();
    const partial = data.subarray(0, 3_000);
    await writeFile(dest, partial);

    const error = await failure(storage.getFileResumable(FILE_KEY, dest, 3_000, null));

    expect(error.message).toContain('续传起点与请求不一致');
    expect(Buffer.from(await readFile(dest)).equals(Buffer.from(partial))).toBe(true);
  });

  it('truncated_body_is_an_error_and_partial_stays_prefix_complete', async () => {
    const data = payload(40_000);
    const { storage } = await spawnRangeServer(data, 'TruncateBody');
    const dest = await tempDest();
    await writeFile(dest, data.subarray(0, 10_000));

    const error = await failure(storage.getFileResumable(FILE_KEY, dest, 10_000, null));

    expect(error.message.includes('中断') || error.message.includes('读取响应体失败')).toBe(true);
    const onDisk = await readFile(dest);
    expect(onDisk.byteLength).toBeGreaterThanOrEqual(10_000);
    expect(onDisk.byteLength).toBeLessThan(data.byteLength);
    expect(onDisk.equals(Buffer.from(data).subarray(0, onDisk.byteLength))).toBe(true);
  });

  it('fresh_download_with_zero_offset_sends_no_range_header', async () => {
    const data = payload(6_000);
    const { storage, ranges } = await spawnRangeServer(data, 'Honor');
    const dest = await tempDest();

    const resumedFrom = await storage.getFileResumable(FILE_KEY, dest, 0, null);

    expect(resumedFrom).toBe(0);
    expect(ranges).toEqual([null]);
    expect(Buffer.from(await readFile(dest)).equals(Buffer.from(data))).toBe(true);
  });
});

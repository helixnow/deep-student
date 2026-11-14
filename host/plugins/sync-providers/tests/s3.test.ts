import './local-fs-fixture.ts';
import { Agent } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile as readLocalFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterAll, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, MEMORY_GET_DEFAULT_BUDGET_BYTES, MEMORY_GET_STALL_SECS, MIN_MULTIPART_SIZE } from '../src/traits.ts';
import {
  MAX_MULTIPART_PARTS,
  MAX_PART_SIZE,
  MULTIPART_STALE_SECS,
  S3Storage,
  multipartUploadIsStale,
  normalizeEndpoint,
  planMultipartPartSize,
  plannedPartCount,
  resolveRegion,
  resumeActualStart,
  type S3StorageOptions,
} from '../src/s3.ts';
import type { LogSink } from '../src/logging.ts';
import { parseContentRangeStart } from '../src/webdav.ts';
import { CloudStorageError } from '../src/errors.ts';
import { s3ErrorXml, spawnFakeS3, type FakeS3 } from './fake_s3.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('s3.rs', () => {
  it('put_file_source_guards_remote_size_check', async () => {
    // The Rust source-lock test asserts four production guards. TS keeps the
    // invariants and verifies them through the production object instead of
    // grepping source text (quality.md §5).
    const dir = await tempDir();
    const local = join(dir, 'a.txt');
    await writeFile(local, 'hello');
    const server = await spawnFakeS3(request => {
      if (request.method === 'HEAD') {
        return { status: 200, declaredLength: 99, headers: { 'Last-Modified': 'Tue, 03 Nov 2026 00:00:00 GMT' } };
      }
      if (request.method === 'DELETE') return { status: 204 };
      return { status: 200 };
    });
    try {
      const storage = storageFor(server, 'root');
      expect(storage.supportsResumableDownload()).toBe(true);
      expect(storage.supportsPrefixRead()).toBe(true);
      const error = await failure(storage.putFile('a.txt', local));
      expect(error.message).toContain('云端对象上传后大小不一致');
      expect(server.log.map(entry => entry.method)).toEqual(['PUT', 'HEAD', 'DELETE']);
    } finally { await server.close(); }

    // s3.rs `self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES)`: legacy get() is budgeted.
    const huge = await spawnFakeS3(() => ({ status: 200, declaredLength: MEMORY_GET_DEFAULT_BUDGET_BYTES + 1, body: 'x' }));
    try {
      const error = await failure(storageFor(huge, 'root').get('huge.bin'));
      expect(error.message).toContain('超出调用方内存预算');
      expect(huge.log).toHaveLength(1);
    } finally { await huge.close(); }

    // s3.rs "S3 内存对象下载停滞超过 90 秒": the memory read carries the 90 s stall guard and text.
    expect(MEMORY_GET_STALL_SECS).toBe(90);
    const source = await readLocalFile(new URL('../src/s3.ts', import.meta.url), 'utf8');
    expect(source).toContain("readChunks(body, MEMORY_GET_STALL_SECS * 1000, 'S3 内存对象下载停滞超过 90 秒，连接可能已断开')");
  });

  it('stale_multipart_keeps_recent_and_unknown_initiated', () => {
    const now = 1_800_000_000;
    expect(multipartUploadIsStale(now - 60, now)).toBe(false);
    expect(multipartUploadIsStale(null, now)).toBe(false);
    expect(multipartUploadIsStale(now - MULTIPART_STALE_SECS, now)).toBe(true);
    expect(multipartUploadIsStale(now - MULTIPART_STALE_SECS - 1, now)).toBe(true);
  });

  it('parse_content_range_start_accepts_standard_form', () => {
    expect(parseContentRangeStart('bytes 7000-9999/10000')).toBe(7000);
    expect(parseContentRangeStart(' bytes 0-1/2')).toBe(0);
  });

  it('parse_content_range_start_rejects_unsatisfiable_form', () => {
    expect(parseContentRangeStart('bytes */10000')).toBeNull();
    expect(parseContentRangeStart('bytes')).toBeNull();
  });

  it('resume_actual_start_restarts_when_range_ignored', () => {
    expect(resumeActualStart(0, null)).toBe(0);
    expect(resumeActualStart(7000, null)).toBe(0);
    expect(resumeActualStart(7000, 'bytes 7000-9999/10000')).toBe(7000);
  });

  it('resume_actual_start_fails_closed_on_misaligned_range', () => {
    const misaligned = (() => {
      try { resumeActualStart(7000, 'bytes 7001-9999/10000'); return null; }
      catch (error) { return error as CloudStorageError; }
    })();
    expect(misaligned).toBeInstanceOf(CloudStorageError);
    expect(misaligned!.message).toContain('拒绝错位追加');

    const unparsable = (() => {
      try { resumeActualStart(7000, 'bytes */10000'); return null; }
      catch (error) { return error as CloudStorageError; }
    })();
    expect(unparsable).toBeInstanceOf(CloudStorageError);
    expect(unparsable!.message).toContain('拒绝错位追加');
  });

  it('multipart_threshold_fits_single_put_attempt_timeout', () => {
    expect(MIN_MULTIPART_SIZE).toBeLessThanOrEqual(32 * MIB);
    expect(MIN_MULTIPART_SIZE).toBeGreaterThanOrEqual(16 * MIB);
    expect(MIN_MULTIPART_SIZE).toBeGreaterThanOrEqual(CHUNK_SIZE);
  });

  it('plan_part_size_uses_default_chunk_for_common_sizes', () => {
    expect(planMultipartPartSize(MIN_MULTIPART_SIZE)).toBe(CHUNK_SIZE);
    expect(planMultipartPartSize(10 * GIB)).toBe(CHUNK_SIZE);
    expect(planMultipartPartSize(CHUNK_SIZE * MAX_MULTIPART_PARTS)).toBe(CHUNK_SIZE);
  });

  it('normalize_endpoint_strips_bucket_prefixed_host', () => {
    expect(normalizeEndpoint('https://mybucket-1250000000.cos.ap-beijing.myqcloud.com', 'mybucket-1250000000'))
      .toBe('https://cos.ap-beijing.myqcloud.com');
    expect(normalizeEndpoint('https://mybucket.oss-cn-hangzhou.aliyuncs.com/', 'mybucket'))
      .toBe('https://oss-cn-hangzhou.aliyuncs.com');
    expect(normalizeEndpoint('https://mybucket.s3.bitiful.net', 'mybucket'))
      .toBe('https://s3.bitiful.net');
    expect(normalizeEndpoint('https://mybucket.s3.us-east-1.amazonaws.com', 'mybucket'))
      .toBe('https://s3.us-east-1.amazonaws.com');
  });

  it('plan_part_size_scales_up_to_respect_ten_thousand_part_limit', () => {
    for (const fileSize of [80 * GIB, 500 * GIB, 5 * 1024 * GIB]) {
      const partSize = planMultipartPartSize(fileSize);
      expect(partSize).toBeGreaterThan(CHUNK_SIZE);
      expect(plannedPartCount(fileSize, partSize)).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
      expect(partSize).toBeLessThanOrEqual(MAX_PART_SIZE);
      expect(partSize % MIB).toBe(0);
    }
  });

  it('plan_part_size_rejects_files_beyond_s3_hard_limits', () => {
    const maxObject = MAX_MULTIPART_PARTS * MAX_PART_SIZE;
    expect(() => planMultipartPartSize(maxObject)).not.toThrow();
    expect(() => planMultipartPartSize(maxObject + 1)).toThrow();
  });

  it('planned_part_count_covers_exact_and_ragged_sizes', () => {
    expect(plannedPartCount(2 * CHUNK_SIZE, CHUNK_SIZE)).toBe(2);
    expect(plannedPartCount(2 * CHUNK_SIZE + 1, CHUNK_SIZE)).toBe(3);
    expect(plannedPartCount(1, CHUNK_SIZE)).toBe(1);
    expect(plannedPartCount(0, CHUNK_SIZE)).toBe(1);
  });

  it('resolve_region_treats_blank_as_unset_and_infers_from_endpoint', () => {
    expect(resolveRegion('', 'https://cos.ap-beijing.myqcloud.com')).toBe('ap-beijing');
    expect(resolveRegion('  ', 'https://s3.eu-west-1.amazonaws.com')).toBe('eu-west-1');
    expect(resolveRegion(null, 'https://s3-ap-southeast-1.amazonaws.com')).toBe('ap-southeast-1');
    expect(resolveRegion(null, 'https://oss-cn-hangzhou.aliyuncs.com')).toBe('us-east-1');
    expect(resolveRegion('', 'http://localhost:9000')).toBe('us-east-1');
    expect(resolveRegion(' cn-east-1 ', 'https://s3.bitiful.net')).toBe('cn-east-1');
  });

  it('normalize_endpoint_adds_https_scheme_and_trims', () => {
    expect(normalizeEndpoint('  cos.ap-beijing.myqcloud.com  ', 'mybucket'))
      .toBe('https://cos.ap-beijing.myqcloud.com');
    expect(normalizeEndpoint(' https://s3.example.com/ ', 'b')).toBe('https://s3.example.com');
  });

  it('normalize_endpoint_keeps_path_style_paths_untouched', () => {
    expect(normalizeEndpoint('https://cos.ap-beijing.myqcloud.com/mybucket', 'mybucket'))
      .toBe('https://cos.ap-beijing.myqcloud.com/mybucket');
    expect(normalizeEndpoint('https://gw.example.com/s3/mybucket', 'mybucket'))
      .toBe('https://gw.example.com/s3/mybucket');
  });

  it('normalize_endpoint_keeps_canonical_endpoints_untouched', () => {
    expect(normalizeEndpoint('https://cos.ap-beijing.myqcloud.com', 'mybucket'))
      .toBe('https://cos.ap-beijing.myqcloud.com');
    expect(normalizeEndpoint('https://0123456789abcdef.r2.cloudflarestorage.com', 'mybucket'))
      .toBe('https://0123456789abcdef.r2.cloudflarestorage.com');
    expect(normalizeEndpoint('https://MinIO.Example.com:9000', 'mybucket'))
      .toBe('https://MinIO.Example.com:9000');
  });

  it('normalize_endpoint_conservative_cases', () => {
    expect(normalizeEndpoint('http://127.0.0.1:9000', '127')).toBe('http://127.0.0.1:9000');
    expect(normalizeEndpoint('http://localhost:9000', 'localhost')).toBe('http://localhost:9000');
    expect(normalizeEndpoint('https://s3.bitiful.net', 's3')).toBe('https://s3.bitiful.net');
    expect(normalizeEndpoint('https://mybucket.s3.example.com', 'mybucket')).toBe('https://mybucket.s3.example.com');
    expect(normalizeEndpoint('https://s3.us-east-1.amazonaws.com', 's3')).toBe('https://s3.us-east-1.amazonaws.com');
    expect(normalizeEndpoint('https://s3.example.com', '')).toBe('https://s3.example.com');
  });
});

// ---------------------------------------------------------------- transport

const tempDirs: string[] = [];
afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 's3-test-'));
  tempDirs.push(dir);
  return dir;
}

function recordingLogger(): { log: LogSink; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    log: {
      error: () => {},
      warn: (message) => { warns.push(message); },
      info: (message) => { infos.push(message); },
      debug: () => {},
    },
  };
}

function storageFor(server: FakeS3, root = 'deep-student-sync', options: S3StorageOptions = {}): S3Storage {
  return new S3Storage({
    endpoint: server.endpoint,
    bucket: 'test-bucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    pathStyle: true,
  }, root, options);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

describe('s3.rs SigV4 via the official SDK', () => {
  it('signs requests with the configured region and access key', async () => {
    const server = await spawnFakeS3(() => ({ status: 200, body: 'ok' }));
    try {
      const storage = storageFor(server, 'root');
      await storage.get('a.txt');
      const request = server.log[0]!;
      expect(request.headers.authorization).toContain('AWS4-HMAC-SHA256');
      expect(request.headers.authorization).toContain('Credential=AKIAIOSFODNN7EXAMPLE/');
      expect(request.headers.authorization).toContain('/us-east-1/s3/aws4_request');
      expect(request.headers['x-amz-content-sha256']).toBeDefined();
    } finally { await server.close(); }
  });
});

describe('s3.rs standard retry', () => {
  it('retries 503 with the SDK standard policy and then succeeds', async () => {
    const server = await spawnFakeS3((_request, index) => (index === 0
      ? { status: 503, body: s3ErrorXml('ServiceUnavailable') }
      : { status: 200, body: 'ok' }));
    try {
      const storage = storageFor(server, 'root');
      expect(Buffer.from((await storage.get('a.txt'))!).toString()).toBe('ok');
      expect(server.log).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('retries throttling errors that arrive as HTTP 400 SlowDown', async () => {
    const server = await spawnFakeS3((_request, index) => (index === 0
      ? { status: 400, body: s3ErrorXml('SlowDown', 'Reduce your request rate.') }
      : { status: 200, body: 'ok' }));
    try {
      const storage = storageFor(server, 'root');
      expect(Buffer.from((await storage.get('a.txt'))!).toString()).toBe('ok');
      expect(server.log).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('retries throttling errors that arrive as HTTP 429', async () => {
    const server = await spawnFakeS3((_request, index) => (index === 0
      ? { status: 429, body: s3ErrorXml('ThrottlingException', 'Rate exceeded') }
      : { status: 200, body: 'ok' }));
    try {
      const storage = storageFor(server, 'root');
      expect(Buffer.from((await storage.get('a.txt'))!).toString()).toBe('ok');
      expect(server.log).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('does not retry a genuine 403 AccessDenied', async () => {
    const server = await spawnFakeS3(() => ({ status: 403, body: s3ErrorXml('AccessDenied', 'Denied') }));
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.get('a.txt'));
      expect(error.message).toContain('AccessDenied');
      expect(server.log).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('honours x-amz-retry-after for throttling codes', async () => {
    const server = await spawnFakeS3((_request, index) => (index === 0
      ? { status: 503, headers: { 'x-amz-retry-after': '1' }, body: s3ErrorXml('SlowDown') }
      : { status: 200, body: 'ok' }));
    try {
      const storage = storageFor(server, 'root');
      expect(Buffer.from((await storage.get('a.txt'))!).toString()).toBe('ok');
      expect(server.log).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('does not retry a genuine 404', async () => {
    const server = await spawnFakeS3(() => ({ status: 404, body: s3ErrorXml('NoSuchKey') }));
    try {
      const storage = storageFor(server, 'root');
      expect(await storage.get('a.txt')).toBeNull();
      expect(server.log).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('stops after three attempts on persistent 5xx and surfaces the service error', async () => {
    const server = await spawnFakeS3(() => ({ status: 500, body: '' }));
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.get('a.txt'));
      expect(error.message).toContain('S3 下载失败');
      expect(server.log).toHaveLength(3);
    } finally { await server.close(); }
  });

  it('retries connector failures (ECONNREFUSED) with the same policy', async () => {
    const probe = createServer();
    await new Promise<void>(resolve => { probe.listen(0, '127.0.0.1', resolve); });
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await new Promise<void>(resolve => { probe.close(() => resolve()); });

    const storage = new S3Storage({
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: 'test-bucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      pathStyle: true,
    }, 'root');

    const error = await failure(storage.get('a.txt'));
    expect(error.message).toContain('ECONNREFUSED');
  });
});

describe('s3.rs endpoint paths', () => {
  it('keeps the endpoint path prefix for path-style requests', async () => {
    const server = await spawnFakeS3(() => ({ status: 200 }));
    try {
      const storage = new S3Storage({
        endpoint: `${server.endpoint}/gateway/s3`,
        bucket: 'test-bucket',
        accessKeyId: 'a',
        secretAccessKey: 's',
        region: 'us-east-1',
        pathStyle: true,
      }, 'root');
      await storage.put('a.txt', Buffer.from('x'));
      expect(server.log[0]!.path).toBe('/gateway/s3/test-bucket/root/a.txt');
    } finally { await server.close(); }
  });

  it('keeps the endpoint path prefix for virtual-hosted requests', async () => {
    const server = await spawnFakeS3(() => ({ status: 200 }));
    try {
      const port = new URL(server.endpoint).port;
      // `test-bucket.localhost` is not resolvable on every Linux resolver. Keep the
      // virtual-hosted Host header under test and resolve it to the in-process server.
      const lookup = (
        _hostname: string,
        options: { all?: boolean },
        callback: (
          error: NodeJS.ErrnoException | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void,
      ): void => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      };
      const agent = new Agent({ lookup } as unknown as ConstructorParameters<typeof Agent>[0]);
      const storage = new S3Storage({
        endpoint: `http://localhost:${port}/gateway/s3`,
        bucket: 'test-bucket',
        accessKeyId: 'a',
        secretAccessKey: 's',
        region: 'us-east-1',
      }, 'root', {
        clientConfig: { requestHandler: new NodeHttpHandler({ httpAgent: agent }) },
      });
      await storage.put('a.txt', Buffer.from('x'));
      expect(server.log[0]!.headers.host).toMatch(/^test-bucket\.localhost:/);
      expect(server.log[0]!.path).toBe('/gateway/s3/root/a.txt');
    } finally { await server.close(); }
  });
});

describe('s3.rs upload verification', () => {
  it('verifies the remote size after a single PUT and deletes a mismatch', async () => {
    const dir = await tempDir();
    const local = join(dir, 'a.txt');
    await writeFile(local, 'hello');
    const server = await spawnFakeS3(request => {
      if (request.method === 'HEAD') {
        return { status: 200, declaredLength: 99, headers: { 'Last-Modified': 'Tue, 03 Nov 2026 00:00:00 GMT' } };
      }
      if (request.method === 'DELETE') return { status: 204 };
      return { status: 200 };
    });
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.putFile('a.txt', local));
      expect(error.message).toContain('云端对象上传后大小不一致');
      expect(server.log.map(entry => entry.method)).toEqual(['PUT', 'HEAD', 'DELETE']);
      expect(server.log[2]!.path).toBe('/test-bucket/root/a.txt');
    } finally { await server.close(); }
  });

  it('returns the local checksum when the remote size matches', async () => {
    const dir = await tempDir();
    const local = join(dir, 'a.txt');
    await writeFile(local, 'hello');
    const server = await spawnFakeS3(request => (request.method === 'HEAD'
      ? { status: 200, declaredLength: 5, headers: { 'Last-Modified': 'Tue, 03 Nov 2026 00:00:00 GMT' } }
      : { status: 200 }));
    try {
      const storage = storageFor(server, 'root');
      expect(await storage.putFile('a.txt', local))
        .toBe(createHash('sha256').update('hello').digest('hex'));
      expect(server.log.map(entry => entry.method)).toEqual(['PUT', 'HEAD']);
    } finally { await server.close(); }
  });
});

describe('s3.rs resumable download', () => {
  const head = { status: 200, declaredLength: 10, headers: { 'Last-Modified': 'Tue, 03 Nov 2026 00:00:00 GMT' } };

  it('resumes from the requested byte offset when the server honours Range', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'a.bin');
    await writeFile(dest, '0123');
    const server = await spawnFakeS3(request => (request.method === 'HEAD'
      ? head
      : { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' }, body: '456789' }));
    try {
      const storage = storageFor(server, 'root');
      expect(await storage.getFileResumable('a.bin', dest, 4)).toBe(4);
      expect(await readLocalFile(dest, 'utf8')).toBe('0123456789');
      const get = server.log.find(entry => entry.method === 'GET')!;
      expect(get.headers.range).toBe('bytes=4-');
    } finally { await server.close(); }
  });

  it('restarts from zero when the server ignores Range', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'a.bin');
    await writeFile(dest, '0123');
    const server = await spawnFakeS3(request => (request.method === 'HEAD'
      ? head
      : { status: 200, body: '0123456789' }));
    try {
      const storage = storageFor(server, 'root');
      expect(await storage.getFileResumable('a.bin', dest, 4)).toBe(0);
      expect(await readLocalFile(dest, 'utf8')).toBe('0123456789');
    } finally { await server.close(); }
  });

  it('fails closed on a misaligned Content-Range and leaves the resume file untouched', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'a.bin');
    await writeFile(dest, '0123');
    const server = await spawnFakeS3(request => (request.method === 'HEAD'
      ? head
      : { status: 206, headers: { 'Content-Range': 'bytes 5-9/10' }, body: '56789' }));
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.getFileResumable('a.bin', dest, 4));
      expect(error.message).toContain('拒绝错位追加');
      expect(await readLocalFile(dest, 'utf8')).toBe('0123');
    } finally { await server.close(); }
  });

  it('rejects a local resume file whose size does not match the offset', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'a.bin');
    await writeFile(dest, '01');
    const server = await spawnFakeS3(request => (request.method === 'HEAD'
      ? head
      : { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' }, body: '456789' }));
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.getFileResumable('a.bin', dest, 4));
      expect(error.message).toContain('拒绝错位追加');
      expect(await readLocalFile(dest, 'utf8')).toBe('01');
    } finally { await server.close(); }
  });
});

describe('s3.rs prefix read', () => {
  it('requests bytes=0-(n-1) and truncates the stream to the prefix', async () => {
    const server = await spawnFakeS3(() => ({
      status: 206,
      headers: { 'Content-Range': 'bytes 0-3/10' },
      body: '0123456789',
    }));
    try {
      const storage = storageFor(server, 'root');
      expect(Buffer.from((await storage.getPrefix('a.bin', 4))!).toString()).toBe('0123');
      expect(server.log[0]!.headers.range).toBe('bytes=0-3');
    } finally { await server.close(); }
  });

  it('returns null for a missing object and does no request for an empty prefix', async () => {
    const server = await spawnFakeS3(() => ({ status: 404, body: s3ErrorXml('NoSuchKey') }));
    try {
      const storage = storageFor(server, 'root');
      expect(await storage.getPrefix('missing.bin', 4)).toBeNull();
      expect(await storage.getPrefix('missing.bin', 0)).toEqual(new Uint8Array());
      expect(server.log).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('fails closed when the server returns a non-zero prefix start', async () => {
    const server = await spawnFakeS3(() => ({
      status: 206,
      headers: { 'Content-Range': 'bytes 2-5/10' },
      body: '2345',
    }));
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.getPrefix('a.bin', 4));
      expect(error.message).toContain('前缀起点不是 0');
    } finally { await server.close(); }
  });
});

describe('s3.rs bounded memory download', () => {
  it('rejects a declared length over the caller budget before reading the body', async () => {
    const server = await spawnFakeS3(() => ({ status: 200, declaredLength: 100, body: 'x' }));
    try {
      const storage = storageFor(server, 'root');
      const error = await failure(storage.getBounded('a.bin', 10));
      expect(error.message).toContain('超出调用方内存预算');
      expect(error.message).toContain('声明 100 字节 > 预算 10 字节');
      expect(server.log).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('fails closed when the response body is shorter than its declared length', async () => {
    const server = await spawnFakeS3(() => ({ status: 200, declaredLength: 10, body: '0123' }));
    try {
      const storage = storageFor(server, 'root');
      await expect(storage.getBounded('a.bin', 100)).rejects.toThrow();
    } finally { await server.close(); }
  });
});

describe('s3.rs stale multipart cleanup', () => {
  it('aborts only stale uploads for the exact key', async () => {
    const now = Date.now();
    const stale = new Date(now - (MULTIPART_STALE_SECS + 3_600) * 1_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    const body = '<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult>'
      + `<Upload><Key>root/a.txt</Key><UploadId>stale-1</UploadId><Initiated>${stale}</Initiated></Upload>`
      + `<Upload><Key>root/a.txt</Key><UploadId>recent-1</UploadId><Initiated>${recent}</Initiated></Upload>`
      + `<Upload><Key>root/other.txt</Key><UploadId>other-1</UploadId><Initiated>${stale}</Initiated></Upload>`
      + '<Upload><Key>root/a.txt</Key><UploadId>unknown-1</UploadId></Upload>'
      + '<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>';
    const server = await spawnFakeS3(request => (request.method === 'GET'
      ? { status: 200, body }
      : { status: 204 }));
    try {
      const storage = storageFor(server, 'root');
      await storage.abortStaleMultipartUploads('root/a.txt');
      const deletes = server.log.filter(entry => entry.method === 'DELETE');
      expect(deletes.map(entry => entry.query.get('uploadId'))).toEqual(['stale-1']);
      expect(deletes[0]!.query.get('uploads')).toBeNull();
      expect(server.log[0]!.query.get('prefix')).toBe('root/a.txt');
    } finally { await server.close(); }
  });

  it('never blocks the upload when listing in-progress uploads fails', async () => {
    const server = await spawnFakeS3(() => ({ status: 500 }));
    try {
      const recorder = recordingLogger();
      const storage = storageFor(server, 'root', {
        logger: recorder.log,
        clientConfig: { maxAttempts: 1 },
      });
      await expect(storage.abortStaleMultipartUploads('root/a.txt')).resolves.toBeUndefined();
      expect(recorder.warns.join('\n')).toContain('列举未完成 multipart 失败');
    } finally { await server.close(); }
  });
});

describe('s3.rs multipart parts', () => {
  it('retries a failed part within the same upload id', async () => {
    const server = await spawnFakeS3((_request, index) => (index === 0
      ? { status: 500, body: s3ErrorXml('InternalError') }
      : { status: 200, headers: { ETag: '"etag-1"' } }));
    try {
      const recorder = recordingLogger();
      const storage = storageFor(server, 'root', {
        logger: recorder.log,
        clientConfig: { maxAttempts: 1 },
      });
      const internals = storage as unknown as {
        uploadPartWithRetry(fullKey: string, uploadId: string, partNumber: number, chunk: Buffer): Promise<string>;
      };
      const etag = await internals.uploadPartWithRetry('root/a.txt', 'upload-1', 1, Buffer.from('abc'));
      expect(etag).toBe('"etag-1"');
      expect(server.log).toHaveLength(2);
      for (const request of server.log) {
        expect(request.query.get('uploadId')).toBe('upload-1');
        expect(request.query.get('partNumber')).toBe('1');
      }
      expect(recorder.warns.join('\n')).toContain('将重试同一分块');
    } finally { await server.close(); }
  });
});

describe('s3.rs list pagination', () => {
  it('follows continuation tokens and returns relative keys sorted by time', async () => {
    const page1 = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>'
      + '<IsTruncated>true</IsTruncated><NextContinuationToken>tok-1</NextContinuationToken>'
      + '<Contents><Key>root/a.txt</Key><Size>3</Size>'
      + '<LastModified>2026-11-02T00:00:00.000Z</LastModified><ETag>"e1"</ETag></Contents>'
      + '</ListBucketResult>';
    const page2 = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>'
      + '<IsTruncated>false</IsTruncated>'
      + '<Contents><Key>root/b.txt</Key><Size>5</Size>'
      + '<LastModified>2026-11-03T00:00:00.000Z</LastModified></Contents>'
      + '</ListBucketResult>';
    const server = await spawnFakeS3(request => (request.query.get('continuation-token') === 'tok-1'
      ? { status: 200, body: page2 }
      : { status: 200, body: page1 }));
    try {
      const storage = storageFor(server, 'root');
      const files = await storage.list('');
      expect(files.map(file => file.key)).toEqual(['b.txt', 'a.txt']);
      expect(files[0]!.lastModified).toBe('2026-11-03T00:00:00Z');
      expect(files[1]!.etag).toBe('"e1"');
      expect(server.log[1]!.query.get('continuation-token')).toBe('tok-1');
    } finally { await server.close(); }
  });
});

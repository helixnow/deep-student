import './local-fs-fixture.ts';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudStorageError } from '../src/errors.ts';
import { CONTROL_PLANE_HEADER_TIMEOUT_MS } from '../src/http.ts';
import {
  MAX_RETRY_WAIT_MS,
  WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES,
  WebDavStorage,
  type WebDavStorageOptions,
} from '../src/webdav.ts';
import { clearCancelToken, clearStatusHook, setStatusHook } from '../src/traits.ts';
import { countMethod, spawnFakeDav, type Responder } from './fake_dav.ts';

const rawServers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  clearStatusHook();
  clearCancelToken();
  for (const server of rawServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function listenRaw(handler: (method: string, path: string, res: ServerResponse, index: number) => void): Promise<{ endpoint: string; log: Array<[string, string]> }> {
  const log: Array<[string, string]> = [];
  let index = 0;
  const server = createServer((req, res) => {
    req.resume();
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    log.push([method, path]);
    handler(method, path, res, index++);
  });
  rawServers.push(server);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

function davFor(endpoint: string, root = 'sync', options: WebDavStorageOptions = {}): WebDavStorage {
  return new WebDavStorage(
    { endpoint, username: 'user', password: 'pass' },
    root,
    { rateLimitEnv: '0', requestWindowKey: `${endpoint}|${root}|${Math.random()}`, ...options },
  );
}

async function expectFailure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected promise to reject');
}

describe('G30 WebDAV 503 circuit breaker, control-plane timeout, and post-sleep status', () => {
  it('emits post-sleep status update before sending retry request so UI never freezes on countdown', async () => {
    const statuses: string[] = [];
    const seenAtRetry: string[] = [];
    setStatusHook(msg => { statuses.push(msg); });

    const server = await spawnFakeDav((_method, _path, index) => {
      if (index === 0) return { status: 503, headers: { 'Retry-After': '1' }, body: 'busy' };
      seenAtRetry.push(statuses[statuses.length - 1] ?? '');
      return { status: 200, body: 'ok' };
    });

    try {
      const storage = davFor(server.endpoint);
      const data = await storage.get('manifest.json');
      expect(Buffer.from(data!).toString('utf8')).toBe('ok');
      expect(statuses.some(s => s.includes('自动重试（第 2/3 次）'))).toBe(true);
      expect(statuses.some(s => s.includes('正在重试（第 2/3 次）'))).toBe(true);
      expect(seenAtRetry).toEqual(['正在重试（第 2/3 次）…']);
    } finally {
      await server.close();
    }
  });

  it('trips per-sync consecutive-503 circuit breaker after 3 consecutive 503s and short-circuits follow-up requests with zero wire traffic', async () => {
    const server = await spawnFakeDav(() => ({
      status: 503,
      headers: { 'Retry-After': '0' },
      body: 'upstream unavailable',
    }));

    try {
      const storage = davFor(server.endpoint, 'sync/nested');
      const firstError = await expectFailure(storage.get('format.json'));
      expect(firstError).toBeInstanceOf(CloudStorageError);
      expect(firstError.message).toContain('HTTP 503');
      expect(countMethod(server.log, 'GET')).toBe(3);

      const hitsBefore = server.log.length;
      const secondError = await expectFailure(storage.list('data_governance'));
      expect(secondError.message).toContain('HTTP 503');
      expect(secondError.message).toContain('熔断');

      const thirdError = await expectFailure(storage.put('a/b/c.json', Buffer.from('{}')));
      expect(thirdError.message).toContain('HTTP 503');
      expect(thirdError.message).toContain('熔断');

      const fourthError = await expectFailure(storage.delete('locks/lease.json'));
      expect(fourthError.message).toContain('HTTP 503');
      expect(fourthError.message).toContain('熔断');

      expect(server.log.length).toBe(hitsBefore);
    } finally {
      await server.close();
    }
  });

  it('resets consecutive-503 counter after a healthy response so transient 503 blips recover cleanly', async () => {
    let calls = 0;
    const responder: Responder = () => {
      calls += 1;
      // 2x 503 then 200, repeated twice (total 4x 503, never 3 consecutive)
      return calls % 3 === 0
        ? { status: 200, body: `ok-${calls}` }
        : { status: 503, headers: { 'Retry-After': '0' }, body: 'transient' };
    };
    const server = await spawnFakeDav(responder);
    try {
      const storage = davFor(server.endpoint);
      expect(Buffer.from((await storage.get('one.json'))!).toString()).toBe('ok-3');
      expect(Buffer.from((await storage.get('two.json'))!).toString()).toBe('ok-6');
    } finally {
      await server.close();
    }
  });

  it('trips cumulative 503 ceiling on alternating weak-net 503/200 fault storms instead of absorbing hundreds of silent faults', async () => {
    let calls = 0;
    const server = await spawnFakeDav(() => {
      calls += 1;
      return calls % 2 === 1
        ? { status: 503, headers: { 'Retry-After': '0' }, body: 'flaky' }
        : { status: 200, body: 'ok' };
    });
    try {
      const storage = davFor(server.endpoint, 'sync', { maxTotal503s: 4 });
      await storage.get('k1');
      await storage.get('k2');
      await storage.get('k3');
      const err = await expectFailure(storage.get('k4'));
      expect(err.message).toContain('HTTP 503');
      expect(countMethod(server.log, 'GET')).toBeLessThanOrEqual(7);
    } finally {
      await server.close();
    }
  });

  it('caps interactive Retry-After wait to <= 8s and aborts when per-sync retry time budget is exhausted', async () => {
    expect(MAX_RETRY_WAIT_MS).toBeLessThanOrEqual(8_000);
    const server = await spawnFakeDav(() => ({
      status: 503,
      headers: { 'Retry-After': '120' },
      body: 'service overloaded',
    }));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const storage = davFor(server.endpoint, 'sync', { retryBudgetMs: 12_000 });
      const pending = expectFailure(storage.get('manifest.json'));
      // Attempt 0 fails immediately -> sleeps MAX_RETRY_WAIT_MS (8s, used=8s)
      // Attempt 1 fails immediately -> next sleep (8s) would exceed 12s budget -> fails immediately!
      await vi.waitFor(() => { expect(countMethod(server.log, 'GET')).toBe(1); });
      await vi.advanceTimersByTimeAsync(MAX_RETRY_WAIT_MS);
      const error = await pending;
      expect(error.message).toContain('重试时间上限');
      expect(error.message).toContain('HTTP 503');
      expect(countMethod(server.log, 'GET')).toBe(2);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it('uses fast control-plane header timeout (15s) on PROPFIND/GET and stops within retry budget instead of hanging 120s', async () => {
    const hung = await listenRaw(() => {
      // Intentionally never write headers
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const storage = davFor(hung.endpoint, 'sync');
      const pending = expectFailure(storage.stat('manifest.json'));
      await vi.waitFor(() => { expect(hung.log).toHaveLength(1); });
      await vi.advanceTimersByTimeAsync(CONTROL_PLANE_HEADER_TIMEOUT_MS);
      const error = await pending;
      expect(error).toBeInstanceOf(CloudStorageError);
      expect(error.message).toContain(`等待响应头超时（${Math.round(CONTROL_PLANE_HEADER_TIMEOUT_MS / 1000)} 秒）`);
      expect(error.message).toContain('重试时间上限');
      expect(hung.log).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the extended header timeout for large streaming putFile uploads above the control-plane threshold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webdav-large-put-'));
    tempDirs.push(dir);
    const localFile = join(dir, 'large.bin');
    const largeBytes = new Uint8Array(WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES + 1024);
    await writeFile(localFile, largeBytes);

    let finishPut: (() => void) | null = null;
    const server = await listenRaw((method, path, res) => {
      if (method === 'MKCOL') {
        res.writeHead(405, { 'content-length': '0' });
        res.end();
        return;
      }
      if (method === 'PUT') {
        finishPut = () => {
          res.writeHead(201, { 'content-length': '0' });
          res.end();
        };
        return;
      }
      if (method === 'PROPFIND') {
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href><d:propstat><d:prop><d:getcontentlength>${largeBytes.byteLength}</d:getcontentlength><d:getlastmodified>Fri, 07 Aug 2026 08:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
        res.writeHead(207, { 'content-length': String(Buffer.byteLength(xml)) });
        res.end(xml);
        return;
      }
      res.writeHead(404, { 'content-length': '0' });
      res.end();
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const storage = davFor(server.endpoint, 'sync', { controlPlaneHeaderTimeoutMs: 1_000 });
      const uploadPromise = storage.putFile('blobs/large.bin', localFile);
      await vi.waitFor(() => { expect(finishPut).not.toBeNull(); });
      // Advance well beyond controlPlaneHeaderTimeoutMs (1s): large streaming PUT must NOT abort!
      await vi.advanceTimersByTimeAsync(20_000);
      finishPut!();
      const checksum = await uploadPromise;
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

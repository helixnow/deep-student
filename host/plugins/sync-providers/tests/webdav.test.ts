import './local-fs-fixture.ts';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CloudStorageError } from '../src/errors.ts';
import {
  MAX_ERROR_BODY_BYTES,
  MAX_RETRY_WAIT_MS,
  NUTSTORE_REQUESTS_PER_WINDOW,
  RATE_WINDOW_MS,
  WebDavStorage,
  backoffDelayMs,
  cappedRetryAfter,
  isRateLimitResponse,
  isSuspiciousResponseCount,
  parseRetryAfter,
  summarizeErrorBody,
} from '../src/webdav.ts';
import { getFileWithOptionalResume } from '../src/resume.ts';
import { isCloudRateLimited } from '../src/mod.ts';
import { clearCancelToken, isSyncCancelled, setCancelToken, MEMORY_GET_DEFAULT_BUDGET_BYTES } from '../src/traits.ts';
import { countMethod, filePropfindXml, multistatusXml, spawnFakeDav, type Responder } from './fake_dav.ts';

const tempDirs: string[] = [];
afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempFile(name: string, data: Uint8Array | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'webdav-test-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

/** Rate limiting is disabled for fake servers; nutstore cases opt in explicitly. */
function storageFor(endpoint: string, root: string, rateLimitEnv = '0'): WebDavStorage {
  return new WebDavStorage(
    { endpoint, username: 'user', password: 'pass' },
    root,
    { rateLimitEnv, requestWindowKey: `${endpoint}|${root}|${Math.random()}` },
  );
}

function testStorage(root = 'deep-student-sync-contract/webdav/uuid'): WebDavStorage {
  return new WebDavStorage(
    { endpoint: 'http://localhost:8080/', username: 'webdav', password: 'webdav123' },
    root,
    { rateLimitEnv: '0' },
  );
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

describe('webdav.rs', () => {
  it('cancelled_token_aborts_waits', async () => {
    const { cancellableSleep } = await import('../src/traits.ts');
    expect(isSyncCancelled()).toBe(false);
    await cancellableSleep(1);

    const controller = new AbortController();
    setCancelToken(controller.signal);
    expect(isSyncCancelled()).toBe(false);
    await cancellableSleep(1);

    controller.abort();
    expect(isSyncCancelled()).toBe(true);
    const started = Date.now();
    const interrupted = await failure(cancellableSleep(60_000));
    expect(interrupted).toBeInstanceOf(CloudStorageError);
    expect(Date.now() - started).toBeLessThan(5_000);

    const nutstore = new WebDavStorage(
      { endpoint: 'https://dav.jianguoyun.com/dav/', username: 'cancel-test', password: 'secret' },
      'root',
      { rateLimitEnv: undefined, requestWindowKey: `cancel-${Math.random()}` },
    );
    const internals = nutstore as unknown as {
      requestsPerWindow: number;
      requestWindow: number[];
      acquireRequestSlot(): Promise<void>;
    };
    if (internals.requestsPerWindow > 0) {
      for (let i = 0; i < internals.requestsPerWindow; i++) internals.requestWindow.push(performance.now());
      const slotStarted = Date.now();
      expect(await failure(internals.acquireRequestSlot())).toBeInstanceOf(CloudStorageError);
      expect(Date.now() - slotStarted).toBeLessThan(5_000);
    }

    clearCancelToken();
    expect(isSyncCancelled()).toBe(false);
  });

  it('provider_rate_limit_window_is_shared_across_storage_instances', () => {
    const config = (username: string) => ({
      endpoint: 'https://dav.jianguoyun.com/dav/', username, password: 'secret',
    });
    const first = new WebDavStorage(config('alice'), 'one', { rateLimitEnv: undefined, requestWindowKey: 'shared-alice' });
    const second = new WebDavStorage(config('alice'), 'two', { rateLimitEnv: undefined, requestWindowKey: 'shared-alice' });
    const otherUser = new WebDavStorage(config('bob'), 'one', { rateLimitEnv: undefined, requestWindowKey: 'shared-bob' });

    const internals = (storage: WebDavStorage) => storage as unknown as {
      requestWindow: number[];
      requestsPerWindow: number;
    };
    expect(internals(first).requestWindow).toBe(internals(second).requestWindow);
    expect(internals(first).requestWindow).not.toBe(internals(otherUser).requestWindow);
    expect(internals(first).requestsPerWindow).toBe(NUTSTORE_REQUESTS_PER_WINDOW);
  });

  it.each([
    ['wall clock moves backward after the monotonic window expires', -3_600_000, RATE_WINDOW_MS, true],
    ['wall clock moves forward before the monotonic window expires', 3_600_000, 0, false],
    ['both clocks reach the window boundary', RATE_WINDOW_MS, RATE_WINDOW_MS, true],
    ['both clocks remain just inside the window', RATE_WINDOW_MS - 1, RATE_WINDOW_MS - 1, false],
  ] as const)('rate_limit_uses_monotonic_elapsed_time: %s', async (label, wallElapsed, monotonicElapsed, available) => {
    let wall = 1_700_000_000_000;
    let monotonic = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const config = { endpoint: 'https://dav.jianguoyun.com/dav/', username: label, password: 'secret' };
    const options = { rateLimitEnv: '1', requestWindowKey: `monotonic-${label}` };
    const first = new WebDavStorage(config, 'one', options);
    const second = new WebDavStorage(config, 'two', options);
    const gate = (storage: WebDavStorage) => storage as unknown as { acquireRequestSlot(): Promise<void> };
    try {
      clearCancelToken();
      await gate(first).acquireRequestSlot();
      wall += wallElapsed;
      monotonic += monotonicElapsed;
      const controller = new AbortController();
      controller.abort();
      setCancelToken(controller.signal);
      // An available slot returns immediately. A full window enters the real
      // cancellableSleep and rejects, without a fake sleep or a 30-minute wait.
      if (available) await expect(gate(second).acquireRequestSlot()).resolves.toBeUndefined();
      else {
        const error = await failure(gate(second).acquireRequestSlot());
        expect(error).toBeInstanceOf(CloudStorageError);
        expect(error.message).toBe('云同步已取消');
      }
    } finally {
      clearCancelToken();
      vi.restoreAllMocks();
    }
  });

  it('build_url_adds_root_once', () => {
    const url = testStorage().buildUrl('objects/basic/hello.txt');
    expect(url.href).toBe('http://localhost:8080/deep-student-sync-contract/webdav/uuid/objects/basic/hello.txt');
  });

  it('build_path_url_uses_raw_server_path', () => {
    const url = testStorage().buildPathUrl('deep-student-sync-contract/webdav/uuid/');
    expect(url.href).toBe('http://localhost:8080/deep-student-sync-contract/webdav/uuid/');
  });

  it('remote_path_joins_once', () => {
    const storage = testStorage();
    const internals = storage as unknown as { remotePath(key: string): string };
    expect(internals.remotePath('objects/basic/hello.txt'))
      .toBe('deep-student-sync-contract/webdav/uuid/objects/basic/hello.txt');
    expect(internals.remotePath('objects/')).toBe('deep-student-sync-contract/webdav/uuid/objects/');
    expect(storage.buildUrl('objects/').pathname).toBe('/deep-student-sync-contract/webdav/uuid/objects/');
  });

  it('extract_relative_key_handles_empty_root', () => {
    const storage = new WebDavStorage(
      { endpoint: 'http://localhost:8080/dav/', username: 'webdav', password: 'webdav123' },
      '',
      { rateLimitEnv: '0' },
    );
    expect(storage.extractRelativeKey('/dav/data_governance/manifest.json', '')).toBe('data_governance/manifest.json');
    expect(storage.extractRelativeKey(
      'http://localhost:8080/dav/data_governance/changes/device/1.json.zst',
      'data_governance/changes',
    )).toBe('data_governance/changes/device/1.json.zst');
    expect(storage.extractRelativeKey('/dav/', '')).toBe('');
  });

  it('extract_relative_key_handles_root_slash_normalization', () => {
    const storage = new WebDavStorage(
      { endpoint: 'http://localhost:8080/dav/', username: 'webdav', password: 'webdav123' },
      '/',
      { rateLimitEnv: '0' },
    );
    expect(storage.extractRelativeKey('/dav/backups/one.zip', 'backups')).toBe('backups/one.zip');
    const internals = storage as unknown as { root: string };
    expect(internals.root).toBe('');
  });

  it('retry_after_parsing_and_cap', () => {
    expect(parseRetryAfter('3')).toBe(3_000);
    expect(parseRetryAfter('garbage')).toBeNull();

    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeLessThanOrEqual(10_000);
    expect(parsed!).toBeGreaterThanOrEqual(7_000);

    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
    expect(cappedRetryAfter({ headers: { 'retry-after': '21600' } })).toBe(MAX_RETRY_WAIT_MS);
    expect(cappedRetryAfter({ headers: { 'retry-after': '3' } })).toBe(3_000);
    expect(cappedRetryAfter({ headers: {} })).toBeNull();
    expect(backoffDelayMs(30)).toBe(MAX_RETRY_WAIT_MS);
  });

  it('retry_after_seconds_preserve_the_full_u64_duration_until_capped', () => {
    const seconds = '18446744073709551615';
    expect(parseRetryAfter(seconds)).toBe(18_446_744_073_709_551_615_000n);
    expect(cappedRetryAfter({ headers: { 'retry-after': seconds } })).toBe(MAX_RETRY_WAIT_MS);
  });

  it('retry_after_seconds_reject_u64_overflow', () => {
    const seconds = '18446744073709551616';
    expect(parseRetryAfter(seconds)).toBeNull();
    expect(cappedRetryAfter({ headers: { 'retry-after': seconds } })).toBeNull();
  });

  it('retry_after_seconds_accept_the_rust_integer_plus_sign', () => {
    expect(parseRetryAfter('+3')).toBe(3_000);
    expect(cappedRetryAfter({ headers: { 'retry-after': '+3' } })).toBe(3_000);
  });

  it('retries_retryable_statuses_and_respects_retry_after', async () => {
    for (const status of [423, 500, 502, 503, 504]) {
      const responder: Responder = (_method, _path, index) => (index === 0
        ? { status, headers: { 'Retry-After': '0' }, body: '' }
        : { status: 200, body: 'payload' });
      const server = await spawnFakeDav(responder);
      try {
        const data = await storageFor(server.endpoint, 'sync').get('obj.bin');
        expect(data, `status=${status}`).not.toBeNull();
        expect(Buffer.from(data!).toString()).toBe('payload');
        expect(countMethod(server.log, 'GET'), `status=${status}`).toBe(2);
      } finally {
        await server.close();
      }
    }
  });

  it('rate_limit_response_preserves_server_detail_without_retry', async () => {
    const body = '<d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com">'
      + '<s:exception>BlockedTemporarily</s:exception>'
      + '<s:message>Too many requests are received recently</s:message></d:error>';
    const server = await spawnFakeDav(() => ({ status: 503, headers: { 'Retry-After': '1800' }, body }));
    try {
      const error = await failure(storageFor(server.endpoint, 'sync').get('obj.bin'));
      expect(error.message).toContain('服务端限流');
      expect(error.message).toContain('BlockedTemporarily');
      expect(error.message).toContain('Too many requests');
      expect(error.message).toContain('Retry-After=1800');
      expect(countMethod(server.log, 'GET')).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('rate_limit_details_survive_all_request_paths_without_retries', async () => {
    const body = '<d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com">'
      + '<s:exception>BlockedTemporarily</s:exception>'
      + '<s:message>Too many requests are received recently</s:message></d:error>';
    const operations = ['get', 'list', 'stat', 'put', 'put_file', 'prefix', 'resume', 'managed_resume', 'connection'] as const;
    for (const status of [429, 503]) {
      for (const operation of operations) {
        const failedMethod = operation === 'list' || operation === 'stat' || operation === 'connection'
          ? 'PROPFIND' : operation === 'put' || operation === 'put_file' ? 'PUT' : 'GET';
        const responder: Responder = (method, path) => {
          if (method === failedMethod) return { status, headers: { 'Retry-After': '1800' }, body };
          if (method === 'MKCOL') return { status: 405 };
          if (method === 'PROPFIND') return { status: 207, body: filePropfindXml(path, 4) };
          return { status: 200, body: 'data' };
        };
        const server = await spawnFakeDav(responder);
        try {
          const storage = storageFor(server.endpoint, 'sync');
          const path = await tempFile('payload', operation === 'managed_resume' ? 'd' : 'data');
          const run = async (): Promise<unknown> => {
            switch (operation) {
              case 'get': return storage.get('object');
              case 'list': return storage.list('objects');
              case 'stat': return storage.stat('object');
              case 'put': return storage.put('object', Buffer.from('data'));
              case 'put_file': return storage.putFile('object', path, null);
              case 'prefix': return storage.getPrefix('object', 4);
              case 'resume': return storage.getFileResumable('object', path, 1, null);
              case 'managed_resume': return getFileWithOptionalResume(storage, 'object', path, null, null);
              case 'connection': return storage.checkConnection();
            }
          };
          const error = await failure(run());
          const context = `${operation}/${status}`;
          expect(isCloudRateLimited(error.message), context).toBe(true);
          expect(error.message, context).toContain('BlockedTemporarily: Too many requests');
          expect(error.message, context).toContain('Retry-After=1800');
          expect(countMethod(server.log, failedMethod), context).toBe(1);
          if (operation === 'connection') expect(countMethod(server.log, 'GET'), context).toBe(0);
        } finally {
          await server.close();
        }
      }
    }
  });

  it('error_xml_entities_plaintext_and_generic_service_outages_remain_distinct', () => {
    const xml = '<error><exception>BlockedTemporarily</exception>'
      + '<message>Too many requests &amp; busy</message></error>';
    expect(summarizeErrorBody(xml)).toBe('BlockedTemporarily: Too many requests & busy');
    expect(summarizeErrorBody('  gateway\n unavailable  ')).toBe('gateway unavailable');
    expect(isRateLimitResponse(503, 'upstream temporarily unavailable')).toBe(false);
    expect(isRateLimitResponse(429, '')).toBe(true);
  });

  it('oversized_error_body_is_bounded_and_still_reports_status', async () => {
    const server = await spawnFakeDav(() => ({ status: 429, body: 'x'.repeat(MAX_ERROR_BODY_BYTES * 4) }));
    try {
      const error = await failure(storageFor(server.endpoint, 'sync').get('object'));
      expect(error.message).toContain('HTTP 429');
      expect(error.message.length).toBeLessThan(MAX_ERROR_BODY_BYTES + 512);
      expect(countMethod(server.log, 'GET')).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('does_not_retry_deterministic_client_errors', async () => {
    const server = await spawnFakeDav(() => ({ status: 403 }));
    try {
      await failure(storageFor(server.endpoint, 'sync').get('obj.bin'));
      expect(countMethod(server.log, 'GET')).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('retry_is_bounded_when_server_keeps_failing', async () => {
    const server = await spawnFakeDav(() => ({ status: 503, headers: { 'Retry-After': '0' } }));
    try {
      await failure(storageFor(server.endpoint, 'sync').get('obj.bin'));
      expect(countMethod(server.log, 'GET')).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('put_file_retries_on_503_with_retry_after', async () => {
    let putHits = 0;
    const responder: Responder = (method, path) => {
      if (method === 'MKCOL') return { status: 405 };
      if (method === 'PUT') {
        putHits += 1;
        return putHits === 1 ? { status: 503, headers: { 'Retry-After': '0' } } : { status: 201 };
      }
      if (method === 'PROPFIND') return { status: 207, body: filePropfindXml(path, 17) };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      const local = await tempFile('upload.bin', 'streaming payload');
      await storageFor(server.endpoint, 'sync').putFile('objects/upload.bin', local, null);
      expect(putHits).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('put_file_fails_when_propfind_size_mismatches', async () => {
    let deleteHits = 0;
    const responder: Responder = (method, path) => {
      if (method === 'MKCOL') return { status: 405 };
      if (method === 'PUT') return { status: 201 };
      if (method === 'PROPFIND') return { status: 207, body: filePropfindXml(path, 1) };
      if (method === 'DELETE') { deleteHits += 1; return { status: 204 }; }
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      const local = await tempFile('upload.bin', 'streaming payload');
      const error = await failure(storageFor(server.endpoint, 'sync').putFile('objects/upload.bin', local, null));
      expect(error.message).toContain('云端对象上传后大小不一致');
      expect(deleteHits).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it('check_connection_survives_collection_get_501', async () => {
    const responder: Responder = method => {
      if (method === 'MKCOL') return { status: 405 };
      if (method === 'PROPFIND') return { status: 207, body: multistatusXml('/sync/', 0) };
      if (method === 'GET') return { status: 501 };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      await storageFor(server.endpoint, 'sync').checkConnection();
      expect(countMethod(server.log, 'PROPFIND')).toBeGreaterThanOrEqual(1);
      expect(countMethod(server.log, 'GET')).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('check_connection_fails_when_mkcol_rejected_and_root_missing', async () => {
    for (const mkcolStatus of [403, 507, 500]) {
      const responder: Responder = method => {
        if (method === 'MKCOL') return { status: mkcolStatus, headers: { 'Retry-After': '0' } };
        if (method === 'PROPFIND') return { status: 404 };
        return { status: 500 };
      };
      const server = await spawnFakeDav(responder);
      try {
        const error = await failure(storageFor(server.endpoint, 'sync').checkConnection());
        expect(error.message, `mkcol_status=${mkcolStatus}`).toContain('无法创建');
        expect(countMethod(server.log, 'MKCOL')).toBeGreaterThanOrEqual(1);
        expect(countMethod(server.log, 'PROPFIND')).toBeGreaterThanOrEqual(1);
      } finally {
        await server.close();
      }
    }
  });

  it('check_connection_tolerates_404_when_mkcol_succeeds', async () => {
    const responder: Responder = method => {
      if (method === 'MKCOL') return { status: 201 };
      if (method === 'PROPFIND') return { status: 404 };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      await storageFor(server.endpoint, 'sync').checkConnection();
    } finally {
      await server.close();
    }
  });

  it('check_connection_fails_when_mkcol_chain_conflicts_and_root_missing', async () => {
    const responder: Responder = method => {
      if (method === 'MKCOL') return { status: 409 };
      if (method === 'PROPFIND') return { status: 404 };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      const error = await failure(storageFor(server.endpoint, 'sync/nested').checkConnection());
      expect(error.message).toContain('409');
      expect(error.message).toContain('无法创建');
      expect(countMethod(server.log, 'MKCOL')).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('check_connection_tolerates_409_when_root_exists', async () => {
    const responder: Responder = method => {
      if (method === 'MKCOL') return { status: 409 };
      if (method === 'PROPFIND') return { status: 207, body: multistatusXml('/sync/', 0) };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      await storageFor(server.endpoint, 'sync').checkConnection();
    } finally {
      await server.close();
    }
  });

  it('check_connection_deeper_mkcol_success_clears_earlier_conflict', async () => {
    const responder: Responder = (method, path) => {
      if (method === 'MKCOL') return path === '/a/' ? { status: 409 } : { status: 201 };
      if (method === 'PROPFIND') return { status: 404 };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      await storageFor(server.endpoint, 'a/b').checkConnection();
    } finally {
      await server.close();
    }
  });

  it('check_connection_reports_lock_and_rate_limit_instead_of_create_failure', async () => {
    for (const [status, keyword] of [[423, '锁定'], [429, '限流']] as const) {
      const responder: Responder = method => {
        if (method === 'MKCOL') return { status, headers: { 'Retry-After': '0' } };
        if (method === 'PROPFIND') return { status: 404 };
        return { status: 500 };
      };
      const server = await spawnFakeDav(responder);
      try {
        const error = await failure(storageFor(server.endpoint, 'sync').checkConnection());
        expect(error.message, `status=${status}`).toContain(keyword);
        if (status === 423) {
          expect(error.message).toContain('稍后重试');
        } else {
          expect(isCloudRateLimited(error.message)).toBe(true);
          expect(error.message).toContain('未重试');
        }
        expect(error.message, `status=${status}`).not.toContain('无法创建');
      } finally {
        await server.close();
      }
    }
  });

  it('check_connection_get_fallback_404_fails_when_mkcol_rejected', async () => {
    const responder: Responder = method => {
      if (method === 'MKCOL') return { status: 403 };
      if (method === 'PROPFIND') return { status: 501 };
      if (method === 'GET') return { status: 404 };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      await failure(storageFor(server.endpoint, 'sync').checkConnection());
    } finally {
      await server.close();
    }
  });

  it('directory_cache_skips_repeat_mkcol', async () => {
    const responder: Responder = method => {
      if (method === 'MKCOL') return { status: 201 };
      if (method === 'PUT') return { status: 201 };
      return { status: 500 };
    };
    const server = await spawnFakeDav(responder);
    try {
      const storage = storageFor(server.endpoint, 'sync');
      await storage.put('a/b/one.bin', Buffer.from('1'));
      expect(countMethod(server.log, 'MKCOL')).toBe(3);
      await storage.put('a/b/two.bin', Buffer.from('2'));
      expect(countMethod(server.log, 'MKCOL')).toBe(3);
      await storage.put('a/c/three.bin', Buffer.from('3'));
      expect(countMethod(server.log, 'MKCOL')).toBe(4);
    } finally {
      await server.close();
    }
  });

  it('suspicious_response_count_boundaries', () => {
    expect(isSuspiciousResponseCount(100)).toBe(false);
    expect(isSuspiciousResponseCount(101)).toBe(false);
    expect(isSuspiciousResponseCount(102)).toBe(false);
    expect(isSuspiciousResponseCount(200)).toBe(false);
    expect(isSuspiciousResponseCount(500)).toBe(false);
    expect(isSuspiciousResponseCount(750)).toBe(true);
    expect(isSuspiciousResponseCount(751)).toBe(true);
    expect(isSuspiciousResponseCount(749)).toBe(false);
    expect(isSuspiciousResponseCount(752)).toBe(false);
    expect(isSuspiciousResponseCount(1000)).toBe(true);
    expect(isSuspiciousResponseCount(1001)).toBe(true);
    expect(isSuspiciousResponseCount(999)).toBe(false);
    expect(isSuspiciousResponseCount(1002)).toBe(false);
    expect(isSuspiciousResponseCount(1999)).toBe(false);
    expect(isSuspiciousResponseCount(2000)).toBe(false);
    expect(isSuspiciousResponseCount(2001)).toBe(false);
    expect(isSuspiciousResponseCount(3000)).toBe(false);
    expect(isSuspiciousResponseCount(3001)).toBe(false);
  });

  it('list_outcome_truncation_matrix_via_fake_server', async () => {
    const matrix: Array<[number, boolean]> = [
      [99, false], [100, false], [101, false], [750, true], [1999, false], [2000, false],
    ];
    for (const [entries, expectedTruncated] of matrix) {
      const xml = multistatusXml('/sync/', entries);
      const responder: Responder = method => {
        expect(method).toBe('PROPFIND');
        return { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: xml };
      };
      const server = await spawnFakeDav(responder);
      try {
        const outcome = await storageFor(server.endpoint, 'sync').listOutcome('');
        expect(outcome.files.length, `entries=${entries}`).toBe(entries);
        expect(outcome.truncated, `entries=${entries}`).toBe(expectedTruncated);
      } finally {
        await server.close();
      }
    }
  });

  it('extract_relative_key_decodes_non_ascii_endpoint_path', () => {
    const storage = new WebDavStorage(
      { endpoint: 'https://dav.jianguoyun.com/dav/我的坚果云/', username: 'user', password: 'pass' },
      'deep-student-sync',
      { rateLimitEnv: '0' },
    );
    const internals = storage as unknown as { baseUrl: URL };
    expect(internals.baseUrl.pathname).toContain('%');
    expect(storage.extractRelativeKey(
      '/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync/data_governance/changes/device-a/000000000001-1723372800-nonce.json.zst',
      'data_governance/changes',
    )).toBe('data_governance/changes/device-a/000000000001-1723372800-nonce.json.zst');
    expect(storage.extractRelativeKey(
      'https://dav.jianguoyun.com/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync/manifests/device-a.json',
      '',
    )).toBe('manifests/device-a.json');
    expect(storage.extractRelativeKey(
      '/dav/我的坚果云/deep-student-sync/backups/20260801.zip',
      'backups',
    )).toBe('backups/20260801.zip');
    expect(storage.extractRelativeKey(
      '/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync/',
      '',
    )).toBe('');
  });

  it('extract_relative_key_decodes_space_in_endpoint_path', () => {
    const storage = new WebDavStorage(
      { endpoint: 'http://localhost:8080/My%20Dav/', username: 'user', password: 'pass' },
      'sync root',
      { rateLimitEnv: '0' },
    );
    const key = storage.extractRelativeKey('/My%20Dav/sync%20root/objects/a%20b.txt', 'objects');
    expect(key).toBe('objects/a b.txt');
    expect(storage.buildUrl(key).pathname).toBe('/My%20Dav/sync%20root/objects/a%20b.txt');
  });

  it('parse_propfind_entries_with_encoded_hrefs_lists_files_and_subdirs', () => {
    const storage = new WebDavStorage(
      { endpoint: 'https://dav.jianguoyun.com/dav/我的坚果云/', username: 'user', password: 'pass' },
      'deep-student-sync',
      { rateLimitEnv: '0' },
    );
    const base = '/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/deep-student-sync';
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${base}/data_governance/changes/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>${base}/data_governance/changes/device-a/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>${base}/data_governance/changes/instance.json</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>42</d:getcontentlength>
      <d:getlastmodified>Fri, 07 Aug 2026 08:00:00 GMT</d:getlastmodified>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

    const parsed = storage.parsePropfindEntries(xml, 'data_governance/changes', 'data_governance/changes');
    expect(parsed.responseCount).toBe(3);
    expect(parsed.subdirs).toEqual(['data_governance/changes/device-a']);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.key).toBe('data_governance/changes/instance.json');
    expect(parsed.files[0]!.size).toBe(42);
  });

  it('webdav_contract_source_guards', async () => {
    // resourcetype collection is authoritative even when href has no trailing slash,
    // and percent-encoded href segments are decoded before the relative-key compare.
    const storage = testStorage();
    const xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
      + '<d:response><d:href>/deep-student-sync-contract/webdav/uuid/a%20b</d:href>'
      + '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
      + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
      + '</d:multistatus>';
    const parsed = storage.parsePropfindEntries(xml, '', '');
    expect(parsed.subdirs).toEqual(['a b']);

    const server = await spawnFakeDav(() => ({ status: 207, body: multistatusXml('/root/', 0) }));
    try {
      const outcome = await storageFor(server.endpoint, 'root').listOutcome('');
      expect(outcome.truncated).toBe(false);
      const propfind = server.requests.find(request => request.method === 'PROPFIND')!;
      expect(propfind.body.toString('utf8')).toContain('<d:resourcetype/>');
    } finally { await server.close(); }
  });

  it('propfind_sends_the_dav_resourcetype_body', async () => {
    const server = await spawnFakeDav(() => ({ status: 207, body: multistatusXml('/root/', 0) }));
    try {
      await storageFor(server.endpoint, 'root').list('');
      const propfind = server.requests.find(request => request.method === 'PROPFIND')!;
      expect(propfind.body.toString('utf8')).toContain('<d:resourcetype/>');
      expect(propfind.headers.depth).toBe('1');
    } finally {
      await server.close();
    }
  });

  it('get_bounded_rejects_a_declared_length_over_the_caller_budget', async () => {
    const server = await spawnFakeDav(() => ({ status: 200, declaredLength: 100, body: 'x' }));
    try {
      const error = await failure(storageFor(server.endpoint, 'root').getBounded('a.bin', 10));
      expect(error.message).toContain('超出调用方内存预算');
      expect(error.message).toContain('声明 100 字节 > 预算 10 字节');
      expect(countMethod(server.log, 'GET')).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('get_bounded_reports_the_rust_stall_text_when_the_body_stops', async () => {
    // webdav.rs:1667-1677: 90 s per-chunk stall → "WebDAV 内存对象下载停滞超过 90 秒…".
    const server = await spawnFakeDav(() => ({ status: 200, declaredLength: 10, body: '0123', stallAfterBytes: 4 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const settled: { error: Error | null } = { error: null };
      void failure(storageFor(server.endpoint, 'root').getBounded('a.bin', 100)).then(error => { settled.error = error; });
      await vi.waitFor(() => {
        vi.advanceTimersByTime(10_000);
        expect(settled.error).not.toBeNull();
      }, { timeout: 5_000, interval: 20 });
      expect(settled.error!.message).toBe('WebDAV 内存对象下载停滞超过 90 秒，连接可能已断开');
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it('get_bounded_fails_closed_on_a_truncated_body', async () => {
    const server = await spawnFakeDav(() => ({ status: 200, declaredLength: 10, body: '0123' }));
    try {
      await expect(storageFor(server.endpoint, 'root').getBounded('a.bin', 100)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('get_uses_the_default_memory_budget', async () => {
    const server = await spawnFakeDav(() => ({
      status: 200,
      declaredLength: MEMORY_GET_DEFAULT_BUDGET_BYTES + 1,
    }));
    try {
      const error = await failure(storageFor(server.endpoint, 'root').get('a.bin'));
      expect(error.message).toContain(`预算 ${MEMORY_GET_DEFAULT_BUDGET_BYTES} 字节`);
    } finally {
      await server.close();
    }
  });
});

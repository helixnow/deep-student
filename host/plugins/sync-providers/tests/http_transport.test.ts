/**
 * http.ts on top of `ctx.http`: framing, timeouts and error texts stay those of the
 * former node:http client, and production requests go through the Host service.
 */

import { STATUS_CODES, createServer, request as nodeRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequestInit, HttpService } from '../../../platform/http/api.ts';
import { createDesktopHttp } from '../../../platform/http/index.ts';
import { CloudStorageError } from '../src/errors.ts';
import { HEADER_TIMEOUT_MS, canonicalReason, send, setHttpLookup } from '../src/http.ts';
import type { SyncProviderService } from '../api.ts';
import { createSyncHost } from './host_fixture.ts';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  setHttpLookup(null);
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse, recorded: Recorded) => void): Promise<{ base: string; port: number; log: Recorded[] }> {
  const log: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      log.push(recorded);
      handler(req, res, recorded);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, log };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => { server.close(() => resolve()); });
  return port;
}

async function rejection(run: Promise<unknown>): Promise<Error & { code?: string; kind?: string }> {
  try { await run; }
  catch (error) { return error as Error & { code?: string }; }
  throw new Error('expected a rejection');
}

/** The same request through node:http, for byte-identical error text. */
function nodeFailure(url: string, readBody = false): Promise<Error & { code?: string }> {
  return new Promise((resolve) => {
    const req = nodeRequest(url, (message) => {
      if (!readBody) return;
      message.on('data', () => undefined);
      message.on('error', resolve);
    });
    req.on('error', resolve);
    req.end();
  });
}

function reply(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...headers, 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

describe('http.ts response shape', () => {
  it('statusText is node:http STATUS_CODES for every status, whatever reason the server sends', async () => {
    for (let status = 100; status < 600; status++) expect(canonicalReason(status), String(status)).toBe(STATUS_CODES[status] ?? '');
    const server = await listen((_req, res) => {
      res.writeHead(418, 'Custom Reason', { 'x-dup': ['a', 'b'], 'content-length': '3' });
      res.end('tea');
    });
    const response = await send({ method: 'GET', url: new URL(`${server.base}/`) });
    expect(response.status).toBe(418);
    expect(response.statusText).toBe(STATUS_CODES[418]);
    expect(response.headers['x-dup']).toBe('a, b');
    expect(response.contentLength).toBe(3);
    expect(Buffer.from(await response.bytes()).toString()).toBe('tea');
  });

  it('asks for identity encoding on the direct path', async () => {
    const server = await listen((_req, res) => reply(res, 200, 'plain'));
    const response = await send({ method: 'GET', url: new URL(`${server.base}/`) });
    expect(await response.text()).toBe('plain');
    expect(server.log[0]!.headers['accept-encoding']).toBe('identity');
  });
});

describe('http.ts request framing', () => {
  it('request bodies carry an explicit Content-Length (never chunked), bodiless requests none', async () => {
    const server = await listen((_req, res) => reply(res, 201));
    const base = new URL(`${server.base}/f`);
    await send({ method: 'PUT', url: base, bodyFactory: () => new Blob(['stream-body']).stream(), bodyLength: 11 });
    await send({ method: 'PUT', url: base, bodyFactory: () => new Blob([]).stream(), bodyLength: 0 });
    await send({ method: 'PUT', url: base, body: new Uint8Array(0) });
    await send({ method: 'MKCOL', url: base });
    await send({ method: 'DELETE', url: base });
    await send({ method: 'GET', url: base });
    expect(server.log.map(r => [r.method, r.headers['content-length'] ?? null, r.headers['transfer-encoding'] ?? null, r.body.toString()]))
      .toEqual([
        ['PUT', '11', null, 'stream-body'],
        ['PUT', '0', null, ''],
        ['PUT', '0', null, ''],
        ['MKCOL', null, null, ''],
        ['DELETE', null, null, ''],
        ['GET', null, null, ''],
      ]);
  });
});

describe('http.ts transport errors keep the node:http text', () => {
  it('connection refused', async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}/x`;
    const [error, expected] = [await rejection(send({ method: 'GET', url: new URL(url) })), await nodeFailure(url)];
    expect(error.message).toBe(expected.message);
    expect(error.message).toBe(`connect ECONNREFUSED 127.0.0.1:${port}`);
    expect(error.code).toBe('ECONNREFUSED');
  });

  it('server closes before the response headers', async () => {
    const server = await listen((req) => { req.socket.destroy(); });
    const [error, expected] = [await rejection(send({ method: 'GET', url: new URL(`${server.base}/`) })), await nodeFailure(`${server.base}/`)];
    expect([error.message, error.code]).toEqual([expected.message, expected.code]);
    expect([error.message, error.code]).toEqual(['socket hang up', 'ECONNRESET']);
  });

  it('server closes in the middle of the body', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('abc');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const response = await send({ method: 'GET', url: new URL(`${server.base}/`) });
    const error = await rejection(response.bytes());
    const expected = await nodeFailure(`${server.base}/`, true);
    expect([error.message, error.code]).toEqual([expected.message, expected.code]);
    expect([error.message, error.code]).toEqual(['aborted', 'ECONNRESET']);
  });

  it('a failing upload stream surfaces its own error', async () => {
    const server = await listen((_req, res) => reply(res, 201));
    const failure = Object.assign(new Error("ENOENT: no such file or directory, open '/missing'"), { code: 'ENOENT' });
    const error = await rejection(send({
      method: 'PUT', url: new URL(`${server.base}/f`), bodyLength: 5,
      bodyFactory: () => new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } }),
    }));
    expect(error).toBe(failure);
  });

  it('unsupported scheme', async () => {
    const error = await rejection(send({ method: 'GET', url: new URL('ftp://example.com/x') }));
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(error.message).toBe('不支持的协议: ftp:');
  });
});

describe('http.ts cancellation and timeouts', () => {
  it('a cancelled sync rejects before sending, while waiting for headers and after headers arrived', async () => {
    let respond: (() => void) | null = null;
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': '4' });
      res.flushHeaders();
      respond = () => res.end('late');
    });
    const hung = await listen(() => undefined);

    const before = new AbortController();
    before.abort();
    const pre = await rejection(send({ method: 'GET', url: new URL(`${hung.base}/`), signal: before.signal }));
    expect([pre instanceof CloudStorageError, pre.message]).toEqual([true, '云同步已取消']);
    expect(hung.log).toHaveLength(0);

    const waiting = new AbortController();
    const pending = rejection(send({ method: 'GET', url: new URL(`${hung.base}/`), signal: waiting.signal }));
    await vi.waitFor(() => { expect(hung.log).toHaveLength(1); });
    waiting.abort();
    const during = await pending;
    expect([during instanceof CloudStorageError, during.message]).toEqual([true, '云同步已取消']);

    const after = new AbortController();
    const response = await send({ method: 'GET', url: new URL(`${server.base}/`), signal: after.signal });
    after.abort();
    respond!();
    await expect(response.text()).rejects.toThrow('云同步已取消');
  });

  it(`waits ${HEADER_TIMEOUT_MS / 1000} s for response headers`, async () => {
    const hung = await listen(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = rejection(send({ method: 'GET', url: new URL(`${hung.base}/`) }));
    await vi.waitFor(() => { expect(hung.log).toHaveLength(1); });
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect([error instanceof CloudStorageError, error.message]).toEqual([true, '等待响应头超时（120 秒）']);
  });

  it('totalTimeoutMs bounds the wait for headers', async () => {
    const hung = await listen(() => undefined);
    const error = await rejection(send({ method: 'PUT', url: new URL(`${hung.base}/`), body: new Uint8Array(1), totalTimeoutMs: 1000 }));
    expect([error instanceof CloudStorageError, error.message]).toEqual([true, '请求超时（1 秒）']);
  });

  it('a stalled body rejects with the generic or caller-supplied text', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('abc');
    });
    const generic = await send({ method: 'GET', url: new URL(`${server.base}/`) });
    const genericError = await rejection((async () => { for await (const chunk of generic.chunks(600)) void chunk; })());
    expect([genericError instanceof CloudStorageError, genericError.message]).toEqual([true, '读取响应体停滞超过 1 秒，连接可能已断开']);

    const custom = await send({ method: 'GET', url: new URL(`${server.base}/`) });
    const customError = await rejection((async () => { for await (const chunk of custom.chunks(300, 'WebDAV 下载停滞')) void chunk; })());
    expect(customError.message).toBe('WebDAV 下载停滞');
  });

  it('refuses to buffer more than maxBytes', async () => {
    const server = await listen((_req, res) => reply(res, 200, 'abcdef'));
    const response = await send({ method: 'GET', url: new URL(`${server.base}/`) });
    const error = await rejection(response.bytes(3));
    expect([error instanceof CloudStorageError, error.message]).toEqual([true, '响应体超过上限（3 字节），已中断']);
  });
});

describe('http.ts goes through ctx.http', () => {
  function recordingHttp(): { service: HttpService; calls: Array<{ url: string; init: HttpRequestInit }> } {
    const calls: Array<{ url: string; init: HttpRequestInit }> = [];
    const service = {
      async fetch(input: string | URL, init: HttpRequestInit = {}) {
        calls.push({ url: String(input), init });
        return new Response(null, { status: 404 });
      },
    } as unknown as HttpService;
    return { service, calls };
  }

  it('hands each hop to the service with manual redirects and no whole-request timeout', async () => {
    const { service, calls } = recordingHttp();
    setHttpLookup(() => service);
    const response = await send({ method: 'PROPFIND', url: new URL('https://dav.example.com/dav/'), headers: { depth: '1' }, body: new Uint8Array(3) });
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dav.example.com/dav/');
    expect(calls[0]!.init).toMatchObject({ method: 'PROPFIND', redirect: 'manual', timeoutMs: 2_147_483_647, headers: { depth: '1', 'content-length': '3' } });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the desktop service applies the Host proxy policy', async () => {
    const proxy = await listen((_req, res) => reply(res, 200, 'via-proxy'));
    const http = createDesktopHttp({ env: { HTTP_PROXY: proxy.base }, platformProxy: async () => null, logger: { info() {}, warn() {} } });
    try {
      setHttpLookup(() => http);
      const response = await send({ method: 'GET', url: new URL('http://dav.invalid/dav/file.txt') });
      expect(await response.text()).toBe('via-proxy');
      expect(proxy.log.map(r => `${r.method} ${r.url}`)).toEqual(['GET http://dav.invalid/dav/file.txt']);
    } finally {
      await http.close();
    }
  });

  it('the plugin wires ctx.http while installed and lets go on unload', async () => {
    const { service, calls } = recordingHttp();
    const sync = await createSyncHost();
    try {
      sync.host.ctx.provide('http', service);
      const provider = sync.host.ctx.get('syncProvider') as SyncProviderService;
      const storage = await provider.createStorage({
        provider: 'webdav',
        webdav: { endpoint: 'https://dav.example.com/dav/', username: 'student', password: 'secret' },
      });
      await storage.stat('notes.txt').catch(() => undefined);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]!.url.startsWith('https://dav.example.com/dav/')).toBe(true);
    } finally {
      await sync.dispose();
    }
    const direct = await listen((_req, res) => reply(res, 200, 'direct'));
    const seen = calls.length;
    expect(await (await send({ method: 'GET', url: new URL(`${direct.base}/`) })).text()).toBe('direct');
    expect(calls).toHaveLength(seen);
  });
});

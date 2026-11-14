/**
 * s3_http.ts against the NodeHttpHandler it replaces: same wire request, same
 * response fields for the SDK, same error name/message/code for the retry strategy.
 */

import './local-fs-fixture.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { HttpRequest } from '@smithy/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { HttpRequestInit, HttpService } from '../../../platform/http/api.ts';
import { setHttpLookup } from '../src/http.ts';
import { S3Storage } from '../src/s3.ts';
import { createS3RequestHandler } from '../src/s3_http.ts';
import { clearCancelToken, MIN_MULTIPART_SIZE, setCancelToken } from '../src/traits.ts';

interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

const servers: Server[] = [];
const legacy = new NodeHttpHandler({ connectionTimeout: 30_000, requestTimeout: 120_000 });
const handler = createS3RequestHandler({ connectionTimeoutMs: 30_000, requestTimeoutMs: 120_000 });
const legacyHandle = (request: HttpRequest, options?: { abortSignal?: AbortSignal }) =>
  legacy.handle(request as Parameters<typeof legacy.handle>[0], options);

afterAll(() => { legacy.destroy(); });

afterEach(async () => {
  clearCancelToken();
  setHttpLookup(null);
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
});

async function listen(respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      respond(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  return { port: (server.address() as AddressInfo).port, seen };
}

function s3Request(port: number, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    protocol: 'http:',
    hostname: '127.0.0.1',
    port,
    method: 'PUT',
    path: '/bucket/root/a%20b%2Bc.txt',
    query: { 'x-id': 'PutObject', uploads: null, list: ['b', 'a'], "o'k": "(v)*!" },
    headers: { host: `127.0.0.1:${port}`, 'content-length': '5', 'content-type': 'text/plain', 'x-amz-date': '20261107T000000Z' },
    body: Buffer.from('hello'),
    ...overrides,
  } as HttpRequest;
}

async function failure(run: Promise<unknown>): Promise<Error & { code?: string; cause?: unknown }> {
  try { await run; } catch (error) { return error as Error & { code?: string }; }
  throw new Error('expected a rejection');
}

async function drain(body: unknown): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

const transportHeaders = new Set(['connection', 'accept', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept-encoding', 'expect']);
function semanticHeaders(headers: Seen['headers']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !transportHeaders.has(name)));
}

describe('s3_http.ts matches NodeHttpHandler', () => {
  it('sends the same request line, signed headers and body', async () => {
    const server = await listen((_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); });
    await drain((await legacyHandle(s3Request(server.port))).response.body);
    await drain((await handler.handle(s3Request(server.port))).response.body);
    const [before, after] = server.seen;
    expect(after!.method).toBe(before!.method);
    expect(after!.url).toBe(before!.url);
    expect(after!.url).toBe("/bucket/root/a%20b%2Bc.txt?list=b&list=a&o%27k=%28v%29%2A%21&uploads&x-id=PutObject");
    expect(semanticHeaders(after!.headers)).toEqual(semanticHeaders(before!.headers));
    expect(after!.body).toBe('hello');
  });

  it('drops Expect: 100-continue and still sends the body', async () => {
    const server = await listen((_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); });
    const request = s3Request(server.port);
    request.headers.Expect = '100-continue';
    await drain((await handler.handle(request)).response.body);
    expect(server.seen[0]!.headers.expect).toBeUndefined();
    expect(server.seen[0]!.body).toBe('hello');
  });

  it('hands the SDK the same status, reason phrase, headers and body', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(404, 'No Such Key Here', { 'x-amz-request-id': 'r1', 'set-cookie': ['a=1', 'b=2'], 'content-length': '7' });
      res.end('missing');
    });
    const get = s3Request(server.port, { method: 'GET', body: undefined, headers: { host: `127.0.0.1:${server.port}` } });
    const before = (await legacyHandle(get)).response;
    const beforeBody = await drain(before.body);
    const after = (await handler.handle(get)).response;
    expect([after.statusCode, after.reason]).toEqual([before.statusCode, before.reason]);
    const { date: _a, connection: _b, 'keep-alive': _c, ...afterHeaders } = after.headers;
    const { date: _d, connection: _e, 'keep-alive': _f, ...beforeHeaders } = before.headers;
    expect(afterHeaders).toEqual(beforeHeaders);
    expect(await drain(after.body)).toBe(beforeBody);
  });

  it('connection refused: same message, code and name', async () => {
    const server = createServer();
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    const before = await failure(legacyHandle(s3Request(port)));
    const after = await failure(handler.handle(s3Request(port)));
    expect([after.name, after.message, after.code]).toEqual([before.name, before.message, before.code]);
  });

  it('peer closes before the headers: TimeoutError socket hang up, like NodeHttpHandler', async () => {
    const server = await listen((req) => { req.socket.destroy(); });
    const get = s3Request(server.port, { method: 'GET', body: undefined, headers: {} });
    const before = await failure(legacyHandle(get));
    const after = await failure(handler.handle(get));
    expect([after.name, after.message, after.code]).toEqual([before.name, before.message, before.code]);
    expect([after.name, after.message, after.code]).toEqual(['TimeoutError', 'socket hang up', 'ECONNRESET']);
  });

  it('peer closes in the middle of the body: same body error', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('abc');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const get = s3Request(server.port, { method: 'GET', body: undefined, headers: {} });
    const before = await failure(drain((await legacyHandle(get)).response.body));
    const after = await failure(drain((await handler.handle(get)).response.body));
    expect([after.message, after.code]).toEqual([before.message, before.code]);
  });

  it('connect timeout from ctx.http maps to the NodeHttpHandler TimeoutError text', async () => {
    setHttpLookup(() => ({
      fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); },
    }) as unknown as HttpService);
    const error = await failure(handler.handle(s3Request(9)));
    expect([error.name, error.message]).toEqual(['TimeoutError',
      '@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 30000 ms.']);
  });

  it('aborts with the same AbortError before sending and while waiting for headers', async () => {
    const hung = await listen(() => undefined);
    const reason = new Error('stop');
    const pre = new AbortController();
    pre.abort(reason);
    const before = await failure(legacyHandle(s3Request(hung.port), { abortSignal: pre.signal }));
    const after = await failure(handler.handle(s3Request(hung.port), { abortSignal: pre.signal }));
    expect([after.name, after.message, after.cause]).toEqual([before.name, before.message, before.cause]);
    expect([after.name, after.message, after.cause]).toEqual(['AbortError', 'Request aborted', reason]);

    const waiting = new AbortController();
    const pending = failure(handler.handle(s3Request(hung.port, { method: 'GET', body: undefined, headers: {} }), { abortSignal: waiting.signal }));
    while (hung.seen.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    waiting.abort('user');
    const during = await pending;
    expect([during.name, during.message]).toEqual(['AbortError', 'user']);
  });

  it('keeps cancellation connected after response headers while the body is stalled', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('abc');
    });
    const controller = new AbortController();
    const response = (await handler.handle(s3Request(server.port, { method: 'GET', body: undefined, headers: {} }), {
      abortSignal: controller.signal,
    })).response;
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        drain(response.body).then(() => 'completed', () => 'aborted'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('still downloading'), 500); }),
      ]);
      expect(outcome).toBe('aborted');
    } finally {
      clearTimeout(timer);
      (response.body as { destroy(): void }).destroy();
    }
  });
});

describe('s3.rs operation_attempt_timeout', () => {
  it('an attempt without response headers fails as the throwOnRequestTimeout TimeoutError', async () => {
    const hung = await listen(() => undefined);
    const strict = new NodeHttpHandler({ connectionTimeout: 30_000, requestTimeout: 200, throwOnRequestTimeout: true });
    try {
      const before = await failure(strict.handle(s3Request(hung.port) as Parameters<typeof strict.handle>[0]));
      const after = await failure(handler.handle(s3Request(hung.port), { requestTimeout: 200 }));
      expect([after.name, after.message, after.code]).toEqual([before.name, before.message, before.code]);
      expect([after.name, after.code]).toEqual(['TimeoutError', 'ETIMEDOUT']);
    } finally {
      strict.destroy();
    }
  });

  it('the standard retry treats it as transient and the next attempt succeeds', async () => {
    const server = await listen((_req, res) => {
      if (server.seen.length === 1) return;
      res.writeHead(200, { etag: '"e"', 'content-length': '0' });
      res.end();
    });
    const storage = new S3Storage({
      endpoint: `http://127.0.0.1:${server.port}`, bucket: 'bkt', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1', pathStyle: true,
    }, 'root', { clientConfig: { maxAttempts: 2, requestHandler: createS3RequestHandler({ connectionTimeoutMs: 30_000, requestTimeoutMs: 300 }) } });
    await storage.put('a.txt', Buffer.from('x'));
    expect(server.seen.map(r => `${r.method} ${r.url}`)).toEqual(['PUT /bkt/root/a.txt?x-id=PutObject', 'PUT /bkt/root/a.txt?x-id=PutObject']);
  });
});

describe('S3Storage goes through ctx.http', () => {
  it('cancels multipart retry backoff but still aborts the incomplete upload', async () => {
    const controller = new AbortController();
    setCancelToken(controller.signal);
    const calls: string[] = [];
    setHttpLookup(() => ({
      async fetch(input: string | URL, init: HttpRequestInit = {}) {
        calls.push(init.method ?? 'GET');
        const url = new URL(input);
        if (init.method === 'GET') return new Response('<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>');
        if (init.method === 'POST') return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
        if (init.method === 'DELETE') {
          expect(url.searchParams.get('uploadId')).toBe('upload-1');
          expect(init.signal?.aborted).toBe(false);
          return new Response(null, { status: 204 });
        }
        return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
      },
    }) as unknown as HttpService);
    const storage = new S3Storage({
      endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1', pathStyle: true,
    }, 'root', {
      clientConfig: { maxAttempts: 1 },
      logger: { info() {}, debug() {}, error() {}, warn(message) { if (message.includes('将重试同一分块')) controller.abort(); } },
    });
    const dir = await mkdtemp('/tmp/opencode/s3-cancel-');
    try {
      const path = join(dir, 'payload');
      await writeFile(path, new Uint8Array(MIN_MULTIPART_SIZE));
      await expect(storage.putFile('payload', path)).rejects.toThrow('云同步已取消');
      expect(calls).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['get', 'put'] as const)('does not send %s after the sync task was cancelled', async operation => {
    let calls = 0;
    setHttpLookup(() => ({
      async fetch() {
        calls += 1;
        return new Response(operation === 'get' ? 'data' : null, { status: 200 });
      },
    }) as unknown as HttpService);
    const controller = new AbortController();
    setCancelToken(controller.signal);
    controller.abort();
    const storage = new S3Storage({
      endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1', pathStyle: true,
    }, 'root', { clientConfig: { maxAttempts: 1 } });
    await expect(operation === 'get' ? storage.get('a.txt') : storage.put('a.txt', new Uint8Array([1])))
      .rejects.toThrow(/abort|取消/i);
    expect(calls).toBe(0);
  });

  it('PutObject reaches the Host service with manual redirects and no whole-request timeout', async () => {
    const calls: Array<{ url: string; init: HttpRequestInit; body: string }> = [];
    setHttpLookup(() => ({
      async fetch(input: string | URL, init: HttpRequestInit = {}) {
        const body = init.body instanceof Uint8Array ? Buffer.from(init.body).toString() : String(init.body ?? '');
        calls.push({ url: String(input), init, body });
        return new Response(null, { status: 200, headers: { etag: '"e"' } });
      },
    }) as unknown as HttpService);
    const storage = new S3Storage({
      endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1', pathStyle: true,
    }, 'root', { clientConfig: { maxAttempts: 1 } });
    await storage.put('a.txt', Buffer.from('x'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://s3.example.com/bkt/root/a.txt?x-id=PutObject');
    expect(calls[0]!.init).toMatchObject({ method: 'PUT', redirect: 'manual', timeoutMs: 2_147_483_647 });
    expect(new Headers(calls[0]!.init.headers as HeadersInit).get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(calls[0]!.body).toBe('x');
  });
});

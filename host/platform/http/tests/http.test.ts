/**
 * `ctx.http` 桌面实现：真实本地 HTTP 服务器上的 fetch 语义、代理路由（环境变量与系统代理都经
 * llm `http_proxy.ts` 的同一份逻辑）、`destination: 'public'` 的 SSRF 策略与逐跳重定向判定、`fetchBytes` 上限。
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, type HttpService } from '../api.ts';
import http, { createDesktopHttp } from '../index.ts';
import { createTestHost } from '../../../kernel/testing.ts';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }
interface Running { origin: string; seen: Seen[]; close(): Promise<void> }

const running: Running[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<Running> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const entry: Running = {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  running.push(entry);
  return entry;
}

function desktop(env: Record<string, string> = {}, systemProxy: string | null = null): HttpService {
  const client = createDesktopHttp({
    env,
    platformProxy: async () => (systemProxy === null ? null : { server: systemProxy, bypass: [] }),
  });
  clients.push(client);
  return client;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function expectHttpError(promise: Promise<unknown>, kind: HttpError['kind']): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as HttpError).kind).toBe(kind);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of running.splice(0)) await server.close();
});

describe('fetch semantics', () => {
  it('returns a standard Response and sends method, headers and body', async () => {
    const server = await serve((request, response, body) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ method: request.method, body, token: request.headers['x-token'] }));
    });
    const service = desktop();
    const response = await service.fetch(`${server.origin}/echo`, {
      method: 'POST', headers: { 'x-token': 't1' }, body: new TextEncoder().encode('payload'),
    });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'POST', body: 'payload', token: 't1' });
    const tupleHeaders = await service.fetch(new URL('/echo', server.origin), { method: 'PUT', headers: [['x-token', 't2']], body: 'text' });
    expect(await tupleHeaders.json()).toEqual({ method: 'PUT', body: 'text', token: 't2' });
  });

  it('follows redirects by default and honours redirect: "manual" / "error"', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' });
        response.end();
        return;
      }
      response.end(`at ${request.url}`);
    });
    const service = desktop();
    const followed = await service.fetch(`${server.origin}/start`);
    expect(await followed.text()).toBe('at /final');
    expect(followed.url).toBe(`${server.origin}/final`);
    const manual = await service.fetch(`${server.origin}/start`, { redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe('/final');
    await manual.body?.cancel();
    expect(await rejection(service.fetch(`${server.origin}/start`, { redirect: 'error' }))).toBeInstanceOf(TypeError);
  });

  it('times out with TimeoutError and aborts with AbortError, like global fetch', async () => {
    const server = await serve(() => undefined);
    const service = desktop();
    expect((await rejection(service.fetch(`${server.origin}/hang`, { timeoutMs: 150 })) as Error).name).toBe('TimeoutError');
    const controller = new AbortController();
    const pending = service.fetch(`${server.origin}/hang`, { signal: controller.signal });
    controller.abort();
    expect((await rejection(pending) as Error).name).toBe('AbortError');
  });

  it('timeoutMs: null sets no total timeout at any layer; the caller signal still aborts; other non-positive values are rejected', async () => {
    const server = await serve((request, response) => { if (request.url !== '/hang') response.end('ok'); });
    const service = desktop();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(await (await service.fetch(`${server.origin}/x`, { timeoutMs: null })).text()).toBe('ok');
      expect(timeout).not.toHaveBeenCalled();
      expect(await (await service.fetch(`${server.origin}/x`)).text()).toBe('ok');
      expect(timeout.mock.calls).toEqual([[300_000]]);
    } finally {
      timeout.mockRestore();
    }
    const controller = new AbortController();
    const pending = service.fetch(`${server.origin}/hang`, { timeoutMs: null, signal: controller.signal });
    controller.abort();
    expect((await rejection(pending) as Error).name).toBe('AbortError');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await rejection(service.fetch(`${server.origin}/x`, { timeoutMs: bad }))).toBeInstanceOf(RangeError);
    }
  });

  it('rejects unparseable and non-http(s) URLs with HttpError("InvalidUrl")', async () => {
    const service = desktop();
    await expectHttpError(service.fetch('not a url'), 'InvalidUrl');
    await expectHttpError(service.fetch('ftp://example.com/file'), 'InvalidUrl');
    await expectHttpError(service.fetch('file:///etc/passwd'), 'InvalidUrl');
    await expectHttpError(service.fetchBytes('data:text/plain,hi'), 'InvalidUrl');
  });
});

describe('proxy routing reuses the llm http_proxy logic', () => {
  it('sends requests through HTTP_PROXY in absolute form and bypasses it for NO_PROXY hosts', async () => {
    const proxy = await serve((request, response) => response.end(`proxied ${request.url}`));
    const target = await serve((request, response) => response.end(`direct ${request.url}`));
    const viaProxy = desktop({ HTTP_PROXY: proxy.origin });
    expect(await (await viaProxy.fetch(`${target.origin}/a`)).text()).toBe(`proxied ${target.origin}/a`);
    expect(target.seen).toHaveLength(0);
    const bypassed = desktop({ HTTP_PROXY: proxy.origin, NO_PROXY: '127.0.0.1' });
    expect(await (await bypassed.fetch(`${target.origin}/b`)).text()).toBe('direct /b');
  });

  it('falls back to the platform (system) proxy only when no proxy variable is set', async () => {
    const proxy = await serve((request, response) => response.end(`system ${request.url}`));
    const target = await serve((_request, response) => response.end('direct'));
    expect(await (await desktop({}, proxy.origin).fetch(`${target.origin}/s`)).text()).toBe(`system ${target.origin}/s`);
    // 只设了 HTTPS_PROXY：环境里已有代理变量，系统代理不再参与；http 目标没有对应变量，直连（reqwest 语义）。
    expect(await (await desktop({ HTTPS_PROXY: 'http://127.0.0.1:9' }, proxy.origin).fetch(`${target.origin}/s`)).text()).toBe('direct');
  });
});

describe('destination: "public"', () => {
  it('blocks private, link-local and metadata addresses before any connection', async () => {
    const service = desktop();
    for (const url of ['http://10.0.0.1/', 'http://192.168.1.10:8080/x', 'http://169.254.169.254/latest/meta-data', 'http://[fd00::1]/', 'http://100.64.0.1/']) {
      await expectHttpError(service.fetch(url, { destination: 'public' }), 'BlockedDestination');
    }
    expect(await service.isPublicUrl('http://10.0.0.1/')).toBe(false);
    expect(await service.isPublicUrl('http://127.0.0.1/')).toBe(true);
    expect(await service.isPublicUrl('ftp://8.8.8.8/')).toBe(false);
  });

  it('re-checks every redirect hop and stops before following a redirect into the private network', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/to-private') {
        response.writeHead(302, { location: 'http://192.168.0.1/admin' });
        response.end();
        return;
      }
      if (request.url === '/hop') {
        response.writeHead(301, { location: '/done' });
        response.end();
        return;
      }
      response.end(`public ${request.url}`);
    });
    const service = desktop();
    await expectHttpError(service.fetch(`${server.origin}/to-private`, { destination: 'public' }), 'BlockedDestination');
    expect(server.seen.map((entry) => entry.url)).toEqual(['/to-private']);
    const followed = await service.fetch(`${server.origin}/hop`, { destination: 'public' });
    expect(await followed.text()).toBe('public /done');
    expect(followed.url).toBe(`${server.origin}/done`);
    const manual = await service.fetch(`${server.origin}/to-private`, { destination: 'public', redirect: 'manual' });
    expect(manual.status).toBe(302);
    await manual.body?.cancel();
  });

  it('refuses to replay non-GET requests across redirects and caps the chain at 10 hops', async () => {
    const server = await serve((request, response) => {
      const step = Number(/\/loop\/(\d+)/.exec(request.url ?? '')?.[1] ?? 0);
      response.writeHead(307, { location: `/loop/${step + 1}` });
      response.end();
    });
    const service = desktop();
    await expectHttpError(service.fetch(`${server.origin}/loop/0`, { destination: 'public', method: 'POST', body: 'x' }), 'RedirectBlocked');
    expect(server.seen).toHaveLength(1);
    await expectHttpError(service.fetch(`${server.origin}/loop/0`, { destination: 'public' }), 'RedirectBlocked');
    expect(server.seen).toHaveLength(1 + 10);
  });

  it('drops credentials when a redirect crosses origins', async () => {
    const second = await serve((request, response) => response.end(JSON.stringify({ auth: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null })));
    const first = await serve((_request, response) => {
      response.writeHead(302, { location: `${second.origin}/landing` });
      response.end();
    });
    const service = desktop();
    const response = await service.fetch(`${first.origin}/go`, {
      destination: 'public', headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'x-keep': 'y' },
    });
    expect(await response.json()).toEqual({ auth: null, cookie: null });
    expect(first.seen[0]!.headers.authorization).toBe('Bearer secret');
    expect(second.seen[0]!.headers['x-keep']).toBe('y');
  });
});

describe('fetchBytes', () => {
  it('returns status, final URL, lower-cased headers and plain bytes', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/r') {
        response.writeHead(302, { location: '/img' });
        response.end();
        return;
      }
      response.writeHead(201, { 'Content-Type': 'image/png', 'X-Multi': 'a' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const result = await desktop().fetchBytes(`${server.origin}/r`);
    expect(result.status).toBe(201);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${server.origin}/img`);
    expect(result.headers['content-type']).toBe('image/png');
    expect(result.headers['x-multi']).toBe('a');
    expect(Object.getPrototypeOf(result.bytes)).toBe(Uint8Array.prototype);
    expect([...result.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('enforces maxBytes from Content-Length and while streaming chunked bodies', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/sized') {
        response.setHeader('content-length', '2048');
        response.end(Buffer.alloc(2048));
        return;
      }
      response.write(Buffer.alloc(1024));
      response.write(Buffer.alloc(1024));
      response.end(Buffer.alloc(1024));
    });
    const service = desktop();
    await expectHttpError(service.fetchBytes(`${server.origin}/sized`, { maxBytes: 2047 }), 'TooLarge');
    expect((await service.fetchBytes(`${server.origin}/sized`, { maxBytes: 2048 })).bytes).toHaveLength(2048);
    await expectHttpError(service.fetchBytes(`${server.origin}/chunked`, { maxBytes: 1500 }), 'TooLarge');
    expect((await service.fetchBytes(`${server.origin}/chunked`)).bytes).toHaveLength(3072);
  });

  it('decodes a content-encoding sent despite accept-encoding: identity; content-length stays the encoded size and maxBytes caps the decoded body', async () => {
    const plain = Buffer.alloc(4096, 'x');
    const encoded = gzipSync(plain);
    expect(encoded.length).toBeLessThan(1024);
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(encoded.length) });
      response.end(encoded);
    });
    const service = desktop();
    for (const destination of ['any', 'public'] as const) {
      const response = await service.fetch(`${server.origin}/z`, { destination });
      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(response.headers.get('content-length')).toBe(String(encoded.length));
      expect(Buffer.from(await response.arrayBuffer()).equals(plain)).toBe(true);
    }
    const bytes = await service.fetchBytes(`${server.origin}/z`);
    expect([bytes.bytes.byteLength, bytes.headers['content-length']]).toEqual([plain.length, String(encoded.length)]);
    await expectHttpError(service.fetchBytes(`${server.origin}/z`, { maxBytes: 1024 }), 'TooLarge');
    expect(server.seen.map((seen) => seen.headers['accept-encoding'])).toEqual(Array.from({ length: 4 }, () => 'identity'));
  });
});

describe('dstu.platform.http plugin', () => {
  it('provides ctx.http with the network policy (no network access needed)', async () => {
    const host = await createTestHost({ plugins: [http] });
    try {
      expect(await host.ctx.http.isPublicUrl('http://169.254.169.254/')).toBe(false);
      await expectHttpError(host.ctx.http.fetch('http://169.254.169.254/latest', { destination: 'public' }), 'BlockedDestination');
      await expectHttpError(host.ctx.http.fetch('gopher://example.com/'), 'InvalidUrl');
      expect(await host.ctx.http.checkPublicPinned('http://127.0.0.1:9/', { allowLoopback: true })).toEqual({ address: '127.0.0.1' });
      await expectHttpError(host.ctx.http.checkPublicPinned('http://169.254.169.254/latest'), 'BlockedDestination');
      await expectHttpError(host.ctx.http.fetch('http://127.0.0.1:9/', { destination: 'public', allowLoopback: false }), 'BlockedDestination');
    } finally {
      await host.dispose();
    }
  });
});

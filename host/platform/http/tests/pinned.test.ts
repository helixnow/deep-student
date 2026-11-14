/**
 * `destination: 'public-pinned'`：真实本地 HTTP/HTTPS 服务器上验证地址校验、DNS rebinding、逐跳重新钉住、
 * 按主机名校验证书、代理不生效，以及没有钉住传输的平台返回 `UNSUPPORTED_ON_PLATFORM`。
 * 主机名都用 `.test`（系统 DNS 解析不了），请求能到达服务器就说明连接用的是钉住的地址而不是再次解析。
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../api.ts';
import { createDesktopHttp, createHttpService, type PinnedTransportOptions } from '../index.ts';

const CERT = readFileSync(new URL('./fixtures/pinned-test.cert.pem', import.meta.url), 'utf8');
const KEY = readFileSync(new URL('./fixtures/pinned-test.key.pem', import.meta.url), 'utf8');

interface Seen { url: string; headers: IncomingHttpHeaders; servername?: string }
interface Running { port: number; seen: Seen[] }

const servers: Server[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function listen(server: Server, seen: Seen[]): Promise<Running> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

function serve(handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => response.end('ok')): Promise<Running> {
  const seen: Seen[] = [];
  return listen(createHttpServer((request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers });
    handler(request, response);
  }), seen);
}

function serveTls(): Promise<Running> {
  const seen: Seen[] = [];
  return listen(createHttpsServer({ cert: CERT, key: KEY }, (request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers, servername: (request.socket as TLSSocket).servername || undefined });
    response.end('secure');
  }), seen);
}

/** 按主机名应答的假 DNS，记录每次查询。 */
function dns(answers: Record<string, string[] | (() => string[])>) {
  const calls: string[] = [];
  const resolve: NonNullable<PinnedTransportOptions['resolve']> = async (host) => {
    calls.push(host);
    const answer = answers[host];
    if (answer === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return (typeof answer === 'function' ? answer() : answer).map((address) => ({ address }));
  };
  return { calls, resolve };
}

function desktop(pinned: PinnedTransportOptions, env: Record<string, string> = {}, systemProxy: string | null = null) {
  const client = createDesktopHttp({ env, pinned, platformProxy: async () => (systemProxy === null ? null : { server: systemProxy, bypass: [] }) });
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

describe("ctx.http destination 'public-pinned'", () => {
  it('rejects private, link-local, metadata and (by default) loopback answers before connecting', async () => {
    const { calls, resolve } = dns({
      'private.test': ['10.0.0.5'],
      'mixed.test': ['93.184.216.34', '192.168.1.2'],
      'loop.test': ['127.0.0.1'],
      'empty.test': [],
    });
    const http = desktop({ resolve });
    const blocked = async (url: string) => (await rejection(http.fetch(url, { destination: 'public-pinned' }))) as HttpError;

    const priv = await blocked('http://private.test/');
    expect(priv).toBeInstanceOf(HttpError);
    expect([priv.kind, priv.reason, priv.address]).toEqual(['BlockedDestination', 'blocked-address', '10.0.0.5']);
    expect((await blocked('http://mixed.test/')).address).toBe('192.168.1.2');
    expect((await blocked('http://loop.test/')).address).toBe('127.0.0.1');
    expect((await blocked('http://empty.test/')).reason).toBe('no-address');
    expect((await blocked('http://nxdomain.test/')).reason).toBe('dns-failed');
    // IP 字面量不经过解析器。
    expect((await blocked('http://169.254.169.254/latest/meta-data')).address).toBe('169.254.169.254');
    expect((await blocked('http://[::1]/')).address).toBe('::1');
    expect(calls).toEqual(['private.test', 'mixed.test', 'loop.test', 'empty.test', 'nxdomain.test']);
  });

  it('connects to the validated address only: a later rebinding answer cannot redirect the connection', async () => {
    const target = await serve();
    let answer = '127.0.0.1';
    const { calls, resolve } = dns({ 'rebind.test': () => [answer] });
    const http = desktop({ resolve });

    const response = await http.fetch(`http://rebind.test:${target.port}/a`, { destination: 'public-pinned', allowLoopback: true });
    expect(await response.text()).toBe('ok');
    expect(target.seen.map((seen) => [seen.url, seen.headers.host])).toEqual([['/a', `rebind.test:${target.port}`]]);
    expect(calls).toEqual(['rebind.test']);

    // 每个请求重新解析并校验：rebinding 之后的答案在连接前就被拒绝。
    answer = '10.20.30.40';
    const error = (await rejection(http.fetch(`http://rebind.test:${target.port}/b`, { destination: 'public-pinned', allowLoopback: true }))) as HttpError;
    expect([error.kind, error.address]).toEqual(['BlockedDestination', '10.20.30.40']);
    expect(target.seen).toHaveLength(1);
  });

  it('timeoutMs: null sends without a total timeout; the default is 300 s', async () => {
    const target = await serve();
    const { resolve } = dns({ 'pin.test': ['127.0.0.1'] });
    const http = desktop({ resolve });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const url = `http://pin.test:${target.port}/`;
      expect(await (await http.fetch(url, { destination: 'public-pinned', allowLoopback: true, timeoutMs: null })).text()).toBe('ok');
      expect(timeout).not.toHaveBeenCalled();
      expect(await (await http.fetch(url, { destination: 'public-pinned', allowLoopback: true })).text()).toBe('ok');
      expect(timeout.mock.calls).toEqual([[300_000]]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('decodes a content-encoding sent despite accept-encoding: identity, like the proxy transport; content-length stays the encoded size', async () => {
    const plain = Buffer.alloc(4096, 'x');
    const encoded = gzipSync(plain);
    const target = await serve((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(encoded.length) });
      response.end(encoded);
    });
    const { resolve } = dns({ 'zip.test': ['127.0.0.1'] });
    const http = desktop({ resolve });
    const url = `http://zip.test:${target.port}/`;
    const response = await http.fetch(url, { destination: 'public-pinned', allowLoopback: true });
    expect([response.headers.get('content-encoding'), response.headers.get('content-length')]).toEqual(['gzip', String(encoded.length)]);
    expect(Buffer.from(await response.arrayBuffer()).equals(plain)).toBe(true);
    const error = (await rejection(http.fetchBytes(url, { destination: 'public-pinned', allowLoopback: true, maxBytes: 1024 }))) as HttpError;
    expect(error.kind).toBe('TooLarge');
    expect(target.seen.map((seen) => seen.headers['accept-encoding'])).toEqual(['identity', 'identity']);
  });

  it('re-resolves and re-pins every redirect hop when following; manual returns the redirect to the caller', async () => {
    const target = await serve((request, response) => {
      if (request.url === '/start') response.writeHead(302, { location: `http://second.test:${(response.socket!.address() as AddressInfo).port}/next` }).end();
      else if (request.url === '/evil') response.writeHead(302, { location: `http://evil.test:${(response.socket!.address() as AddressInfo).port}/next` }).end();
      else response.end(`landed ${request.headers.host}`);
    });
    const { calls, resolve } = dns({ 'first.test': ['127.0.0.1'], 'second.test': ['127.0.0.1'], 'evil.test': ['10.0.0.1'] });
    const http = desktop({ resolve });
    const init = { destination: 'public-pinned', allowLoopback: true } as const;

    const followed = await http.fetch(`http://first.test:${target.port}/start`, init);
    expect(await followed.text()).toBe(`landed second.test:${target.port}`);
    expect(calls).toEqual(['first.test', 'second.test']);

    const blocked = (await rejection(http.fetch(`http://first.test:${target.port}/evil`, init))) as HttpError;
    expect([blocked.kind, blocked.address]).toEqual(['BlockedDestination', '10.0.0.1']);

    const manual = await http.fetch(`http://first.test:${target.port}/start`, { ...init, redirect: 'manual' });
    expect(manual.status).toBe(302);
    await manual.body?.cancel();
    expect(await rejection(http.fetch(`http://first.test:${target.port}/start`, { ...init, redirect: 'error' }))).toBeInstanceOf(TypeError);

    const post = (await rejection(http.fetch(`http://first.test:${target.port}/start`, { ...init, method: 'POST', body: 'x' }))) as HttpError;
    expect(post.kind).toBe('RedirectBlocked');
  });

  it('verifies the TLS certificate and sends SNI for the host name, not the pinned IP', async () => {
    const target = await serveTls();
    const { resolve } = dns({ 'pinned.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
    const http = desktop({ resolve, ca: CERT });
    const init = { destination: 'public-pinned', allowLoopback: true } as const;

    const response = await http.fetch(`https://pinned.test:${target.port}/s`, init);
    expect(await response.text()).toBe('secure');
    expect(target.seen).toEqual([{ url: '/s', headers: expect.objectContaining({ host: `pinned.test:${target.port}` }), servername: 'pinned.test' }]);

    // 同一地址、同一证书，但主机名不在证书里：按主机名校验，所以失败。
    const mismatch = (await rejection(http.fetch(`https://other.test:${target.port}/s`, init))) as TypeError & { cause?: { code?: string } };
    expect(mismatch).toBeInstanceOf(TypeError);
    expect(mismatch.cause?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    // 不信任该证书时同样失败（使用系统根证书）。
    const untrusted = (await rejection(desktop({ resolve }).fetch(`https://pinned.test:${target.port}/s`, init))) as TypeError & { cause?: { code?: string } };
    expect(untrusted.cause?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(target.seen).toHaveLength(1);
  });

  it('ignores proxy environment variables and the system proxy', async () => {
    const target = await serve();
    const proxy = await serve((_request, response) => response.end('via proxy'));
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const { resolve } = dns({ 'direct.test': ['127.0.0.1'] });
    const env = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl };
    const http = desktop({ resolve }, env, proxyUrl);

    // 对照：同一个客户端的 `any` 请求确实走了代理。
    expect(await (await http.fetch(`http://127.0.0.1:${target.port}/control`)).text()).toBe('via proxy');
    expect(proxy.seen).toHaveLength(1);

    const pinned = await http.fetch(`http://direct.test:${target.port}/p`, { destination: 'public-pinned', allowLoopback: true });
    expect(await pinned.text()).toBe('ok');
    expect(target.seen.map((seen) => seen.url)).toEqual(['/p']);
    expect(proxy.seen).toHaveLength(1);
  });

  it('rejects with a structured UNSUPPORTED_ON_PLATFORM error where no pinned transport exists', async () => {
    const service = createHttpService({ transport: async () => new Response('never'), platform: 'mobile' });
    const error = (await rejection(service.fetch('https://example.com/', { destination: 'public-pinned' }))) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toBeInstanceOf(TypeError);
    expect([error.kind, error.capability, error.platform]).toEqual(['UnsupportedOnPlatform', 'http.destination.publicPinned', 'mobile']);
    expect(error.message.startsWith('UNSUPPORTED_ON_PLATFORM: http.destination.publicPinned is not available on mobile')).toBe(true);
    expect(await rejection(service.fetchBytes('https://example.com/', { destination: 'public-pinned' }))).toMatchObject({ kind: 'UnsupportedOnPlatform' });
  });
});

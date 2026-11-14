/**
 * `ctx.http.checkPublicPinned`（只解析、校验，不连接）与 `destination: 'public'` + `allowLoopback: false`
 * （拒绝回环字面量、`localhost` 名和解析到回环的主机名）。主机名用 `.test` 和注入的解析器，系统 DNS 不参与。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../api.ts';
import { createDesktopHttp, createHttpService, type HttpTransport, type PinnedTransport, type ResolveHost } from '../index.ts';

const servers: Server[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function serve(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? '');
    response.end('ok');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

function dns(answers: Record<string, string[]>): { calls: string[]; resolve: ResolveHost } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (host) => {
      calls.push(host);
      const answer = answers[host];
      if (answer === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return answer.map((address) => ({ address }));
    },
  };
}

/** 记录请求的假传输；`/hop` 302 到 `location` 查询参数。 */
function recordingTransport(): { urls: string[]; transport: HttpTransport } {
  const urls: string[] = [];
  return {
    urls,
    transport: async (url) => {
      urls.push(url);
      const target = new URL(url).searchParams.get('location');
      return target === null ? new Response('ok') : new Response(null, { status: 302, headers: { location: target } });
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error('expected the promise to reject');
}

const neverPinned: PinnedTransport = async () => {
  throw new Error('checkPublicPinned must not connect');
};

describe('ctx.http.checkPublicPinned', () => {
  it('resolves and validates like public-pinned, returns the address it would pin, and never connects', async () => {
    const { calls, resolve } = dns({
      'site.test': ['93.184.216.34', '93.184.216.35'],
      'loop.test': ['127.0.0.1'],
      'private.test': ['10.0.0.5'],
      'mixed.test': ['93.184.216.34', '192.168.1.2'],
      'empty.test': [],
    });
    const http = createHttpService({ transport: async () => new Response('never'), pinnedTransport: neverPinned, resolveHost: resolve });

    expect(await http.checkPublicPinned('https://site.test/a')).toEqual({ address: '93.184.216.34' });
    expect(await http.checkPublicPinned(new URL('http://loop.test:8080/'), { allowLoopback: true })).toEqual({ address: '127.0.0.1' });
    const loop = await rejection(http.checkPublicPinned('http://loop.test/'));
    expect([loop.kind, loop.reason, loop.address]).toEqual(['BlockedDestination', 'blocked-address', '127.0.0.1']);
    // allowLoopback 只放行回环。
    expect((await rejection(http.checkPublicPinned('http://private.test/', { allowLoopback: true }))).address).toBe('10.0.0.5');
    expect((await rejection(http.checkPublicPinned('http://mixed.test/'))).address).toBe('192.168.1.2');
    expect((await rejection(http.checkPublicPinned('http://empty.test/'))).reason).toBe('no-address');
    const nx = await rejection(http.checkPublicPinned('http://nxdomain.test/'));
    expect([nx.kind, nx.reason, nx.message]).toEqual(['BlockedDestination', 'dns-failed', "DNS resolution failed for 'nxdomain.test': getaddrinfo ENOTFOUND nxdomain.test"]);
    // IP 字面量不经过解析器。
    expect(await http.checkPublicPinned('http://[2606:4700::1111]/')).toEqual({ address: '2606:4700::1111' });
    expect((await rejection(http.checkPublicPinned('http://169.254.169.254/latest'))).address).toBe('169.254.169.254');
    expect(calls).toEqual(['site.test', 'loop.test', 'loop.test', 'private.test', 'mixed.test', 'empty.test', 'nxdomain.test']);

    expect((await rejection(http.checkPublicPinned('ftp://site.test/'))).kind).toBe('InvalidUrl');
    expect((await rejection(http.checkPublicPinned('not a url'))).kind).toBe('InvalidUrl');
  });

  it('throws exactly what the public-pinned fetch would throw for the same target', async () => {
    const { resolve } = dns({ 'loop.test': ['127.0.0.1'], 'private.test': ['10.0.0.5'], 'empty.test': [] });
    const http = createDesktopHttp({ env: {}, platformProxy: async () => null, pinned: { resolve } });
    clients.push(http);
    for (const url of ['http://loop.test/', 'http://private.test/', 'http://empty.test/', 'http://nxdomain.test/', 'http://[fd00::1]/']) {
      const checked = await rejection(http.checkPublicPinned(url));
      const fetched = await rejection(http.fetch(url, { destination: 'public-pinned' }));
      expect(checked).toBeInstanceOf(HttpError);
      expect([checked.kind, checked.reason, checked.address, checked.message], url).toEqual([fetched.kind, fetched.reason, fetched.address, fetched.message]);
    }
  });

  it('checks a reachable local server on the desktop service without sending it a request', async () => {
    const target = await serve();
    const { calls, resolve } = dns({ 'local.test': ['127.0.0.1'] });
    const http = createDesktopHttp({ env: {}, platformProxy: async () => null, pinned: { resolve } });
    clients.push(http);
    const url = `http://local.test:${target.port}/probe`;

    expect(await http.checkPublicPinned(url, { allowLoopback: true })).toEqual({ address: '127.0.0.1' });
    expect(target.seen).toEqual([]);
    // 之后的 fetch 重新解析并校验，然后才连接。
    expect(await (await http.fetch(url, { destination: 'public-pinned', allowLoopback: true })).text()).toBe('ok');
    expect(target.seen).toEqual(['/probe']);
    expect(calls).toEqual(['local.test', 'local.test']);
  });

  it('is UNSUPPORTED_ON_PLATFORM where there is no pinned transport or no resolver', async () => {
    const transport = async () => new Response('never');
    for (const service of [
      createHttpService({ transport, platform: 'mobile' }),
      createHttpService({ transport, pinnedTransport: neverPinned, platform: 'mobile' }),
      createHttpService({ transport, resolveHost: dns({}).resolve, platform: 'mobile' }),
    ]) {
      const error = await rejection(service.checkPublicPinned('https://example.com/'));
      expect(error).toBeInstanceOf(HttpError);
      expect([error.kind, error.capability, error.platform]).toEqual(['UnsupportedOnPlatform', 'http.destination.publicPinned', 'mobile']);
      expect(error.message.startsWith('UNSUPPORTED_ON_PLATFORM: http.destination.publicPinned is not available on mobile')).toBe(true);
    }
  });
});

describe("destination 'public' with allowLoopback: false", () => {
  it('rejects loopback literals, localhost and names resolving to loopback before connecting; the default keeps the Rust loopback exemption', async () => {
    const { calls, resolve } = dns({ 'loop.test': ['127.0.0.1'], 'dual.test': ['93.184.216.34', '::1'], 'site.test': ['93.184.216.34'], localhost: ['127.0.0.1', '::1'] });
    const { urls, transport } = recordingTransport();
    const http = createHttpService({ transport, isPublicUrl: async () => true, resolveHost: resolve });
    const strict = { destination: 'public', allowLoopback: false } as const;

    for (const [url, address] of [
      ['http://loop.test/a', '127.0.0.1'],
      ['http://dual.test/a', '::1'],
      ['http://localhost:3000/a', '127.0.0.1'],
      ['http://127.0.0.1/a', '127.0.0.1'],
      ['http://[::ffff:127.0.0.1]/a', '::ffff:7f00:1'],
    ] as const) {
      const error = await rejection(http.fetch(url, strict));
      expect([error.kind, error.reason, error.address], url).toEqual(['BlockedDestination', 'blocked-address', address]);
    }
    expect(urls).toEqual([]);

    expect(await (await http.fetch('http://site.test/ok', strict)).text()).toBe('ok');
    // 缺省与显式 true：回环放行（Rust `is_safe_remote_url`），不做额外解析。
    await http.fetch('http://loop.test/default', { destination: 'public' });
    await http.fetch('http://loop.test/allowed', { destination: 'public', allowLoopback: true });
    expect(urls).toEqual(['http://site.test/ok', 'http://loop.test/default', 'http://loop.test/allowed']);
    expect(calls).toEqual(['loop.test', 'dual.test', 'localhost', 'site.test']);

    // net-policy 的判定仍先执行，错误文案不变。
    const blocked = createHttpService({ transport, isPublicUrl: async () => false, resolveHost: resolve });
    const error = await rejection(blocked.fetch('http://site.test/', strict));
    expect([error.kind, error.reason, error.message]).toEqual(['BlockedDestination', undefined, 'destination is not a public address (private, link-local, metadata or unresolvable)']);
    // `any` 不受影响。
    await http.fetch('http://loop.test/any', { allowLoopback: false });
    expect(urls.at(-1)).toBe('http://loop.test/any');
  });

  it('re-checks every followed redirect hop; manual hands the redirect back unchecked', async () => {
    const { resolve } = dns({ 'site.test': ['93.184.216.34'], 'next.test': ['93.184.216.35'], 'loop.test': ['127.0.0.1'] });
    const { urls, transport } = recordingTransport();
    const http = createHttpService({ transport, isPublicUrl: async () => true, resolveHost: resolve });
    const strict = { destination: 'public', allowLoopback: false } as const;
    const hop = (to: string) => `http://site.test/hop?location=${encodeURIComponent(to)}`;

    expect(await (await http.fetch(hop('http://next.test/landed'), strict)).text()).toBe('ok');
    const error = await rejection(http.fetch(hop('http://loop.test/admin'), strict));
    expect([error.kind, error.address, error.url]).toEqual(['BlockedDestination', '127.0.0.1', 'http://loop.test/admin']);
    expect(urls).toEqual([hop('http://next.test/landed'), 'http://next.test/landed', hop('http://loop.test/admin')]);

    const manual = await http.fetch(hop('http://loop.test/admin'), { ...strict, redirect: 'manual' });
    expect([manual.status, manual.headers.get('location')]).toEqual([302, 'http://loop.test/admin']);
  });

  it('without a resolver judges IP literals and localhost names only (net.publicPolicy is partial there)', async () => {
    const { urls, transport } = recordingTransport();
    const http = createHttpService({ transport, isPublicUrl: async () => true, platform: 'mobile' });
    const strict = { destination: 'public', allowLoopback: false } as const;
    for (const url of ['http://localhost/', 'http://app.localhost./', 'http://127.0.0.2/', 'http://[::1]/']) {
      const error = await rejection(http.fetch(url, strict));
      expect([error.kind, error.reason], url).toEqual(['BlockedDestination', 'blocked-address']);
    }
    await http.fetch('http://name.test/', strict);
    expect(urls).toEqual(['http://name.test/']);
  });

  it('desktop service end to end: a real loopback server is reachable by default and refused with allowLoopback: false', async () => {
    const target = await serve();
    const { resolve } = dns({ localhost: ['127.0.0.1'] });
    const http = createDesktopHttp({ env: {}, platformProxy: async () => null, pinned: { resolve } });
    clients.push(http);
    const literal = `http://127.0.0.1:${target.port}/literal`;

    expect(await (await http.fetch(literal, { destination: 'public' })).text()).toBe('ok');
    const error = await rejection(http.fetch(literal, { destination: 'public', allowLoopback: false }));
    expect([error.kind, error.address]).toEqual(['BlockedDestination', '127.0.0.1']);
    const named = await rejection(http.fetchBytes(`http://localhost:${target.port}/named`, { destination: 'public', allowLoopback: false }));
    expect([named.kind, named.address]).toEqual(['BlockedDestination', '127.0.0.1']);
    expect(target.seen).toEqual(['/literal']);
  });
});

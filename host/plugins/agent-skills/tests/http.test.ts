import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHttpService, createPinnedTransport, pickPinnedAddress, type HttpService, type PinnedTransport,
} from '../../../platform/http/index.ts';
import { downloadHttpsBytes, skillDownloadHttp } from '../src/http.ts';
import { pinnedHttp, type Resolve } from './web-fetch-transport.ts';

function response(status: number, body: BodyInit | null = null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const PUBLIC_DNS = { address: '93.184.216.34' };
const BLOCKED_DNS = { address: '192.168.1.5' };

/**
 * `ctx.http` with the real policy layer and address check; the pinned connection is answered by `respond`
 * (URL → Response) and records the address each hop was pinned to.
 */
function pinned(respond: (input: string) => Response | Promise<Response>, resolve: Resolve = async () => [PUBLIC_DNS], addresses: string[] = []): HttpService {
  return pinnedHttp(resolve, async ({ url, address }) => {
    addresses.push(address);
    return respond(url.toString());
  });
}

const refuseUnpinned = async (href: string): Promise<Response> => { throw new Error(`unexpected request without destination public-pinned: ${href}`); };

/** `ctx.http` on the real desktop pinned transport; these resolvers only return refused answers, so nothing connects. */
function refusing(resolve: Resolve): HttpService {
  return createHttpService({ transport: refuseUnpinned, pinnedTransport: createPinnedTransport({ resolve }) });
}

describe('fetch_executor.rs::download_https_bytes', () => {
  it('download_https_bytes_preserves_dns_resolution_failure_text', async () => {
    await expect(downloadHttpsBytes('https://missing.test/file.zip', 1024, refusing(async () => {
      throw new Error('getaddrinfo ENOTFOUND missing.test');
    }))).rejects.toThrow("DNS resolution failed for 'missing.test': getaddrinfo ENOTFOUND missing.test");
  });

  it('download_https_bytes_distinguishes_empty_dns_answer', async () => {
    await expect(downloadHttpsBytes('https://empty.test/file.zip', 1024, refusing(async () => [])))
      .rejects.toThrow("DNS resolution returned no addresses for 'empty.test'");
  });

  it('download_https_bytes_rejects_blocked_internal_ip', async () => {
    await expect(downloadHttpsBytes('https://internal.test/file.zip', 1024, refusing(async () => [BLOCKED_DNS])))
      .rejects.toThrow('Blocked: URL resolves to internal IP address');
  });

  it('download_https_bytes_wraps_transport_errors_with_original_url', async () => {
    const fetchImpl = async () => { throw new Error('socket hang up'); };
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl)))
      .rejects.toThrow("Failed to download URL 'https://cdn.test/file.zip': socket hang up");
  });

  it('download_https_bytes_uses_canonical_http_reason_not_status_text', async () => {
    const fetchImpl = async () => response(404, 'missing', { 'content-type': 'text/plain' });
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl)))
      .rejects.toThrow("Download failed with HTTP 404 Not Found for 'https://cdn.test/file.zip'");
  });

  it('download_https_bytes_reports_original_url_after_redirect', async () => {
    const fetchImpl = async (input: string) => input === 'https://cdn.test/file.zip'
      ? response(302, null, { location: 'https://mirror.test/absent.zip' })
      : response(410, 'gone');
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl)))
      .rejects.toThrow("Download failed with HTTP 410 Gone for 'https://cdn.test/file.zip'");
  });

  it('download_https_bytes_stops_redirect_to_blocked_target_with_http_error', async () => {
    const fetchImpl = async () => response(307, null, { location: 'https://intranet.test/file.zip' });
    const resolve = async (host: string) => host === 'intranet.test' ? [BLOCKED_DNS] : [PUBLIC_DNS];
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl, resolve)))
      .rejects.toThrow("Download failed with HTTP 307 Temporary Redirect for 'https://cdn.test/file.zip'");
  });

  it('download_https_bytes_follows_public_redirect_and_returns_body', async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string) => {
      seen.push(input);
      return input === 'https://cdn.test/file.zip'
        ? response(301, null, { location: '/final.zip' })
        : response(200, new Uint8Array([1, 2, 3]));
    };
    const bytes = await downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl));
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual(['https://cdn.test/file.zip', 'https://cdn.test/final.zip']);
  });

  it('download_https_bytes_rejects_non_https_scheme', async () => {
    await expect(downloadHttpsBytes('http://cdn.test/file.zip', 1024, pinned(async () => response(200, 'x'))))
      .rejects.toThrow('Only https:// URLs are supported for binary download, got: http');
  });

  it('download_https_bytes_rejects_content_length_over_limit', async () => {
    const fetchImpl = async () => response(200, new Uint8Array([1, 2, 3]), { 'content-length': '3' });
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 2, pinned(fetchImpl)))
      .rejects.toThrow('Download too large (3 bytes > 2 bytes)');
  });

  it('download_https_bytes_rejects_stream_over_limit', async () => {
    const fetchImpl = async () => response(200, new Uint8Array([1, 2, 3]));
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 2, pinned(fetchImpl)))
      .rejects.toThrow('Download exceeded size limit (3 bytes > 2 bytes)');
  });

  it('RF-W02-skill-download-dns-pinning: connects every hop only to the address that passed the SSRF check', async () => {
    const addresses: string[] = [];
    const fetchImpl = async (input: string) => input === 'https://cdn.test/file.zip'
      ? response(302, null, { location: 'https://mirror.test/final.zip' })
      : response(200, new Uint8Array([7]));
    const resolve = async (host: string) => host === 'mirror.test'
      ? [{ address: '93.184.216.35' }, { address: '93.184.216.36' }] : [PUBLIC_DNS];
    const bytes = await downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl, resolve, addresses));
    expect([...bytes]).toEqual([7]);
    expect(addresses).toEqual(['93.184.216.34', '93.184.216.35']);
  });
});

describe('download_https_bytes redirect policy (fetch_executor.rs:600-631)', () => {
  /** `https://cdn.test/0` redirects to `/1`, … `/{hops-1}` redirects to `/{hops}`, which answers 200. */
  function chain(hops: number, seen: string[]): (input: string) => Response {
    return input => {
      seen.push(input);
      const step = Number(new URL(input).pathname.slice(1));
      return step < hops ? response(302, null, { location: `/${step + 1}` }) : response(200, new Uint8Array([step]));
    };
  }

  it('follows 9 redirects: reqwest lists the current URL in previous(), and the policy stops at 10 of them', async () => {
    const seen: string[] = [];
    const bytes = await downloadHttpsBytes('https://cdn.test/0', 1024, pinned(chain(9, seen)));
    expect([...bytes]).toEqual([9]);
    expect(seen).toHaveLength(10);
  });

  it('the 10th redirect is not followed and becomes the HTTP error', async () => {
    const seen: string[] = [];
    await expect(downloadHttpsBytes('https://cdn.test/0', 1024, pinned(chain(10, seen))))
      .rejects.toThrow("Download failed with HTTP 302 Found for 'https://cdn.test/0'");
    expect(seen).toEqual(Array.from({ length: 10 }, (_, step) => `https://cdn.test/${step}`));
  });

  it('a 3xx that reqwest does not redirect on is the final response even with a Location', async () => {
    for (const status of [300, 304]) {
      const seen: string[] = [];
      const fetchImpl = (input: string) => { seen.push(input); return response(status, null, { location: '/elsewhere.zip' }); };
      await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl)))
        .rejects.toThrow(status === 300 ? 'Download failed with HTTP 300 Multiple Choices' : 'Download failed with HTTP 304 Not Modified');
      expect(seen).toEqual(['https://cdn.test/file.zip']);
    }
  });

  it('a redirect target that does not resolve, or uses another scheme, stops at the 3xx', async () => {
    const resolve = async (host: string) => {
      if (host === 'gone.test') throw new Error('getaddrinfo ENOTFOUND gone.test');
      return [PUBLIC_DNS];
    };
    for (const location of ['https://gone.test/file.zip', 'ftp://cdn.test/file.zip']) {
      const fetchImpl = async () => response(303, null, { location });
      await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl, resolve)))
        .rejects.toThrow("Download failed with HTTP 303 See Other for 'https://cdn.test/file.zip'");
    }
  });
});

describe('download_https_bytes on ctx.http', () => {
  it('reports the socket error behind fetch failures, and body read failures as Rust does', async () => {
    const refused = async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 93.184.216.34:443') }); };
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(refused)))
      .rejects.toThrow("Failed to download URL 'https://cdn.test/file.zip': connect ECONNREFUSED 93.184.216.34:443");

    const cut = () => response(200, new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
      },
    }));
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(cut)))
      .rejects.toThrow('Failed to read download body: other side closed');
  });

  it('the desktop ctx.http public-pinned transport refuses internal literals before connecting', async () => {
    const desktop = createHttpService({ transport: refuseUnpinned, pinnedTransport: createPinnedTransport(), platform: 'desktop' });
    await expect(downloadHttpsBytes('https://10.0.0.1/file.zip', 1024, desktop)).rejects.toThrow('Blocked: URL resolves to internal IP address');
    await expect(downloadHttpsBytes('https://[fd00::1]/file.zip', 1024, desktop)).rejects.toThrow('Blocked: URL resolves to internal IP address');
  });

  it('a host without ctx.http refuses skill downloads with UNSUPPORTED_ON_PLATFORM instead of opening its own transport', () => {
    expect(() => skillDownloadHttp(() => null))
      .toThrow(/^UNSUPPORTED_ON_PLATFORM: skill downloads need the ctx\.http service/);
  });

  it('a host without the pinned transport refuses with UNSUPPORTED_ON_PLATFORM instead of downloading unpinned', async () => {
    const mobile = createHttpService({ transport: refuseUnpinned, platform: 'mobile' });
    await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, mobile))
      .rejects.toThrow(/^UNSUPPORTED_ON_PLATFORM: http\.destination\.publicPinned is not available on mobile/);
  });
});

describe('download_https_bytes and this machine', () => {
  // Rust's is_blocked_internal_ip exempts loopback for any name (fetch_executor.rs:630,680), so skill_scan (Low, no
  // approval) could reach local HTTPS services through any name that resolves to 127.0.0.1.
  it('RF-S01-skill-download-resolved-loopback-blocked: a name that resolves to loopback is refused before any connection', async () => {
    for (const answers of [[{ address: '127.0.0.1' }], [PUBLIC_DNS, { address: '::1' }]]) {
      await expect(downloadHttpsBytes('https://127.0.0.1.nip.test/file.zip', 1024, refusing(async () => answers)))
        .rejects.toThrow('Blocked: URL resolves to internal IP address');
    }
  });

  it('RF-S01-skill-download-resolved-loopback-blocked: URLs that name this machine still reach it', async () => {
    for (const [url, address] of [
      ['https://localhost:8443/file.zip', '127.0.0.1'],
      ['https://127.0.0.1:8443/file.zip', '127.0.0.1'],
      ['https://127.1/file.zip', '127.0.0.1'],
      ['https://[::1]/file.zip', '::1'],
    ] as const) {
      const addresses: string[] = [];
      const bytes = await downloadHttpsBytes(url, 1024, pinned(async () => response(200, new Uint8Array([4])), async () => [{ address }], addresses));
      expect([...bytes]).toEqual([4]);
      expect(addresses).toEqual([address]);
    }
  });

  it('RF-S01-skill-download-resolved-loopback-blocked: a redirect from a public URL into loopback stops on the 3xx', async () => {
    const resolve = async (host: string) => host === 'rebind.test' || host === 'localhost' ? [{ address: '127.0.0.1' }] : [PUBLIC_DNS];
    for (const location of ['https://127.0.0.1:8443/file.zip', 'https://localhost/file.zip', 'https://rebind.test/file.zip']) {
      const seen: string[] = [];
      const fetchImpl = (input: string) => { seen.push(input); return response(302, null, { location }); };
      await expect(downloadHttpsBytes('https://cdn.test/file.zip', 1024, pinned(fetchImpl, resolve)))
        .rejects.toThrow("Download failed with HTTP 302 Found for 'https://cdn.test/file.zip'");
      expect(seen).toEqual(['https://cdn.test/file.zip']);
    }
  });
});

describe('download_https_bytes over the real pinned transport and a local HTTPS server', () => {
  const CERT = readFileSync(new URL('../../../platform/http/tests/fixtures/pinned-test.cert.pem', import.meta.url), 'utf8');
  const KEY = readFileSync(new URL('../../../platform/http/tests/fixtures/pinned-test.key.pem', import.meta.url), 'utf8');
  const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
  const seen: Array<{ path: string; headers: IncomingHttpHeaders; servername: string | undefined }> = [];
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer({ cert: CERT, key: KEY }, (request, res) => {
      seen.push({ path: request.url ?? '', headers: request.headers, servername: (request.socket as TLSSocket).servername || undefined });
      if (request.url === '/skill.zip') { res.setHeader('content-type', 'application/zip'); res.end(ZIP); return; }
      if (request.url === '/old.zip') { res.statusCode = 301; res.setHeader('location', '/skill.zip'); res.end(); return; }
      if (request.url === '/to-intranet') { res.statusCode = 302; res.setHeader('location', 'https://intranet.test/skill.zip'); res.end(); return; }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  /**
   * `pinned.test` resolves to a public address; once W14's check accepts it, the real pinned transport connects to the
   * local server in its place (TLS still verifies `pinned.test`). Other hosts go through the real transport with the
   * test resolver, which refuses them before connecting.
   */
  function localHttp(resolved: string[], checked: string[]): HttpService {
    const dns: Record<string, string[]> = { 'pinned.test': ['93.184.216.34'], 'intranet.test': ['10.0.0.5'] };
    const resolve: Resolve = async host => {
      resolved.push(host);
      const answers = dns[host];
      if (answers === undefined) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      return answers.map(address => ({ address }));
    };
    const toLocal = createPinnedTransport({ resolve: async () => [{ address: '127.0.0.1' }], ca: CERT });
    const real = createPinnedTransport({ resolve, ca: CERT });
    const routed: PinnedTransport = async (href, init) => {
      const host = new URL(href).hostname;
      if (host !== 'pinned.test') return real(href, init);
      checked.push(pickPinnedAddress(href, (await resolve(host)).map(answer => answer.address), init.allowLoopback));
      return toLocal(href, { ...init, allowLoopback: true });
    };
    return createHttpService({ transport: refuseUnpinned, pinnedTransport: routed });
  }

  it('downloads over TLS for the original host name with the Rust request headers, one resolution per hop', async () => {
    seen.length = 0;
    const resolved: string[] = [];
    const checked: string[] = [];
    const bytes = await downloadHttpsBytes(`https://pinned.test:${port}/old.zip`, 1024, localHttp(resolved, checked));
    expect([...bytes]).toEqual([...ZIP]);
    expect(seen.map(entry => [entry.path, entry.servername, entry.headers.host])).toEqual([
      ['/old.zip', 'pinned.test', `pinned.test:${port}`],
      ['/skill.zip', 'pinned.test', `pinned.test:${port}`],
    ]);
    expect(seen[0]!.headers['user-agent']).toBe('DeepStudent/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)');
    expect(seen[0]!.headers['accept-language']).toBe('zh-CN,zh;q=0.9,en;q=0.8');
    expect(resolved).toEqual(['pinned.test', 'pinned.test']);
    expect(checked).toEqual(['93.184.216.34', '93.184.216.34']);
  });

  it('a redirect into the intranet ends at the 3xx without connecting, and the size cap holds on the real stream', async () => {
    seen.length = 0;
    const resolved: string[] = [];
    await expect(downloadHttpsBytes(`https://pinned.test:${port}/to-intranet`, 1024, localHttp(resolved, [])))
      .rejects.toThrow(`Download failed with HTTP 302 Found for 'https://pinned.test:${port}/to-intranet'`);
    expect(resolved).toEqual(['pinned.test', 'intranet.test']);
    expect(seen.map(entry => entry.path)).toEqual(['/to-intranet']);

    await expect(downloadHttpsBytes(`https://pinned.test:${port}/skill.zip`, ZIP.length - 1, localHttp([], [])))
      .rejects.toThrow(`Download too large (${ZIP.length} bytes > ${ZIP.length - 1} bytes)`);
  });
});

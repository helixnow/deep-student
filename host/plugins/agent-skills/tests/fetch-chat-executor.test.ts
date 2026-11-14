import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { createDesktopHttp, createHttpService, createPinnedTransport, pickPinnedAddress, type HttpService, type PinnedTransport } from '../../../platform/http/index.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { FetchChatToolExecutor } from '../src/tools/fetch-chat-executor.ts';
import { DEEPSEEK_API_KEY_SETTING, DEEPSEEK_FETCH_ENABLED_SETTING, DEEPSEEK_FETCH_ENDPOINT } from '../src/tools/fetch-executor.ts';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
let server: Server, port: number, root: string;
const seenHosts: string[] = [];

const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
  '/page': (_q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end('<html><body><nav>menu</nav><article><h1>Title</h1><p>Hello world body.</p></article><script>x()</script></body></html>'); },
  '/json': (_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"b":1,"a":[true]}'); },
  '/long': (_q, r) => { r.setHeader('content-type', 'text/plain'); r.end('abcdefghij'); },
  '/missing': (_q, r) => { r.statusCode = 429; r.end('  rate limit exceeded, retry after 30s  '); },
  '/to-internal': (_q, r) => { r.statusCode = 302; r.setHeader('location', 'http://intranet.test/secret'); r.end(); },
  '/to-page': (_q, r) => { r.statusCode = 301; r.setHeader('location', `http://other.test:${port}/page`); r.end(); },
  '/doc.pdf': (_q, r) => { r.setHeader('content-type', 'application/pdf'); r.setHeader('content-disposition', 'attachment; filename="Report Final.pdf"'); r.end(PDF); },
  '/fake.pdf': (_q, r) => { r.setHeader('content-type', 'application/pdf'); r.end('not a pdf'); },
  '/mismatch': (_q, r) => { r.setHeader('content-type', 'image/png'); r.end(PDF); },
};
for (let left = 0; left <= 10; left++) {
  routes[`/hops/${left}`] = left === 0 ? routes['/page']!
    : (_q, r) => { r.statusCode = 302; r.setHeader('location', `/hops/${left - 1}`); r.end(); };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'w02-web-fetch-'));
  server = createServer((request, response) => {
    seenHosts.push(String(request.headers.host));
    const route = routes[new URL(request.url ?? '/', 'http://x').pathname];
    if (route === undefined) { response.statusCode = 404; response.end(); } else route(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });

/**
 * The test hosts resolve to a public address. After W14's address check accepts it, the real pinned transport connects
 * to the local server instead; every other host goes through the real transport with the test resolver, which refuses
 * it before connecting.
 */
const SITE_ADDRESS = '93.184.216.34';
const DNS: Record<string, string[]> = { 'site.test': [SITE_ADDRESS], 'other.test': [SITE_ADDRESS], 'intranet.test': ['10.0.0.5'],
  'mixed.test': ['93.184.216.34', '192.168.1.10'], 'empty.test': [] };
const ROUTED = new Set(['site.test', 'other.test']);
const resolve = async (host: string) => {
  const answers = DNS[host];
  if (answers === undefined) throw new Error('failed to lookup address information');
  return answers.map(address => ({ address }));
};
const toLocalServer = createPinnedTransport({ resolve: async () => [{ address: '127.0.0.1' }] });
const refusing = createPinnedTransport({ resolve });
const routed: PinnedTransport = async (href, init) => {
  const host = new URL(href).hostname;
  if (!ROUTED.has(host)) return refusing(href, init);
  if (pickPinnedAddress(href, DNS[host]!, init.allowLoopback) !== SITE_ADDRESS) throw new Error(`unexpected pinned address for ${href}`);
  return toLocalServer(href, { ...init, allowLoopback: true });
};
const unpinned: string[] = [];
const testHttp = createHttpService({
  transport: async href => { unpinned.push(href); throw new Error(`unexpected request without destination public-pinned: ${href}`); },
  pinnedTransport: routed,
  resolveHost: resolve,
});

function settingsWith(values: Record<string, string>, secrets: Record<string, string>): SettingsStore {
  return { get: (key: string) => values[key] ?? null, getSecret: async (key: string) => secrets[key] ?? null } as unknown as SettingsStore;
}

function harness(options: { settings?: SettingsStore | null; deepseek?: typeof fetch; cancel?: AbortController; http?: HttpService | null } = {}) {
  const logs: string[] = [], saved: ToolResultInfo[] = [], record: unknown[][] = [];
  const executor = new FetchChatToolExecutor({
    settings: () => options.settings ?? null, artifactRoot: sessionId => path.join(root, sessionId, 'artifact'),
    log: { debug: () => undefined, info: message => logs.push(message), warn: message => logs.push(message) },
    http: () => (options.http === undefined ? testHttp : options.http),
    files: () => createNodeFiles({ roots: [{ name: 'temp', path: root }] }),
    ...(options.deepseek === undefined ? {} : { deepseekFetch: options.deepseek }),
  });
  const ctx = {
    session_id: 'sess-1', block_id: 'blk', cancellation_token: options.cancel?.signal ?? null,
    isCancelled: () => options.cancel?.signal.aborted ?? false,
    emitToolCallStart: (...args: unknown[]) => record.push(['start', ...args]),
    emitToolCallEnd: (payload: unknown) => record.push(['end', payload]),
    emitToolCallError: (error: string) => record.push(['error', error]),
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
  } as unknown as ExecutionContext;
  const run = (args: unknown, name = 'builtin-web_fetch') => executor.execute({ id: 'call-1', name, arguments: args }, ctx);
  return { executor, run, logs, saved, record };
}
const url = (host: string, route: string) => `http://${host}:${port}${route}`;

describe('fetch_executor.rs FetchExecutor on the chat ExecutionContext', () => {
  it('Low / ReadOnly web_fetch only', () => {
    const { executor } = harness();
    expect([executor.name(), executor.canHandle('builtin-web_fetch'), executor.canHandle('web_search'),
      executor.sensitivityLevel('web_fetch'), executor.concurrencyClass('web_fetch')])
      .toEqual(['FetchExecutor', true, false, 'low', 'read_only']);
  });

  it('fetches over the validated address with the original Host, converting HTML to text', async () => {
    const h = harness();
    seenHosts.length = 0;
    const result = await h.run({ url: url('site.test', '/page') });
    expect(result.error).toBeUndefined();
    expect(seenHosts).toEqual([`site.test:${port}`]);
    const output = result.output as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(['success', 'url', 'finalUrl', 'redirected', 'finalDomain', 'content', 'contentType',
      'totalLength', 'startIndex', 'returnedLength', 'hasMore', 'nextStartIndex', 'durationMs']);
    expect(output).toMatchObject({ success: true, url: url('site.test', '/page'), finalUrl: url('site.test', '/page'), redirected: false,
      finalDomain: 'site.test', contentType: 'text/html; charset=utf-8', startIndex: 0, hasMore: false, nextStartIndex: null });
    expect(output.content).toContain('Hello world body.');
    expect(output.content).not.toContain('menu');
    expect(output.content).not.toContain('x()');
    expect(h.saved).toEqual([result]);
    expect(h.record.map(entry => entry[0])).toEqual(['start', 'end']);
  });

  it('paginates with the truncation notice and clamps max_length to at least 1', async () => {
    const h = harness();
    const page = (await h.run({ url: url('site.test', '/long'), max_length: 4, start_index: 2 })).output as Record<string, unknown>;
    expect(page).toMatchObject({ totalLength: 10, startIndex: 2, hasMore: true, nextStartIndex: 6,
      content: 'cdef\n\n<truncated>Content truncated. Call the fetch tool with start_index=6 to get more content. Remaining: 4 characters.</truncated>' });
    expect(((await h.run({ url: url('site.test', '/long'), max_length: 0 })).output as Record<string, unknown>).content)
      .toMatch(/^a\n\n<truncated>/);
  });

  it('pretty-prints JSON and keeps key order', async () => {
    const output = (await harness().run({ url: url('site.test', '/json') })).output as Record<string, unknown>;
    expect(output.content).toBe('{\n  "b": 1,\n  "a": [\n    true\n  ]\n}');
  });

  it('rejects bad input and internal targets before any request', async () => {
    const h = harness();
    seenHosts.length = 0;
    const errors = await Promise.all([
      h.run({}), h.run({ url: 'ftp://site.test/x' }), h.run({ url: 'http://intranet.test/x' }), h.run({ url: 'http://mixed.test/x' }),
      h.run({ url: 'http://nowhere.test/x' }), h.run({ url: 'http://empty.test/x' }), h.run({ url: 'not a url' }),
      h.run({ url: 'http://169.254.169.254/latest' }),
    ]).then(results => results.map(result => result.error));
    expect(errors).toEqual([
      "Missing 'url' parameter", 'Only HTTP and HTTPS URLs are supported, got: ftp',
      'Blocked: URL resolves to internal IP address', 'Blocked: URL resolves to internal IP address',
      "DNS resolution failed for 'nowhere.test': failed to lookup address information",
      "DNS resolution returned no addresses for 'empty.test'", expect.stringMatching(/^Invalid URL 'not a url': /),
      'Blocked: URL resolves to internal IP address',
    ]);
    expect(seenHosts).toEqual([]);
    expect((await h.run({ url: 'http://site.test' }, 'web_crawl')).error).toBe('Unknown fetch tool: web_crawl');
  });

  it('follows public redirects, and a redirect to an internal host stops on the 3xx', async () => {
    const h = harness();
    const followed = (await h.run({ url: url('site.test', '/to-page') })).output as Record<string, unknown>;
    expect(followed).toMatchObject({ finalUrl: url('other.test', '/page'), redirected: true, finalDomain: 'other.test' });
    expect((await h.run({ url: url('site.test', '/to-internal') })).error).toBe('HTTP request failed with status 302: Found');
  });

  it('follows at most 9 redirects: reqwest previous() already holds the original URL on the first hop', async () => {
    const h = harness();
    seenHosts.length = 0;
    const nine = (await h.run({ url: url('site.test', '/hops/9') })).output as Record<string, unknown>;
    expect(nine).toMatchObject({ finalUrl: url('site.test', '/hops/0'), redirected: true });
    expect(seenHosts).toHaveLength(10);
    seenHosts.length = 0;
    expect((await h.run({ url: url('site.test', '/hops/10') })).error).toBe('HTTP request failed with status 302: Found');
    expect(seenHosts).toHaveLength(10);
  });

  it('non-2xx responses carry the trimmed body excerpt', async () => {
    expect((await harness().run({ url: url('site.test', '/missing') })).error)
      .toBe('HTTP request failed with status 429: Too Many Requests\nResponse body (excerpt): rate limit exceeded, retry after 30s');
  });

  it('binary responses are materialized once into the session artifact root with a task-object handle', async () => {
    const h = harness();
    const first = (await h.run({ url: url('site.test', '/doc.pdf') })).output as Record<string, unknown>;
    expect(first).toMatchObject({ success: true, kind: 'external_file', content: null, contentType: 'application/pdf',
      originalName: 'Report_Final.pdf', rootId: 'artifacts', hasMore: false, nextStartIndex: null, sizeBytes: PDF.length });
    const relativePath = first.relativePath as string;
    expect(relativePath).toMatch(/^web-fetch\/Report_Final-[0-9a-f]{12}\.pdf$/);
    expect(first.locator).toBe(`runtime://artifacts/${relativePath}`);
    expect(readFileSync(path.join(root, 'sess-1', 'artifact', relativePath))).toEqual(PDF);
    expect(first.objectHandle).toMatchObject({ handleId: `web-fetch:${first.sha256 as string}`, kind: 'file',
      provenance: { source: 'url_download', sourceUri: url('site.test', '/doc.pdf'), server: 'site.test', tool: 'web_fetch',
        derivedFrom: [{ sourceHandleId: url('site.test', '/doc.pdf'), transformId: 'fetch.binary' }] },
      mediaType: 'application/pdf', locator: { rootId: 'artifacts', relativePath },
      providerRef: { provider: 'web', externalId: url('site.test', '/doc.pdf'), containerId: 'site.test' },
      capabilities: { readable: true, materializable: true, writable: false, shareable: false, sendable: true, deletable: true } });
    const second = (await h.run({ url: url('site.test', '/doc.pdf') })).output as Record<string, unknown>;
    expect(second.relativePath).toBe(relativePath);

    expect((await h.run({ url: url('site.test', '/fake.pdf') })).error)
      .toBe("Unsupported or invalid binary response: declared MIME 'application/pdf' did not match a supported file signature");
    expect((await h.run({ url: url('site.test', '/mismatch') })).error)
      .toBe("Binary MIME/magic mismatch: header 'image/png' does not match detected 'application/pdf'");
  });

  it('cancellation before start never resolves or requests', async () => {
    const cancel = new AbortController();
    cancel.abort();
    seenHosts.length = 0;
    expect((await harness({ cancel }).run({ url: url('site.test', '/page') })).error).toBe('Fetch cancelled before start');
    expect(seenHosts).toEqual([]);
  });

  it('DeepSeek Fetch is used only when enabled with a key, and any failure falls back to the local fetch', async () => {
    const calls: unknown[][] = [];
    const ok = (async (input: string, init?: RequestInit) => {
      calls.push([input, init?.method, (init?.headers as Record<string, string>).Authorization, init?.body]);
      return new Response(JSON.stringify({ title: 'T', content: '# Remote markdown' }), { status: 200 });
    }) as typeof fetch;
    const enabled = settingsWith({ [DEEPSEEK_FETCH_ENABLED_SETTING]: ' TRUE ' }, { [DEEPSEEK_API_KEY_SETTING]: ' sk-test ' });
    const remote = (await harness({ settings: enabled, deepseek: ok }).run({ url: url('site.test', '/page') })).output as Record<string, unknown>;
    expect(calls).toEqual([[DEEPSEEK_FETCH_ENDPOINT, 'POST', 'Bearer sk-test', JSON.stringify({ url: url('site.test', '/page') })]]);
    expect(remote).toMatchObject({ content: '# Remote markdown', contentType: 'text/markdown; deepseek-fetch', redirected: false });

    const disabled = settingsWith({ [DEEPSEEK_FETCH_ENABLED_SETTING]: 'yes' }, { [DEEPSEEK_API_KEY_SETTING]: 'sk-test' });
    await harness({ settings: disabled, deepseek: ok }).run({ url: url('site.test', '/page') });
    expect(calls).toHaveLength(1);

    const failing = (async () => new Response('denied', { status: 401 })) as typeof fetch;
    const h = harness({ settings: enabled, deepseek: failing });
    const local = (await h.run({ url: url('site.test', '/page') })).output as Record<string, unknown>;
    expect(local.contentType).toBe('text/html; charset=utf-8');
    expect(h.logs.some(line => line.startsWith(`[FetchExecutor] DeepSeek fetch failed for URL ${url('site.test', '/page')}:`)
      && line.endsWith('— falling back to local fetch'))).toBe(true);

    const cancel = new AbortController();
    const cancelling = (async () => { cancel.abort(); throw new Error('aborted'); }) as typeof fetch;
    seenHosts.length = 0;
    expect((await harness({ settings: enabled, deepseek: cancelling, cancel }).run({ url: url('site.test', '/page') })).error)
      .toBe('Fetch cancelled during DeepSeek fetch');
    expect(seenHosts).toEqual([]);
  });

  it('with DeepSeek enabled a refused target fails before DeepSeek is asked, and the check opens no connection (fetch_executor.rs:936-979)', async () => {
    const calls: string[] = [];
    const ok = (async (input: string) => {
      calls.push(input);
      return new Response(JSON.stringify({ content: '# Remote markdown' }), { status: 200 });
    }) as typeof fetch;
    const enabled = settingsWith({ [DEEPSEEK_FETCH_ENABLED_SETTING]: 'true' }, { [DEEPSEEK_API_KEY_SETTING]: 'sk-test' });
    const h = harness({ settings: enabled, deepseek: ok });
    seenHosts.length = 0;
    expect((await h.run({ url: 'http://intranet.test/x' })).error).toBe('Blocked: URL resolves to internal IP address');
    expect((await h.run({ url: 'http://nowhere.test/x' })).error).toBe("DNS resolution failed for 'nowhere.test': failed to lookup address information");
    expect((await h.run({ url: 'http://empty.test/x' })).error).toBe("DNS resolution returned no addresses for 'empty.test'");
    expect(calls).toEqual([]);
    expect((await h.run({ url: url('site.test', '/page') })).output).toMatchObject({ content: '# Remote markdown' });
    expect(calls).toHaveLength(1);
    expect(seenHosts).toEqual([]);
  });

  it('the pre-DeepSeek check is ctx.http.checkPublicPinned, so it holds for a transport that honours abort before resolving', async () => {
    const calls: unknown[] = [];
    const ok = (async (_input: string, init?: RequestInit) => {
      calls.push(init?.body);
      return new Response(JSON.stringify({ content: '# Remote markdown' }), { status: 200 });
    }) as typeof fetch;
    const abortFirst = createHttpService({
      transport: async href => { throw new Error(`unexpected request without destination public-pinned: ${href}`); },
      pinnedTransport: async (href, init) => { init.signal?.throwIfAborted(); return routed(href, init); },
      resolveHost: resolve,
    });
    const enabled = settingsWith({ [DEEPSEEK_FETCH_ENABLED_SETTING]: 'true' }, { [DEEPSEEK_API_KEY_SETTING]: 'sk-test' });
    const h = harness({ settings: enabled, deepseek: ok, http: abortFirst });
    expect((await h.run({ url: 'http://intranet.test/x' })).error).toBe('Blocked: URL resolves to internal IP address');
    expect((await h.run({ url: 'http://nowhere.test/x' })).error).toBe("DNS resolution failed for 'nowhere.test': failed to lookup address information");
    expect(calls).toEqual([]);
    expect((await h.run({ url: url('site.test', '/page') })).output).toMatchObject({ content: '# Remote markdown' });
    expect(calls).toEqual([JSON.stringify({ url: url('site.test', '/page') })]);
  });

  it('a pre-DeepSeek check that fails for any other reason also fails the call before DeepSeek is asked (fetch_executor.rs:934-938)', async () => {
    const calls: unknown[] = [];
    const ok = (async (input: string) => {
      calls.push(input);
      return new Response(JSON.stringify({ content: '# Remote markdown' }), { status: 200 });
    }) as typeof fetch;
    const crashing: HttpService = { ...testHttp, checkPublicPinned: async () => { throw new Error('resolver crashed'); } };
    const enabled = settingsWith({ [DEEPSEEK_FETCH_ENABLED_SETTING]: 'true' }, { [DEEPSEEK_API_KEY_SETTING]: 'sk-test' });
    seenHosts.length = 0;
    const result = await harness({ settings: enabled, deepseek: ok, http: crashing }).run({ url: url('site.test', '/page') });
    expect([result.success, result.error]).toEqual([false, "DNS resolution failed for 'site.test': resolver crashed"]);
    expect([calls, seenHosts]).toEqual([[], []]);
  });

  it('DeepSeek goes through ctx.http with the default destination (proxy environment, as Rust deepseek_client)', async () => {
    const requests: unknown[][] = [];
    const http = createHttpService({
      transport: async (href, init) => {
        requests.push([href, init.method, init.headers.get('authorization'), init.body]);
        return new Response(JSON.stringify({ content: '# Via ctx.http' }), { status: 200 });
      },
      pinnedTransport: routed,
      resolveHost: resolve,
    });
    const enabled = settingsWith({ [DEEPSEEK_FETCH_ENABLED_SETTING]: 'true' }, { [DEEPSEEK_API_KEY_SETTING]: 'sk-test' });
    const result = await harness({ settings: enabled, http }).run({ url: url('site.test', '/page') });
    expect(result.output).toMatchObject({ content: '# Via ctx.http', contentType: 'text/markdown; deepseek-fetch' });
    expect(requests).toEqual([[DEEPSEEK_FETCH_ENDPOINT, 'POST', 'Bearer sk-test', JSON.stringify({ url: url('site.test', '/page') })]]);
  });

  it('desktop ctx.http end to end: no proxy, Host keeps the port, and a name resolving to loopback never reaches the server', async () => {
    const http = createDesktopHttp({
      env: { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' },
      platformProxy: async () => null,
      pinned: { resolve: async () => [{ address: '127.0.0.1' }] },
    });
    try {
      seenHosts.length = 0;
      expect(await harness({ http }).run({ url: `http://localhost:${port}/long` })).toMatchObject({ success: true, output: { content: 'abcdefghij' } });
      expect(seenHosts).toEqual([`localhost:${port}`]);
      expect((await harness({ http }).run({ url: `http://rebind.test:${port}/long` })).error).toBe('Blocked: URL resolves to internal IP address');
      expect(seenHosts).toEqual([`localhost:${port}`]);
    } finally {
      await http.close();
    }
  });

  it('without a public-pinned transport (mobile) web_fetch reports the capability gap and never sends an unpinned request', async () => {
    unpinned.length = 0;
    const mobile = createHttpService({
      transport: async href => { unpinned.push(href); throw new Error('unpinned'); },
      platform: 'android',
    });
    expect((await harness({ http: mobile }).run({ url: url('site.test', '/page') })).error)
      .toMatch(/^UNSUPPORTED_ON_PLATFORM: http\.destination\.publicPinned is not available on android/);
    expect((await harness({ http: null }).run({ url: url('site.test', '/page') })).error)
      .toBe('UNSUPPORTED_ON_PLATFORM: web_fetch needs the ctx.http service, which this host does not provide');
    expect(unpinned).toEqual([]);
  });
});

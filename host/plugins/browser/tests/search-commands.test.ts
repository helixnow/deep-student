import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { CancellableWebSearchPort } from '../../mcp/api.ts';
import browser from '../index.ts';

const hosts: TestHost[] = [];
const APP = { version: '0.11.0' };
interface SetupOptions {
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
  debug?: boolean;
  acl?: CapabilityAcl;
}
async function setup(options: SetupOptions = {}) {
  const values = new Map(Object.entries(options.settings ?? {}));
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const writes: [string, string][] = [];
  const secretWrites: [string, string][] = [];
  const logs: { level: string; message: string }[] = [];
  const settings = {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); writes.push([key, value]); },
    delete: (key: string) => values.delete(key),
    listByPrefix: (prefix: string) => [...values.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00+00:00' })),
    deleteByPrefix: (prefix: string) => {
      let count = 0;
      for (const key of [...values.keys()]) if (key.startsWith(prefix)) { values.delete(key); count += 1; }
      return count;
    },
    getSecret: async (key: string) => secrets.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { secrets.set(key, value); secretWrites.push([key, value]); },
    deleteSecret: async (key: string) => secrets.delete(key),
  };
  const host = await createTestHost({
    ...(options.acl ? { acl: options.acl } : {}),
    plugins: [browser], provide: {
      settings, log: { logger: () => ({
        warn: (message: string) => { logs.push({ level: 'warn', message }); },
        info: (message: string) => { logs.push({ level: 'info', message }); },
      }) },
      storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
      featureFlags: {
        load: () => { throw new Error('feature flags are not read by search commands'); },
        save: () => undefined,
      },
    },
    app: { ...APP, debug: options.debug ?? true },
  });
  hosts.push(host);
  return { host, values, secrets, writes, secretWrites, settings, logs };
}
beforeEach(() => {
  for (const key of ['GOOGLE_API_KEY', 'GOOGLE_CSE_CX', 'SERPAPI_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY',
    'SEARXNG_ENDPOINT', 'SEARXNG_API_KEY', 'ZHIPU_API_KEY', 'BOCHA_API_KEY', 'DEEPSEEK_SEARCH_API_KEY']) {
    vi.stubEnv(key, '');
    delete process.env[key];
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const host of hosts.splice(0)) await host.dispose();
});

describe('src/cmd/web_search.rs settings commands', () => {
  it('returns the CN whitelist defaults and parses JSON/csv custom sites', async () => {
    const { host } = await setup();
    expect(await host.invoke('get_cn_whitelist_config')).toMatchObject({
      user_config: { enabled: false, use_default_list: true, custom_sites: [] },
    });
    const defaults = (await host.invoke('get_cn_whitelist_config') as { default_sites: string[] }).default_sites;
    expect(defaults).toContain('edu.cn');
    const json = await setup({ settings: {
      'web_search.cn_whitelist.enabled': 'true', 'web_search.cn_whitelist.use_default': 'false',
      'web_search.cn_whitelist.custom_sites': '["a.com","b.com"]',
    } });
    expect(await json.host.invoke('get_cn_whitelist_config')).toMatchObject({
      user_config: { enabled: true, use_default_list: false, custom_sites: ['a.com', 'b.com'] },
    });
    const csv = await setup({ settings: {
      'web_search.cn_whitelist.custom_sites': 'a.com, b.com ,,',
    } });
    expect(await csv.host.invoke('get_cn_whitelist_config')).toMatchObject({
      user_config: { custom_sites: ['a.com', 'b.com'] },
    });
  });

  it('returns default provider strategies and falls back on malformed stored JSON', async () => {
    const { host } = await setup({ settings: { 'web_search.provider_strategies': '{broken' } });
    const result = await host.invoke('get_provider_strategies_config') as {
      provider_strategies: { default: { timeout_ms: number }; deepseek: { rate_limit_per_minute: number } };
      config_keys: Record<string, string>;
    };
    expect(result.provider_strategies.default.timeout_ms).toBe(8000);
    expect(result.provider_strategies.deepseek.rate_limit_per_minute).toBe(60);
    expect(result.config_keys).toEqual({ provider_strategies: 'web_search.provider_strategies' });
  });

  it('saves provider strategies with serde-compatible field order and null placeholders', async () => {
    const { host, writes } = await setup();
    expect(await host.invoke('save_provider_strategies_config', { strategies: {
      default: {
        timeout_ms: 1000, max_retries: 3, cache_enabled: false,
        special_handling: { handle_429_retry_after: true, exponential_backoff_on_5xx: false },
      },
      bing_rss: null,
    } })).toBe(true);
    const stored = writes[0]![1];
    expect(stored.indexOf('"timeout_ms"')).toBeLessThan(stored.indexOf('"max_retries"'));
    expect(stored.indexOf('"initial_retry_delay_ms"')).toBeLessThan(stored.indexOf('"backoff_multiplier"'));
    const parsed = JSON.parse(stored);
    expect(parsed.default).toEqual({
      timeout_ms: 1000, max_retries: 3, initial_retry_delay_ms: null, max_retry_delay_ms: null,
      backoff_multiplier: null, max_concurrent_requests: null, rate_limit_per_minute: null,
      cache_enabled: false, cache_ttl_seconds: null, cache_max_entries: null,
      special_handling: { handle_429_retry_after: true, exponential_backoff_on_5xx: false },
    });
    expect(parsed.bing_rss).toBeNull();
    expect(parsed.google_cse).toBeNull();
  });

  it('logs Provider策略配置已保存 only after the settings write succeeds (web_search.rs:353-358)', async () => {
    const { host, logs } = await setup();
    await host.invoke('save_provider_strategies_config', { strategies: { default: {} } });
    expect(logs).toEqual([{ level: 'info', message: 'Provider策略配置已保存' }]);
  });
});

function rssResponse(): Response {
  return new Response(`<?xml version="1.0"?><rss><channel><item><title>Example</title><link>https://example.com/a</link><description>Body</description></item></channel></rss>`, { status: 200 });
}

describe('src/cmd/web_search.rs connectivity commands', () => {
  it('test_search_engine reports success for the keyless default engine', async () => {
    const { host } = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => rssResponse()));
    const result = await host.invoke('test_search_engine', { engine: 'bing_rss' }) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true, message: 'bing_rss搜索引擎连接正常', test_query: 'AI artificial intelligence',
    });
    expect(typeof result.response_time).toBe('number');
  });

  it('test_search_engine uses the registry timeout, cancels the search and releases its permit (tools/mod.rs:338-350)', async () => {
    const { host } = await setup({
      secrets: { 'web_search.api_key.tavily': 'test-key' },
      settings: { 'web_search.provider_strategies': JSON.stringify({ default: {}, tavily: {
        timeout_ms: 30000, max_retries: 1, cache_enabled: false,
        max_concurrent_requests: 1, rate_limit_per_minute: 0,
      } }) },
    });
    let requestSignal: AbortSignal | null = null;
    let entered!: () => void;
    const requestStarted = new Promise<void>(resolve => { entered = resolve; });
    const fetchMock = vi.fn((_url: string | URL, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ query: 'AI artificial intelligence', max_results: 5 });
      if (fetchMock.mock.calls.length > 1) return Promise.resolve(new Response('{"results":[]}', { status: 200 }));
      requestSignal = init.signal as AbortSignal;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = host.invoke('test_search_engine', { engine: 'tavily' }) as Promise<Record<string, unknown>>;
      await requestStarted;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestSignal).toMatchObject({ aborted: false });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result).toMatchObject({
        ok: false, message: 'tavily搜索引擎测试失败: tool timeout', error_details: 'tool timeout',
        test_query: 'AI artificial intelligence',
      });
      expect(requestSignal).toMatchObject({ aborted: true });
      expect(await host.invoke('test_search_engine', { engine: 'tavily' })).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_search_engine surfaces the provider error message', async () => {
    const { host } = await setup({ secrets: { 'web_search.api_key.deepseek': 'sk-test' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"no balance"}}', { status: 402 })));
    const result = await host.invoke('test_search_engine', { engine: 'deepseek' }) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.message).toBe('deepseek搜索引擎测试失败: provider error: deepseek http 402: 账户余额不足，搜索按成功请求计费: no balance');
    expect(result.error_details).toBe('provider error: deepseek http 402: 账户余额不足，搜索按成功请求计费: no balance');
  });

  it('test_web_search_connectivity searches once with the default engine and reports success with usage (web_search.rs:43-84)', async () => {
    expect(browser.meta.commands).toContain('test_web_search_connectivity');
    const fetchSpy = vi.fn(async (_url: string | URL) => rssResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const { host } = await setup();
    const result = await host.invoke('test_web_search_connectivity') as { success: boolean; usage: Record<string, unknown> };
    expect(result).toEqual({ success: true, usage: expect.objectContaining({ provider: 'bing_rss', elapsed_ms: expect.any(Number) }) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('connectivity+test');
    // A blank engine keeps the configured default (`if !eng.trim().is_empty()`).
    expect(await host.invoke('test_web_search_connectivity', { engine: ' \t' })).toMatchObject({ success: true });
    expect(await host.invoke('test_web_search_connectivity', { engine: null })).toMatchObject({ success: true });
  });

  it('test_web_search_connectivity overrides default_engine and returns the serialized ToolResult on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"no balance"}}', { status: 402 })));
    const { host } = await setup({ secrets: { 'web_search.api_key.deepseek': 'sk-test' } });
    const result = await host.invoke('test_web_search_connectivity', { engine: 'deepseek' }) as {
      success: boolean; detail: Record<string, unknown>;
    };
    expect(result.success).toBe(false);
    expect(result.detail).toMatchObject({
      name: 'web_search', ok: false,
      args: { query: 'connectivity test', top_k: 1, engine: null, force_engine: null },
      error_details: { message: expect.stringContaining('deepseek http 402') },
      usage: expect.objectContaining({ elapsed_ms: expect.any(Number) }),
    });
    expect(Object.keys(result)).toEqual(['success', 'detail']);
  });

  it('RF-W05-web-search-connectivity-unregistered: test_web_search_connectivity is registered and allowed by the production ACL (application-commands.toml)', async () => {
    const fetchSpy = vi.fn(async () => rssResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const acl = CapabilityAcl.fromDirectory('linux');
    const withAcl = await setup({ acl });
    expect(await withAcl.host.invoke('test_web_search_connectivity', { engine: null }))
      .toEqual({ success: true, usage: expect.objectContaining({ provider: 'bing_rss' }) });
    expect(acl.denial('test_web_search_connectivity', { window: 'main', webview: 'main' }, true)).toBeNull();
    const usable = await withAcl.host.invoke('test_all_search_engines') as { results: { bing_rss: { status: string } } };
    expect(usable.results.bing_rss.status).toBe('success');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('test_all_search_engines counts unconfigured engines and one bing success', async () => {
    const { host } = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => rssResponse()));
    const result = await host.invoke('test_all_search_engines') as {
      results: Record<string, { status: string; message?: string }>;
      summary: { total: number; configured: number; success: number; failed: number };
      timestamp: string;
    };
    expect(Object.keys(result.results)).toEqual([
      'bing_rss', 'google_cse', 'serpapi', 'tavily', 'brave', 'searxng', 'zhipu', 'bocha', 'deepseek',
    ]);
    expect(result.results.bing_rss!.status).toBe('success');
    expect(result.results.google_cse).toEqual({
      name: 'Google CSE', status: 'not_configured', message: '缺少API密钥或端点配置', elapsed_ms: 0,
    });
    expect(result.summary).toEqual({ total: 9, configured: 1, success: 1, failed: 0 });
    expect(result.timestamp).toMatch(/\+00:00$/);
  });
});

describe('src/cmd/network.rs network_probe', () => {
  it('accepts any HTTP response and reports camelCase fields', async () => {
    const { host } = await setup();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('HEAD');
      return new Response(null, { status: 503 });
    }));
    expect(await host.invoke('network_probe', { url: 'https://example.com', timeoutMs: 50 })).toMatchObject({
      ok: true, statusCode: 503, error: null,
    });
  });
  it('rejects non-http URLs and uses GET when requested', async () => {
    const { host } = await setup();
    await expect(host.invoke('network_probe', { url: 'ftp://example.com' })).rejects.toBe('仅支持 http/https URL: ftp://example.com');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await host.invoke('network_probe', { url: 'http://127.0.0.1:9', method: 'get' })).toMatchObject({
      ok: true, statusCode: 204,
    });
  });
  it('reports connection failures without throwing', async () => {
    const { host } = await setup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const result = await host.invoke('network_probe', { url: 'https://example.com' }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch failed');
  });
});

describe('src/cmd/network.rs network_probe over a real HTTP transport (reqwest 0.11 redirect/timeout)', () => {
  const servers: Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }
  const hopServer = (methods: string[], delayMs = 0) => serve((req, res) => {
    methods.push(req.method ?? '');
    const hop = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('hop') ?? '0');
    const left = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('left') ?? '0');
    setTimeout(() => {
      if (left > 0) { res.writeHead(302, { location: `/r?hop=${hop + 1}&left=${left - 1}` }); res.end(); return; }
      res.writeHead(204); res.end();
    }, delayMs);
  });

  it('WP-154: official browser IPC allows test_web_search_connectivity, rejects a malformed engine before IO, and test_search_engine reaches a real provider', async () => {
    const requests: URL[] = [];
    const base = await serve((req, res) => {
      requests.push(new URL(req.url ?? '/', 'http://localhost'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com/wp154', content: 'Body' }] }));
    });
    const acl = CapabilityAcl.fromDirectory('linux');
    const { host } = await setup({ acl, secrets: { 'web_search.searxng.endpoint': base } });
    // Argument decoding rejects a malformed engine before any provider IO.
    await expect(host.invoke('test_web_search_connectivity', { engine: 42 }))
      .rejects.toMatch(/engine/);
    expect(requests).toEqual([]);
    expect(await host.invoke('test_web_search_connectivity', { engine: 'searxng' })).toMatchObject({ success: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get('q')).toBe('connectivity test');
    const release = await setup({ acl, debug: false, secrets: { 'web_search.searxng.endpoint': base } });
    expect(await release.host.invoke('test_web_search_connectivity', { engine: 'searxng' })).toMatchObject({ success: true });
    requests.length = 0;
    expect(await host.invoke('test_search_engine', { engine: 'searxng' })).toMatchObject({
      ok: true, message: 'searxng搜索引擎连接正常', test_query: 'AI artificial intelligence',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe('/search');
    expect(requests[0]!.searchParams.get('q')).toBe('AI artificial intelligence');
    expect(requests[0]!.searchParams.get('format')).toBe('json');
  });

  it('follows 9 redirects and keeps HEAD across 302 (Policy::limited(10): previous.len() >= 10 errors)', async () => {
    const { host } = await setup();
    const methods: string[] = [];
    const base = await hopServer(methods);
    expect(await host.invoke('network_probe', { url: `${base}/r?hop=0&left=9` })).toMatchObject({ ok: true, statusCode: 204, error: null });
    expect(methods).toHaveLength(10);
    expect(methods.every(method => method === 'HEAD')).toBe(true);
  });

  it('the 10th redirect fails with reqwest\'s redirect error for the URL that returned it', async () => {
    const { host } = await setup();
    const methods: string[] = [];
    const base = await hopServer(methods);
    const result = await host.invoke('network_probe', { url: `${base}/r?hop=0&left=10`, method: 'GET' }) as { ok: boolean; statusCode: number | null; error: string };
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toBe(`error following redirect for url (${base}/r?hop=9&left=1): too many redirects`);
    expect(methods).toHaveLength(10);
    expect(methods.every(method => method === 'GET')).toBe(true);
  });

  it('one timeout budget covers the whole redirect chain', async () => {
    const { host } = await setup();
    const methods: string[] = [];
    const base = await hopServer(methods, 60);
    const result = await host.invoke('network_probe', { url: `${base}/r?hop=0&left=5`, timeoutMs: 150 }) as { ok: boolean; error: string; rttMs: number };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(new RegExp(`^error sending request for url \\(${base.replace(/[.]/g, '\\.')}/r\\?hop=\\d&left=\\d\\): operation timed out$`));
    expect(methods.length).toBeLessThan(6);
    expect(result.rttMs).toBeLessThan(1000);
  });

  it('a 3xx without Location is returned as the response; a non-http Location is a builder error', async () => {
    const { host } = await setup();
    const bare = await serve((_req, res) => { res.writeHead(302); res.end(); });
    expect(await host.invoke('network_probe', { url: `${bare}/` })).toMatchObject({ ok: true, statusCode: 302, error: null });
    const ftp = await serve((_req, res) => { res.writeHead(301, { location: 'ftp://example.com/file' }); res.end(); });
    expect(await host.invoke('network_probe', { url: `${ftp}/` })).toMatchObject({
      ok: false, statusCode: null, error: 'builder error for url (ftp://example.com/file): URL scheme is not allowed',
    });
  });
});

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('host/plugins/mcp/api.ts CancellableWebSearchPort', () => {
  it('apply_db_overrides rejects every invalid ProviderStrategies shape and warns (web_search.rs:1128-1136)', async () => {
    for (const raw of [
      'null', '[]', '{}', '{"default":null}', '{"default":{"timeout_ms":"1000"}}',
      '{"default":{"max_retries":-1}}', '{"default":{"cache_enabled":1}}',
      '{"default":{"special_handling":{"handle_429_retry_after":true}}}',
      '{"default":{},"deepseek":false}',
    ]) {
      const { host, settings, logs } = await setup({ settings: { 'web_search.provider_strategies': raw } });
      const port = host.ctx.get('webSearch') as CancellableWebSearchPort;
      const config = await port.loadConfig(settings as unknown as SettingsStore);
      expect(config.provider_strategies_overridden, raw).toBe(false);
      expect(config.provider_strategies?.default.timeout_ms, raw).toBe(8000);
      expect(config.provider_strategies?.bing_rss?.timeout_ms, raw).toBe(10000);
      expect(logs, raw).toEqual([{ level: 'warn', message: '解析 web_search.provider_strategies 失败，忽略该覆盖' }]);
    }
  });

  it('apply_db_overrides accepts serde Option omissions/null and ignores unknown fields (web_search.rs:379-438)', async () => {
    const { host, settings, logs } = await setup({ settings: {
      'web_search.provider_strategies': '{"default":{"timeout_ms":1250,"ignored":true},"deepseek":null,"extra":0}',
    } });
    const port = host.ctx.get('webSearch') as CancellableWebSearchPort;
    const config = await port.loadConfig(settings as unknown as SettingsStore);
    expect(config.provider_strategies_overridden).toBe(true);
    expect(config.provider_strategies?.default.timeout_ms).toBe(1250);
    expect(config.provider_strategies?.default.max_retries).toBeNull();
    expect(config.provider_strategies?.default.special_handling).toBeNull();
    expect(config.provider_strategies?.bing_rss).toBeNull();
    expect(config.provider_strategies?.deepseek).toBeNull();
    expect(config.provider_strategies?.default).not.toHaveProperty('ignored');
    expect(logs).toEqual([]);
  });

  it('loadConfig(null) keeps env-only configuration while settings load DB overrides', async () => {
    const { host, settings } = await setup({
      settings: { 'web_search.engine': 'brave' },
      secrets: { 'web_search.api_key.brave': 'db-key' },
    });
    const port = host.ctx.get('webSearch') as unknown as CancellableWebSearchPort;
    const envOnly = await port.loadConfig(null);
    expect(envOnly.default_engine).toBe('bing_rss');
    expect(envOnly.keys.brave).toBeNull();
    const fromDb = await port.loadConfig(settings as unknown as SettingsStore);
    expect(fromDb.default_engine).toBe('brave');
    expect(fromDb.keys.brave).toBe('db-key');
  });

  it('doSearch terminates in-flight HTTP when the caller signal aborts', async () => {
    let received = 0;
    let closed = 0;
    const server: Server = createServer((request, response) => {
      received += 1;
      request.on('close', () => { closed += 1; });
      // Keep the response open: only the caller signal can settle this request.
      void response;
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const { host, settings } = await setup({ secrets: {
        'web_search.searxng.endpoint': `http://127.0.0.1:${address.port}/search`,
      } });
      const port = host.ctx.get('webSearch') as unknown as CancellableWebSearchPort;
      const config = await port.loadConfig(settings as unknown as SettingsStore);
      const controller = new AbortController();
      const pending = port.doSearch(config, {
        query: 'abort in flight', top_k: 1, engine: null, site: null,
        time_range: null, start: null, force_engine: 'searxng',
      }, controller.signal);
      await waitForCondition(() => received > 0);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await waitForCondition(() => closed > 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    }
  });
});

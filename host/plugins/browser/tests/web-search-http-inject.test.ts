import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { WebSearchFallback } from '../../llm/api.ts';
import type { CancellableWebSearchPort } from '../../mcp/api.ts';
import { resetProviderRuntime } from '../../mcp/src/web-search.ts';
import browser from '../index.ts';

const hosts: TestHost[] = [];

beforeEach(() => {
  resetProviderRuntime();
  for (const key of ['GOOGLE_API_KEY', 'GOOGLE_CSE_CX', 'GOOGLE_CSE_ENDPOINT']) {
    vi.stubEnv(key, '');
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setupWithHttp(options: {
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
  httpFetch: (input: string | URL, init?: Record<string, unknown>) => Promise<Response>;
}) {
  const values = new Map(Object.entries(options.settings ?? {}));
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const host = await createTestHost({
    plugins: [browser],
    provide: {
      settings: {
        get: (key: string) => values.get(key) ?? null,
        save: (key: string, value: string) => { values.set(key, value); },
        delete: (key: string) => values.delete(key),
        listByPrefix: () => [],
        deleteByPrefix: () => 0,
        getSecret: async (key: string) => secrets.get(key) ?? null,
        saveSecret: async (key: string, value: string) => { secrets.set(key, value); },
        deleteSecret: async (key: string) => secrets.delete(key),
      },
      http: { fetch: options.httpFetch },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
      featureFlags: { load: () => { throw new Error('unused'); }, save: () => undefined },
    },
  });
  hosts.push(host);
  return { host };
}

describe('dstu.browser optional http service routing & custom Google CSE endpoint', () => {
  it('routes webSearch.doSearch, llmWebSearchFallback, and test_search_engine through ctx.http.fetch', async () => {
    const globalFetchSpy = vi.fn(async () => {
      throw new Error('global fetch should not be called when ctx.http is provided');
    });
    vi.stubGlobal('fetch', globalFetchSpy);

    const httpCalls: string[] = [];
    const httpFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      httpCalls.push(url);
      if (url.startsWith('https://cse-proxy.example.test/v1')) {
        return Response.json({
          items: [{ title: 'Proxy CSE Result', link: 'https://docs.example.test/cse', snippet: 'Custom Google CSE proxy response' }],
        });
      }
      return new Response(
        '<?xml version="1.0"?><rss><channel><item><title>AI artificial intelligence guide</title><link>https://ai.example.test/1</link><description>Overview of AI artificial intelligence</description></item></channel></rss>',
        { status: 200 },
      );
    });

    const { host } = await setupWithHttp({
      settings: {
        'session.selected_search_engines': 'google_cse',
        'web_search.provider_strategies': JSON.stringify({ default: { cache_enabled: false, max_retries: 1 } }),
      },
      secrets: {
        'web_search.api_key.google_cse': 'gkey-1',
        'web_search.google_cse.cx': 'gcx-1',
        'web_search.google_cse.endpoint': 'https://cse-proxy.example.test/v1',
      },
      httpFetch,
    });

    const testResult = await host.invoke('test_search_engine', { engine: 'google_cse' }) as { ok: boolean };
    expect(testResult.ok).toBe(true);
    expect(httpCalls[0]).toContain('https://cse-proxy.example.test/v1?');
    expect(httpCalls[0]).toContain('key=gkey-1');
    expect(httpCalls[0]).toContain('cx=gcx-1');

    const fallback = host.ctx.get('llmWebSearchFallback') as WebSearchFallback;
    const fbResult = await fallback.call({
      window: null,
      streamEvent: 'chat',
      memoryEnabled: false,
      args: { query: 'custom cse test', top_k: 2 },
    });
    expect(fbResult.ok).toBe(true);
    expect((fbResult.citations?.[0] as { documentId?: string } | undefined)?.documentId).toBe('https://docs.example.test/cse');

    const port = host.ctx.get('webSearch') as CancellableWebSearchPort;
    const config = await port.loadConfig(host.ctx.settings);
    const searchRes = await port.doSearch(config, {
      query: 'AI artificial intelligence',
      top_k: 2,
      engine: 'bing_rss',
      site: null,
      time_range: null,
      start: null,
      force_engine: null,
    }, new AbortController().signal);
    expect(searchRes.ok).toBe(true);
    expect(httpCalls.length).toBeGreaterThanOrEqual(3);
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });
});

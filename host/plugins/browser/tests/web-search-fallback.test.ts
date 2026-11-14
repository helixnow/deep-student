import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { WebSearchFallback } from '../../llm/api.ts';
import browser from '../index.ts';

/**
 * dstu-mcp tools/mod.rs:653-700 `call_web_search_fallback` + `WebSearchTool::invoke` (db present,
 * stage "fallback") + `do_aggregated_search` (mod.rs:1166-1383), reached through the service llm reads.
 */
const hosts: TestHost[] = [];
const SEARXNG = 'https://searx.test';
const WINDOW = { window: 'main', webview: 'main' };
const STRATEGIES = JSON.stringify({ default: { cache_enabled: false, max_retries: 1, timeout_ms: 30_000 } });

async function setup(settings: Record<string, string>, secrets: Record<string, string> = {}) {
  const values = new Map(Object.entries({ 'web_search.provider_strategies': STRATEGIES, ...settings }));
  const secretValues = new Map(Object.entries(secrets));
  const host = await createTestHost({
    plugins: [browser], provide: {
      settings: {
        get: (key: string) => values.get(key) ?? null,
        save: (key: string, value: string) => { values.set(key, value); },
        getSecret: async (key: string) => secretValues.get(key) ?? null,
      },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
      featureFlags: { load: () => { throw new Error('feature flags are not read by web search'); } },
    },
  });
  hosts.push(host);
  const fallback = host.ctx.get('llmWebSearchFallback') as WebSearchFallback | undefined;
  if (fallback === undefined) throw new Error('llmWebSearchFallback is not provided');
  return { host, fallback };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
type Result = { title: string; url: string; content: string };
function stubSearch(searxng: Result[] | number, tavily: Result[] | number = 500) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const reply = url.startsWith(`${SEARXNG}/search?`) ? searxng
      : url === 'https://api.tavily.com/search' ? tavily : null;
    if (reply === null) throw new Error(`unexpected fetch ${url}`);
    return typeof reply === 'number' ? json({ error: 'bad request' }, reply) : json({ results: reply });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const call = (fallback: WebSearchFallback, query: string, window: typeof WINDOW | null = WINDOW) =>
  fallback.call({ window, streamEvent: 'chat_v2_event_fb', memoryEnabled: null, args: { query, top_k: 3 } });

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

describe('llmWebSearchFallback (tools/mod.rs:653-700)', () => {
  it('is provided by the browser plugin and declared in its manifest', async () => {
    expect(browser.meta.provides).toContain('llmWebSearchFallback');
    const { fallback } = await setup({});
    expect(typeof fallback.call).toBe('function');
  });

  it('skips the search when no engine is selected or the selection is blank (mod.rs:826-845)', async () => {
    const fetchMock = stubSearch([{ title: 'never', url: 'https://never.test/', content: 'x' }]);
    for (const settings of [{}, { 'session.selected_search_engines': ' \t ' }] as Array<Record<string, string>>) {
      const { host, fallback } = await setup(settings, { 'web_search.searxng.endpoint': SEARXNG });
      expect(await call(fallback, 'gate')).toEqual({
        ok: false, error: '请在输入栏选择搜索引擎以启用外部搜索功能', citations: null, injectText: null,
      });
      expect(host.eventsNamed('chat_v2_event_fb_web_search')).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searches the single selected engine, injects its text and emits fallback-stage sources', async () => {
    const fetchMock = stubSearch([
      { title: 'First', url: 'https://a.example/1?utm_source=x', content: 'alpha' },
      { title: 'Second', url: 'https://b.example/2', content: 'beta' },
    ]);
    const { host, fallback } = await setup({ 'session.selected_search_engines': ' searxng ' },
      { 'web_search.searxng.endpoint': SEARXNG });
    const result = await call(fallback, 'single engine');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, error: null });
    expect(result.injectText).toBe('【外部搜索结果】\n[1] First — alpha\nURL: https://a.example/1\n\n'
      + '[2] Second — beta\nURL: https://b.example/2\n\n');
    expect(result.citations).toHaveLength(2);
    expect(host.eventsNamed('chat_v2_event_fb_web_search')).toEqual([{
      sources: [
        { document_id: 'https://a.example/1', file_name: 'First', chunk_text: 'First — alpha\nhttps://a.example/1',
          score: 1, chunk_index: 0, source_type: 'search', origin: 'web_search', stage: 'fallback' },
        // normalize_score(2, 3) is f32 in Rust and serializes as 0.6666667.
        { document_id: 'https://b.example/2', file_name: 'Second', chunk_text: 'Second — beta\nhttps://b.example/2',
          score: 0.6666667, chunk_index: 1, source_type: 'search', origin: 'web_search', stage: 'fallback' },
      ],
      stage: 'fallback', tool_name: 'web_search',
    }]);
  });

  it('does not emit sources without a calling window (mod.rs:1123)', async () => {
    stubSearch([{ title: 'Only', url: 'https://a.example/', content: 'alpha' }]);
    const { host, fallback } = await setup({ 'session.selected_search_engines': 'searxng' },
      { 'web_search.searxng.endpoint': SEARXNG });
    expect(await call(fallback, 'headless', null)).toMatchObject({ ok: true });
    expect(host.eventsNamed('chat_v2_event_fb_web_search')).toEqual([]);
  });

  it('uses the only selected engine that has a key when several are selected (mod.rs:885-891)', async () => {
    const fetchMock = stubSearch([{ title: 'Keyed', url: 'https://a.example/', content: 'alpha' }]);
    const { fallback } = await setup({ 'session.selected_search_engines': 'serpapi,searxng,brave' },
      { 'web_search.searxng.endpoint': SEARXNG });
    const result = await call(fallback, 'one usable');
    expect(result).toMatchObject({ ok: true, injectText: '【外部搜索结果】\n[1] Keyed — alpha\nURL: https://a.example/\n\n' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aggregates every usable engine: dedupe by URL, stable score sort, top_k cut, rescored citations', async () => {
    stubSearch(
      [
        { title: 'A', url: 'https://a.example/', content: 'from searx' },
        { title: 'Shared', url: 'https://shared.example/', content: 'searx copy' },
        { title: 'C', url: 'https://c.example/', content: 'third' },
      ],
      [
        { title: 'Shared again', url: 'https://shared.example/?utm_medium=t', content: 'tavily copy' },
        { title: 'D', url: 'https://d.example/', content: 'tavily second' },
      ],
    );
    const { host, fallback } = await setup({ 'session.selected_search_engines': 'searxng,tavily' },
      { 'web_search.searxng.endpoint': SEARXNG, 'web_search.api_key.tavily': 'tvly-key' });
    const result = await call(fallback, 'aggregate');
    expect(result.ok).toBe(true);
    // Items are rebuilt from per-engine citations, so the snippet is the first two chunk lines joined by a space.
    expect(result.injectText).toBe('【外部搜索结果】\n'
      + '[1] A — A — from searx https://a.example/\nURL: https://a.example/\n\n'
      + '[2] Shared — Shared — searx copy https://shared.example/\nURL: https://shared.example/\n\n'
      + '[3] D — D — tavily second https://d.example/\nURL: https://d.example/\n\n');
    const [event] = host.eventsNamed('chat_v2_event_fb_web_search') as { sources: Record<string, unknown>[] }[];
    expect(event!.sources.map(source => [source.document_id, source.score, source.chunk_index])).toEqual([
      ['https://a.example/', 1, 0], ['https://shared.example/', 0.6666667, 1], ['https://d.example/', 0.33333334, 2],
    ]);
    expect(event!.sources[1]!.chunk_text).toBe('Shared — Shared — searx copy https://shared.example/\nhttps://shared.example/');
  });

  it('drops URLs without a host when the CN whitelist is enabled during aggregation (mod.rs:1262-1278)', async () => {
    stubSearch(
      [{ title: 'Edu', url: 'https://www.pku.edu.cn/', content: 'kept' }, { title: 'Opaque', url: 'mailto:x@pku.edu.cn', content: 'no host' }],
      [{ title: 'Tavily', url: 'https://www.tsinghua.edu.cn/', content: 'kept too' }],
    );
    const { fallback } = await setup({
      'session.selected_search_engines': 'searxng,tavily',
      'web_search.cn_whitelist.enabled': 'true',
    }, { 'web_search.searxng.endpoint': SEARXNG, 'web_search.api_key.tavily': 'tvly-key' });
    const result = await call(fallback, 'whitelist');
    expect(result.citations?.map(citation => (citation as { documentId: string }).documentId))
      .toEqual(['https://www.pku.edu.cn/', 'https://www.tsinghua.edu.cn/']);
  });

  it('reports the aggregated failure as "web_search error" when every engine fails (mod.rs:1236-1253, 1083-1101)', async () => {
    stubSearch(400, 400);
    const { host, fallback } = await setup({ 'session.selected_search_engines': 'searxng,tavily' },
      { 'web_search.searxng.endpoint': SEARXNG, 'web_search.api_key.tavily': 'tvly-key' });
    expect(await call(fallback, 'all fail')).toEqual({ ok: false, error: 'web_search error', citations: null, injectText: null });
    expect(host.eventsNamed('chat_v2_event_fb_web_search')).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type {
  CancellableWebSearchPort, JsonValue, RagSourceInfo, SearchInput, SearchResult, ToolContext, WebSearchService,
} from '../api.ts';
import { HostMcpService } from '../src/service.ts';
import { defaultToolConfig, type ToolConfig } from '../src/web-search.ts';
import browser from '../../browser/index.ts';
import mcp from '../index.ts';

const NO_ENGINE = '请在输入栏选择搜索引擎以启用外部搜索功能';
const WINDOW = { window: 'main', webview: 'main' };

function context(stage: string | null, extra: Partial<ToolContext> = {}): ToolContext {
  return { supports_tools: true, mcp_client: null, stream_event: null, stage, memory_enabled: null, ...extra };
}

function settingsOf(values: Map<string, string>): SettingsStore {
  return {
    get: (key: string) => values.get(key) ?? null,
    getSecret: async (key: string) => values.get(key) ?? null,
  } as unknown as SettingsStore;
}

interface Recorded { config: ToolConfig | null; input: SearchInput }

/** A browser-shaped `webSearch` provider: `doSearch(input, signal)` and `doSearch(config, input, signal)`. */
function fakePort(answer: (input: SearchInput) => Promise<SearchResult> | SearchResult, keys: Partial<ToolConfig['keys']> = {}) {
  const calls: Recorded[] = [];
  const config = defaultToolConfig();
  Object.assign(config.keys, keys);
  const port = {
    loadConfig: async () => structuredClone(config),
    doSearch: async (first: SearchInput | ToolConfig, second?: SearchInput | AbortSignal) => {
      const withConfig = second !== undefined && !('aborted' in second);
      const input = (withConfig ? second : first) as SearchInput;
      calls.push({ config: withConfig ? first as ToolConfig : null, input: structuredClone(input) });
      return answer(input);
    },
  } as unknown as WebSearchService & CancellableWebSearchPort;
  return { calls, port };
}

function okResult(input: SearchInput, citations: RagSourceInfo[] = []): SearchResult {
  return {
    name: 'web_search', ok: true, args: input,
    result: { raw: {}, provider: input.force_engine ?? input.engine ?? 'bing_rss' },
    citations, usage: { elapsed_ms: 1 }, inject_text: 'found',
  };
}

function serviceWith(values: Map<string, string>, port: WebSearchService & CancellableWebSearchPort,
  emitted: { event: string; payload: JsonValue }[] = []): HostMcpService {
  return new HostMcpService({
    log: () => undefined,
    namespacePrefix: () => null,
    webSearch: port,
    webSearchDb: { settings: settingsOf(values), port },
    emitEvent: (event, payload) => { emitted.push({ event, payload }); },
  });
}

const engines = (calls: Recorded[]) => calls.map(call => ({
  engine: call.input.engine, force_engine: call.input.force_engine, withConfig: call.config !== null,
}));

describe('WebSearchTool::invoke engine gate (dstu-mcp/src/tools/mod.rs:775-843)', () => {
  it('refuses a non-test call when session.selected_search_engines is unset, before any search', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map(), port);
    expect(await service.registry.callTool('web_search', { query: 'q' }, context('tool_call'))).toEqual([
      false, null, NO_ENGINE, { elapsed_ms: expect.any(Number) }, null, null,
    ]);
    expect(calls).toEqual([]);
  });

  it('refuses a non-test call when the selected engine list is blank', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map([['session.selected_search_engines', ' \t ']]), port);
    const result = await service.registry.callToolWithDetails('web_search', { query: 'q' }, context('fallback'));
    expect(result.slice(0, 3)).toEqual([false, null, NO_ENGINE]);
    expect(calls).toEqual([]);
  });

  it('refuses a model-chosen engine outside the selected list and reports the available engines', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map([['session.selected_search_engines', 'brave, tavily,brave,']]), port);
    expect(await service.registry.callTool('web_search', { query: 'q', engine: 'bing_rss' }, context('tool_call'))).toEqual([
      false, null, "引擎 'bing_rss' 不在允许列表中。可用引擎: brave, tavily。请到设置页配置相应API密钥。",
      { elapsed_ms: 0, available_engines: ['brave', 'tavily'] }, null, null,
    ]);
    expect(calls).toEqual([]);
  });

  it('skips both gates in test mode (stage = "test") and searches the default engine', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map(), port);
    const [ok] = await service.registry.callTool('web_search', { query: 'q', engine: 'brave' }, context('test'));
    expect(ok).toBe(true);
    expect(engines(calls)).toEqual([{ engine: null, force_engine: null, withConfig: true }]);
  });
});

describe('WebSearchTool::invoke engine routing (dstu-mcp/src/tools/mod.rs:854-928)', () => {
  it('uses the only selected engine when the model names none', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map([['session.selected_search_engines', 'searxng']]), port);
    await service.registry.callTool('web_search', { query: 'q' }, context('tool_call'));
    expect(engines(calls)).toEqual([{ engine: 'searxng', force_engine: null, withConfig: true }]);
  });

  it('drops a model-chosen engine without a key, then picks the single usable selected engine', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map([['session.selected_search_engines', 'bing_rss,brave']]), port);
    await service.registry.callTool('web_search', { query: 'q', engine: 'brave' }, context('tool_call'));
    expect(engines(calls)).toEqual([{ engine: 'bing_rss', force_engine: null, withConfig: true }]);
  });

  it('lets force_engine win over the selected list', async () => {
    const { calls, port } = fakePort(okResult, { searxng_endpoint: 'http://searxng.test' });
    const service = serviceWith(new Map([['session.selected_search_engines', 'bing_rss,searxng']]), port);
    await service.registry.callTool('web_search', { query: 'q', force_engine: 'tavily' }, context('test'));
    expect(engines(calls)).toEqual([{ engine: 'tavily', force_engine: 'tavily', withConfig: true }]);
  });

  it('falls back to the default engine when no selected engine has a key', async () => {
    const { calls, port } = fakePort(okResult);
    const service = serviceWith(new Map([['session.selected_search_engines', 'brave,tavily']]), port);
    await service.registry.callTool('web_search', { query: 'q' }, context('tool_call'));
    expect(engines(calls)).toEqual([{ engine: null, force_engine: null, withConfig: true }]);
  });

  it('keeps db: None (no settings) on the plain doSearch(input) path', async () => {
    const { calls, port } = fakePort(okResult);
    const service = new HostMcpService({ log: () => undefined, namespacePrefix: () => null, webSearch: port });
    await service.registry.callTool('web_search', { query: 'q' }, context('tool_call'));
    expect(engines(calls)).toEqual([{ engine: null, force_engine: null, withConfig: false }]);
  });
});

describe('WebSearchTool::do_aggregated_search (dstu-mcp/src/tools/mod.rs:1166-1383)', () => {
  const searxng: RagSourceInfo[] = [
    { documentId: 'https://shared.example/x', fileName: 'Shared', chunkText: 'Shared — from searxng\nhttps://shared.example/x', score: 1, chunkIndex: 0, sourceType: 'search' },
    { documentId: 'https://b.example/2', fileName: 'B', chunkText: 'B — second line\nhttps://b.example/2', score: 0.6666667, chunkIndex: 1, sourceType: 'search' },
  ];
  const deepseek: RagSourceInfo[] = [
    { documentId: 'https://a.example/1', fileName: 'A', chunkText: 'A — alpha\r\nhttps://a.example/1', score: 0.7, chunkIndex: 0, sourceType: 'search' },
    { documentId: 'https://shared.example/x', fileName: 'Shared DS', chunkText: 'Shared DS — dup\nhttps://shared.example/x', score: 0.3, chunkIndex: 1, sourceType: 'search' },
    { documentId: 'https://c.example/3', fileName: 'C', chunkText: 'C — gamma\nhttps://c.example/3', score: 0.2, chunkIndex: 2, sourceType: 'search' },
  ];

  it('searches every usable selected engine concurrently, dedupes, sorts by score and renormalizes in f32', async () => {
    const order: string[] = [];
    const { calls, port } = fakePort(async input => {
      order.push(`start ${input.engine}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push(`end ${input.engine}`);
      return okResult(input, input.engine === 'searxng' ? searxng : deepseek);
    }, { searxng_endpoint: 'http://searxng.test', deepseek: 'k' });
    const service = serviceWith(new Map([['session.selected_search_engines', 'searxng, deepseek, tavily']]), port);
    const [ok, data, error, usage, citations, inject] = await service.registry.callTool(
      'web_search', { query: 'q', top_k: 3 }, context('tool_call'));
    expect(engines(calls)).toEqual([
      { engine: 'searxng', force_engine: null, withConfig: true },
      { engine: 'deepseek', force_engine: null, withConfig: true },
    ]);
    expect(order.slice(0, 2)).toEqual(['start searxng', 'start deepseek']);
    expect([ok, error]).toEqual([true, null]);
    expect(data).toEqual({ aggregated: true, providers: { searxng: 2, deepseek: 3 }, failed_providers: [], total_unique_results: 3 });
    expect(usage).toEqual({
      elapsed_ms: expect.any(Number), reranking_time_ms: null,
      providers: { searxng: 2, deepseek: 3 }, failed_providers: [], aggregated: true,
    });
    expect(citations).toEqual([
      { documentId: 'https://shared.example/x', fileName: 'Shared', chunkIndex: 0, sourceType: 'search', score: 1,
        chunkText: 'Shared — Shared — from searxng https://shared.example/x\nhttps://shared.example/x' },
      { documentId: 'https://a.example/1', fileName: 'A', chunkIndex: 1, sourceType: 'search', score: 0.6666667,
        chunkText: 'A — A — alpha https://a.example/1\nhttps://a.example/1' },
      { documentId: 'https://b.example/2', fileName: 'B', chunkIndex: 2, sourceType: 'search', score: 0.33333334,
        chunkText: 'B — B — second line https://b.example/2\nhttps://b.example/2' },
    ]);
    expect(JSON.stringify(citations!.map(citation => citation.score))).toBe('[1,0.6666667,0.33333334]');
    expect(inject).toBe('【外部搜索结果】\n'
      + '[1] Shared — Shared — from searxng https://shared.example/x\nURL: https://shared.example/x\n\n'
      + '[2] A — A — alpha https://a.example/1\nURL: https://a.example/1\n\n'
      + '[3] B — B — second line https://b.example/2\nURL: https://b.example/2\n\n');
  });

  it('reports every failed engine when no aggregated engine returns results', async () => {
    const { port } = fakePort(input => ({
      name: 'web_search', ok: false, args: input, error: { message: `${input.engine} down` }, usage: { elapsed_ms: 1 },
    }), { searxng_endpoint: 'http://searxng.test', deepseek: 'k' });
    const service = serviceWith(new Map([['session.selected_search_engines', 'searxng,deepseek']]), port);
    expect(await service.registry.callTool('web_search', { query: 'q' }, context('tool_call'))).toEqual([
      false, null, 'web_search error',
      { elapsed_ms: expect.any(Number), failed_providers: ['searxng', 'deepseek'], aggregated: true }, null, null,
    ]);
  });
});

describe('{stream_event}_web_search source event (dstu-mcp/src/tools/mod.rs:1122-1150)', () => {
  it('is emitted only with a calling window, carrying the shortest f32 decimal score', async () => {
    const citation: RagSourceInfo = {
      documentId: 'https://a.example/1', fileName: 'A', chunkText: 'A', score: Math.fround(2 / 3), chunkIndex: 0,
    };
    const { port } = fakePort(input => okResult(input, [citation]));
    const emitted: { event: string; payload: JsonValue }[] = [];
    const service = serviceWith(new Map([['session.selected_search_engines', 'bing_rss']]), port, emitted);
    await service.registry.callTool('web_search', { query: 'q' }, context('fallback', { stream_event: 'chat' }));
    expect(emitted).toEqual([]);
    const [, , , , citations] = await service.registry.callTool('web_search', { query: 'q' },
      context('fallback', { stream_event: 'chat', window: WINDOW }));
    expect(citations![0]!.score).toBe(0.6666667);
    expect(emitted).toEqual([{ event: 'chat_web_search', payload: {
      sources: [{ document_id: 'https://a.example/1', file_name: 'A', chunk_text: 'A', score: 0.6666667,
        chunk_index: 0, source_type: 'search', origin: 'web_search', stage: 'fallback' }],
      stage: 'fallback', tool_name: 'web_search',
    } }]);
  });
});

describe('production wiring: real browser webSearch provider + dstu.mcp registry over HTTP', () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const host of hosts.splice(0)) await host.dispose();
  });

  it('aggregates DeepSeek and SearXNG for a tool_call when both selected engines have keys', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      requested.push(new URL(url).host);
      const body = url.startsWith('https://api.deepseek.com/')
        ? { results: [
          { url: 'https://a.example/1', title: 'A', snippet: 'alpha', rerank_score: 2.1 },
          { url: 'https://port.example:8443/p', title: '', snippet: 'ported', rerank_score: 0.3 },
        ] }
        : url.startsWith('http://searxng.test/')
          ? { results: [{ url: 'https://b.example/2?utm_source=feed', title: 'B', content: 'beta' }] }
          : null;
      return body === null ? new Response('unexpected', { status: 599 }) : Response.json(body);
    });
    const values = new Map<string, string>([
      ['session.selected_search_engines', 'deepseek,searxng'],
      ['web_search.api_key.deepseek', 'sk-test'],
      ['web_search.searxng.endpoint', 'http://searxng.test'],
      ['web_search.provider_strategies', JSON.stringify({ default: { cache_enabled: false, max_retries: 1 } })],
    ]);
    const host = await createTestHost({
      plugins: [browser, mcp],
      provide: {
        settings: { get: (key: string) => values.get(key) ?? null, getSecret: async (key: string) => values.get(key) ?? null },
        storage: {}, featureFlags: {}, llm: {},
        secrets: { openStore: () => ({ getSecret: async () => null }) },
        log: { logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
      },
    });
    hosts.push(host);
    const [ok, data, error, , citations, inject] = await host.ctx.mcp.registry.callTool(
      'web_search', { query: 'aggregate me', top_k: 3 }, context('tool_call'));
    expect([ok, error]).toEqual([true, null]);
    expect(requested.sort()).toEqual(['api.deepseek.com', 'searxng.test']);
    expect(data).toEqual({ aggregated: true, providers: { deepseek: 2, searxng: 1 }, failed_providers: [], total_unique_results: 3 });
    expect(citations!.map(citation => [citation.documentId, citation.fileName, citation.score])).toEqual([
      ['https://b.example/2', 'B', 1],
      ['https://a.example/1', 'A', 0.6666667],
      ['https://port.example:8443/p', 'port.example', 0.33333334],
    ]);
    expect(inject).toContain('[3] port.example — ');
  });
});

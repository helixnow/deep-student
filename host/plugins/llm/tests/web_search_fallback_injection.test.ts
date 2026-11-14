import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestHost } from './host.ts';
import llm from '../index.ts';
// boundary-allow cross-plugin-impl: V01-05 end to end; the fallback llm reads is provided by the real L19 browser plugin
import browser from '../../browser/index.ts';
import { llmReplayPlugin, type ReplayScript } from '../../llm-providers/api.ts';
import { makeConfig } from './support.ts';

/**
 * model2_pipeline.rs:5960-6090 + tools/mod.rs:653-700: a supports_tools=false model with web search on gets the
 * fallback web_search result injected into the provider request, and the UI receives fallback-stage sources.
 * The provider is the mounted llm-replay; only the SearXNG endpoint is a socket.
 */
let host: Awaited<ReturnType<typeof createTestHost>>;
let origin: string;
const searches: string[] = [];
const SCRIPTS = {
  answered: { description: 'one content chunk, [DONE]', rounds: [{ kind: 'sse', end: 'done', frames: [{ content: 'answered' }] }] },
} satisfies Record<string, ReplayScript>;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/search') { response.writeHead(404); response.end(); return; }
  searches.push(url.searchParams.get('q') ?? '');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ results: [{ title: 'Fallback Hit', url: 'https://news.example/1', content: 'fresh snippet' }] }));
});
const settings = new Map<string, string>([
  ['session.selected_search_engines', 'searxng'],
  ['web_search.provider_strategies', JSON.stringify({ default: { cache_enabled: false, max_retries: 1, timeout_ms: 30_000 } })],
]);
beforeAll(async () => {
  delete process.env.SEARXNG_ENDPOINT;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host = await createTestHost({ plugins: [llm, browser, [llmReplayPlugin, { scripts: SCRIPTS }]], provide: {
    settings: {
      get: (key: string) => settings.get(key) ?? null,
      save: (key: string, value: string) => { settings.set(key, value); },
      getSecret: async (key: string) => key === 'web_search.searxng.endpoint' ? origin : null,
      saveSecret: async () => {}, deleteSecret: async () => false,
    },
    secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    log: { logger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
      structured: { logLlmUsage: async () => {} } },
    storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
    featureFlags: { load: () => { throw new Error('feature flags not used'); } },
  } });
}, 120_000);
afterAll(async () => {
  await host.dispose();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('V01-05: a non-tool model with web search enabled gets the registered fallback injection', async () => {
  const replay = host.ctx.llmReplay;
  const config = makeConfig({ enabled: true, baseUrl: replay.baseUrl('answered'), model: 'no-tools-model',
    apiProtocol: 'openai_chat_completions', supportsTools: false });
  const output = await host.ctx.llmModel2Streaming.callUnifiedModel2StreamWithConfig(config, 0, {
    context: { web_search_enabled: true }, chatHistory: [{ role: 'user', content: '今天的新闻' }], subject: '',
    enableChainOfThought: false, enableThinking: false, taskContext: 'chat_v2', sink: { emit() {} },
    streamEvent: 'chat_v2_event_fallback', window: { window: 'main', webview: 'main' },
  });
  expect(output.assistant_message).toBe('answered');
  expect(searches).toEqual(['今天的新闻']);
  expect(replay.requests.map(entry => [entry.path, entry.outcome, entry.status, entry.end]))
    .toEqual([['/s/answered/v1/chat/completions', 'served', 200, 'done']]);
  const { messages } = replay.requests[0]!.body as { messages: { role: string; content: unknown }[] };
  const user = messages.findLast(message => message.role === 'user');
  expect(user?.content).toContain('【外部搜索结果】\n[1] Fallback Hit — fresh snippet\nURL: https://news.example/1');
  expect(host.eventsNamed('chat_v2_event_fallback_web_search')).toEqual([{
    sources: [{ document_id: 'https://news.example/1', file_name: 'Fallback Hit',
      chunk_text: 'Fallback Hit — fresh snippet\nhttps://news.example/1', score: 1, chunk_index: 0,
      source_type: 'search', origin: 'web_search', stage: 'fallback' }],
    stage: 'fallback', tool_name: 'web_search',
  }]);
});
